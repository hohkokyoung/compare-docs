import type { Directive, Extracted, FieldKey, ParsedDoc } from '../types';
import { findEmails, findHsCodes } from '../normalize';
import { allPortAliases, canonicalPort } from '../ports';
import { HS_WORDS, LABEL_ALIASES, SUPPRESS_MARKERS, isLabel, stripNotes } from './labels';

const PORT_FIELDS: FieldKey[] = ['portOfDischarge', 'placeOfDelivery', 'finalDestination'];

interface Entry {
  /** Trimmed text of a non-blank line. */
  text: string;
  /** 1-based line number in the raw document. */
  lineNo: number;
  /** How many blank lines follow it. */
  gapAfter: number;
}

function toEntries(lines: string[]): Entry[] {
  const entries: Entry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim();
    if (!text) {
      if (entries.length) entries[entries.length - 1].gapAfter++;
      continue;
    }
    entries.push({ text, lineNo: i + 1, gapAfter: 0 });
  }
  return entries;
}

/**
 * Word documents are commonly double-spaced: each line of an address sits in its
 * own paragraph with an empty paragraph between. There, a single blank line is
 * mere spacing and only a run of two or more separates sections. Returns the
 * blank-run length that should be treated as a section break.
 */
export function blockBreakGap(entries: Entry[]): number {
  const gaps = entries.slice(0, -1).map((e) => e.gapAfter);
  if (gaps.length === 0) return 1;
  const singles = gaps.filter((g) => g === 1).length;
  const wider = gaps.filter((g) => g >= 2).length;
  return singles >= gaps.length * 0.5 && wider > 0 ? 2 : 1;
}

async function docxToText(bytes: Uint8Array): Promise<string> {
  const mammoth: any = await import('mammoth');
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  return String(value).replace(/\r\n?/g, '\n');
}

export async function parseSi(bytes: Uint8Array, fileName: string): Promise<ParsedDoc> {
  const text = await docxToText(bytes);
  const lines = text.split('\n');
  const warnings: string[] = [];
  const fields: Partial<Record<FieldKey, Extracted>> = {};
  const directives: Directive[] = [];

  const put = (key: FieldKey, raw: string, where: string) => {
    const v = stripNotes(raw);
    if (v && !fields[key]) fields[key] = { raw: v, where };
  };

  // --- Labelled blocks: "CONSIGNEE:" and the lines that belong to it.
  const entries = toEntries(lines);
  const breakGap = blockBreakGap(entries);

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    for (const [key, re] of Object.entries(LABEL_ALIASES) as [FieldKey, RegExp][]) {
      if (!re.test(entry.text)) continue;
      const block: string[] = [];
      const sameLine = entry.text.replace(re, '').replace(/^\s*[:：]\s*/, '').trim();
      if (sameLine) block.push(sameLine);
      for (let j = i; j < entries.length; j++) {
        if (entries[j].gapAfter >= breakGap) break;
        const next = entries[j + 1];
        if (!next || isLabel(next.text)) break;
        block.push(next.text);
      }
      put(key, block.join('\n'), `SI line ${entry.lineNo} (${entry.text.split(/[:：]/)[0].trim()})`);
      break;
    }
  }

  // --- Bare port lines. An SI often just says "NORTH PORT" with no label; that is
  // the discharge port, and on a port-to-port B/L the delivery and destination too.
  if (!fields.portOfDischarge) {
    const aliasSet = new Set(allPortAliases().map((a) => a.toUpperCase().replace(/[^A-Z0-9]/g, '')));
    for (const entry of entries) {
      if (entry.text.length > 40) continue;
      if (!aliasSet.has(entry.text.toUpperCase().replace(/[^A-Z0-9]/g, ''))) continue;
      const where = `SI line ${entry.lineNo} (unlabelled port)`;
      for (const key of PORT_FIELDS) if (!fields[key]) fields[key] = { raw: entry.text, where };
      break;
    }
  }

  // --- Quantities and identifiers. These have unmistakable shapes, so scan the
  // whole document rather than relying on a label being present.
  const grab = (re: RegExp, key: FieldKey, label: string) => {
    const m = text.match(re);
    if (!m) return;
    const lineNo = text.slice(0, m.index ?? 0).split('\n').length;
    put(key, m[0].trim(), `SI line ${lineNo} (${label})`);
  };
  grab(/\b[\d,]+(?:\.\d+)?\s*KGS?\b/i, 'grossWeight', 'gross weight');
  grab(/\b[\d,]+(?:\.\d+)?\s*(?:CBM|M3)\b/i, 'measurement', 'measurement');
  grab(/\b\d[\d,]*\s*(?:CTNS?|CARTONS?|PKGS?|PACKAGES?|PLTS?|PALLETS?|BAGS?|ROLLS?|PCS)\b/i, 'packages', 'packages');
  grab(/\b[A-Z]{4}\d{7}\b/, 'containerNo', 'container no.');
  grab(/FREIGHT\s+(?:PREPAID|COLLECT)/i, 'freightTerms', 'freight terms');

  const reg = text.match(/\(?\s*(\d{9,14})\s*\/\s*([A-Z]{1,3}\d{5,10}-?[A-Z]?)\s*\)?/);
  if (reg) put('consigneeRegNo', `${reg[1]} / ${reg[2]}`, 'SI consignee block (registration no.)');
  const phone = text.match(/(?:TEL|FAX|PHONE|HP)[^\n:：]*[:：][^\S\n]*([+\d][\d ()+\-]{6,})/i);
  if (phone) put('consigneePhone', phone[1].trim(), 'SI consignee block (tel/fax)');

  // The consignee block carries its own reg-no and phone lines; those are compared
  // as their own fields, so remove them from the name/address text.
  if (fields.consignee) {
    const cleaned = fields.consignee.raw
      .split('\n')
      .filter((l) => !/^(TEL|FAX|PHONE|HP)\b/i.test(l.trim()) && !(reg && l.includes(reg[0].trim())))
      .join('\n')
      .trim();
    if (cleaned) fields.consignee = { ...fields.consignee, raw: cleaned };
  }

  // Goods: keep the commodity names, hold the HS codes separately.
  if (fields.goods) {
    const codes = findHsCodes(fields.goods.raw);
    const names = fields.goods.raw
      .split('\n')
      .map((l) => l.replace(/\b\d{4}[\s.]?\d{2}[\s.]?\d{2}(?:[\s.]?\d{2})?\b/g, '').replace(/\s{2,}/g, ' ').trim())
      .filter(Boolean);
    fields.goods = { ...fields.goods, raw: names.join(', ') };
    if (codes.length) fields.hsCodes = { raw: codes.join(', '), where: fields.goods.where };
  }

  // --- Directives: parentheticals telling the agent to withhold something.
  for (const m of text.matchAll(/[（(]([^）)]*)[）)]/g)) {
    const inner = m[1];
    if (!SUPPRESS_MARKERS.some((k) => inner.includes(k))) continue;
    const where = `SI line ${text.slice(0, m.index ?? 0).split('\n').length}`;
    const emails = findEmails(inner);
    if (emails.length) {
      directives.push({
        id: `no-email-${directives.length}`,
        raw: m[0],
        meaning: `Do not show the email address ${emails[0]} on the B/L.`,
        forbid: { kind: 'email', value: emails[0] },
        where,
      });
    } else if (HS_WORDS.some((w) => inner.toUpperCase().includes(w.toUpperCase()))) {
      directives.push({
        id: `no-hs-${directives.length}`,
        raw: m[0],
        meaning: 'Do not print HS / customs codes on the B/L.',
        forbid: { kind: 'hsCodes' },
        where,
      });
    } else {
      directives.push({
        id: `suppress-${directives.length}`,
        raw: m[0],
        meaning: 'An instruction to keep something off the B/L, not understood automatically.',
        forbid: { kind: 'literal' },
        where,
      });
    }
  }

  if (!fields.consignee) warnings.push('No CONSIGNEE block found in the SI.');
  if (!fields.portOfDischarge) {
    warnings.push('No discharge port found in the SI — no label, and no line matching a known port name.');
  } else if (!canonicalPort(fields.portOfDischarge.raw)) {
    warnings.push(`Port "${fields.portOfDischarge.raw}" is not in the alias table, so it is compared as plain text.`);
  }

  return { kind: 'SI', format: 'docx', fileName, fields, directives, text, emails: findEmails(text), warnings };
}
