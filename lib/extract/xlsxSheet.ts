import type { Directive, Extracted, FieldKey, ParsedDoc } from '../types';
import { findEmails, findHsCodes } from '../normalize';
import { canonicalPort } from '../ports';
import { HS_WORDS, LABEL_ALIASES, SUPPRESS_MARKERS, isLabel, stripNotes } from './labels';

/** One populated cell, addressed by 1-based row and column. */
interface Cell { row: number; col: number; text: string }

/**
 * Read a workbook into unique cells. A merged range reports the same text from
 * every cell it covers, so only the top-left of each range is kept — otherwise
 * a heading spanning six columns would look like six separate labels.
 */
async function readCells(bytes: Uint8Array): Promise<{ cells: Cell[]; sheets: string[] }> {
  const ExcelJS: any = (await import('exceljs')).default ?? (await import('exceljs'));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(bytes));

  const cells: Cell[] = [];
  const sheets: string[] = [];
  wb.eachSheet((ws: any) => {
    sheets.push(ws.name);
    // Every cell covered by a merge except its master.
    const covered = new Set<string>();
    for (const range of (ws.model?.merges ?? []) as string[]) {
      const [from, to] = range.split(':');
      const parse = (a: string) => {
        const m = /^([A-Z]+)(\d+)$/.exec(a)!;
        let col = 0;
        for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
        return { col, row: Number(m[2]) };
      };
      const a = parse(from);
      const b = parse(to);
      for (let r = a.row; r <= b.row; r++) {
        for (let c = a.col; c <= b.col; c++) {
          if (r !== a.row || c !== a.col) covered.add(`${r}:${c}`);
        }
      }
    }
    ws.eachRow({ includeEmpty: false }, (row: any, r: number) => {
      row.eachCell({ includeEmpty: false }, (cell: any, c: number) => {
        if (covered.has(`${r}:${c}`)) return;
        const raw = typeof cell.text === 'string' ? cell.text : String(cell.value ?? '');
        const text = raw.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim();
        if (text) cells.push({ row: r, col: c, text });
      });
    });
  });
  return { cells, sheets };
}

/**
 * The value for a label is the cell beneath it, or failing that the cell to its
 * right — the two layouts every forwarder's confirmation sheet uses. A cell that
 * is itself a label is never taken as a value.
 */
function valueFor(label: Cell, cells: Cell[]): Cell | null {
  const below = cells
    .filter((c) => c.col === label.col && c.row > label.row)
    .sort((a, b) => a.row - b.row)[0];
  if (below && below.row - label.row <= 2 && !isLabel(below.text)) return below;

  const right = cells
    .filter((c) => c.row === label.row && c.col > label.col)
    .sort((a, b) => a.col - b.col)[0];
  if (right && !isLabel(right.text)) return right;

  return null;
}

export async function parseXlsx(bytes: Uint8Array, fileName: string): Promise<ParsedDoc> {
  const { cells, sheets } = await readCells(bytes);
  const warnings: string[] = [];
  const text = cells
    .slice()
    .sort((a, b) => a.row - b.row || a.col - b.col)
    .map((c) => c.text)
    .join('\n');

  if (sheets.length > 1) warnings.push(`Workbook has ${sheets.length} sheets (${sheets.join(', ')}); all were read as one form.`);
  if (!cells.length) warnings.push('This spreadsheet has no readable cells.');

  const fields: Partial<Record<FieldKey, Extracted>> = {};
  const put = (key: FieldKey, raw: string, where: string) => {
    const v = stripNotes(raw);
    if (v && !fields[key]) fields[key] = { raw: v, where };
  };

  // --- Labelled cells.
  for (const cell of cells) {
    for (const [key, re] of Object.entries(LABEL_ALIASES) as [FieldKey, RegExp][]) {
      if (!re.test(cell.text)) continue;
      // A heading cell is only ever a heading. Spreadsheet forms put the value in
      // its own cell, and these headings carry bilingual text ("Ocean Vessel(船名)
      // /Voy.No.(航次)") that would otherwise be mistaken for one.
      const value = valueFor(cell, cells)?.text ?? '';
      const label = cell.text.split('\n')[0].slice(0, 40);
      put(key, value, `${fileName} cell (${label})`);
      break;
    }
  }

  // --- Shapes, matched anywhere in the sheet.
  const grab = (re: RegExp, key: FieldKey, what: string) => {
    const m = text.match(re);
    if (m) put(key, m[0].trim(), `${fileName} (${what})`);
  };
  grab(/\b[\d,]+(?:\.\d+)?\s*KGS?\b/i, 'grossWeight', 'gross weight');
  grab(/\b[\d,]+(?:\.\d+)?\s*(?:CBM|M3)\b/i, 'measurement', 'measurement');
  grab(/\b\d[\d,]*\s*(?:CTNS?|CARTONS?|PKGS?|PACKAGES?|PLTS?|PALLETS?|BAGS?|ROLLS?|PCS)\b/i, 'packages', 'packages');
  grab(/\b[A-Z]{4}\d{7}\b/, 'containerNo', 'container no.');
  grab(/FREIGHT\s+(?:PREPAID|COLLECT)/i, 'freightTerms', 'freight terms');
  const type = text.match(/\b(\d{2}'?\s?(?:GP|HQ|HC|RF|NOR|OT|FR)|\d{2}FT)\b/i);
  if (type) put('containerType', type[1].toUpperCase().replace(/\s/g, ''), `${fileName} (container type)`);

  const reg = text.match(/\(?\s*(\d{9,14})\s*\/\s*([A-Z]{1,3}\d{5,10}-?[A-Z]?)\s*\)?/);
  if (reg) put('consigneeRegNo', `${reg[1]} / ${reg[2]}`, `${fileName} (registration no.)`);
  const phone = text.match(/(?:TEL|FAX|PHONE|HP)[^\n:：]*[:：][^\S\n]*([+\d][\d ()+\-]{6,})/i);
  if (phone) put('consigneePhone', phone[1].trim(), `${fileName} (tel/fax)`);

  // The consignee cell carries its own registration and phone lines.
  if (fields.consignee) {
    const cleaned = fields.consignee.raw
      .split('\n')
      .filter((l) => !/^(TEL|FAX|PHONE|HP)\b/i.test(l.trim()) && !(reg && l.includes(reg[0].trim())))
      .join('\n')
      .trim();
    if (cleaned) fields.consignee = { ...fields.consignee, raw: cleaned };
  }
  if (fields.notifyParty) {
    const cleaned = fields.notifyParty.raw
      .split('\n')
      .filter((l) => !/^(TEL|FAX|PHONE|HP)\b/i.test(l.trim()) && !(reg && l.includes(reg[0].trim())))
      .join('\n')
      .trim();
    if (cleaned) fields.notifyParty = { ...fields.notifyParty, raw: cleaned };
  }

  // Goods: commodity names here, HS codes held separately.
  if (fields.goods) {
    const codes = findHsCodes(fields.goods.raw);
    const names = fields.goods.raw
      .split('\n')
      .map((l) => l.replace(/\b\d{4}[\s.]?\d{2}[\s.]?\d{2}(?:[\s.]?\d{2})?\b/g, '').replace(/\s{2,}/g, ' ').trim())
      .filter(Boolean);
    fields.goods = { ...fields.goods, raw: names.join(', ') };
    if (codes.length) fields.hsCodes = { raw: codes.join(', '), where: fields.goods.where };
  }

  // --- Directives.
  const directives: Directive[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/[（(]([^）)]*)[）)]/g)) {
    const inner = m[1];
    if (!SUPPRESS_MARKERS.some((k) => inner.includes(k))) continue;
    // A confirmation sheet repeats the same note in the consignee and notify
    // cells; it is one instruction, not two.
    const key = inner.replace(/\s+/g, '').toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const where = `${fileName} (instruction)`;
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

  if (!fields.consignee) warnings.push(`${fileName}: no consignee cell found.`);
  const pod = fields.portOfDischarge ?? fields.finalDestination;
  if (!pod) warnings.push(`${fileName}: no discharge port or final destination found.`);
  else if (!canonicalPort(pod.raw)) warnings.push(`Port "${pod.raw}" is not in the alias table, so it is compared as plain text.`);

  return {
    kind: 'BL',
    format: 'xlsx',
    fileName,
    fields,
    directives,
    text,
    emails: findEmails(text),
    warnings,
  };
}
