import type { Directive, Extracted, FieldKey, ParsedDoc } from '../types';
import { findEmails, findHsCodes } from '../normalize';
import { canonicalPort } from '../ports';
import { HS_WORDS, LABEL_ALIASES, SUPPRESS_MARKERS, isLabel, stripLabel, stripNotes } from './labels';
import { implausible } from './validate';

/** One text region recognised on the page, in pixels from the top-left. */
interface Region { x: number; y: number; w: number; h: number; text: string; confidence: number }

/** Regions sharing a baseline, left to right. */
type Line = Region[];

/** Printed forms number their boxes: "2.Products consigned to(...)". */
function withoutBoxNumber(text: string): string {
  return text.replace(/^\s*\d{1,2}\s*[.、]\s*/, '');
}

/** A numbered box heading is never a value, even when it is not a known label. */
function isHeading(text: string): boolean {
  return /^\s*\d{1,2}\s*[.、]\s*\S/.test(text) || isLabel(withoutBoxNumber(text));
}

/**
 * A value sits hard against its label. Anything separated by more than this much
 * of the page width belongs to the next column of the form — on a Form E the
 * shipper box and the reference number share a line but not a meaning.
 */
const COLUMN_GAP = 0.04;

/**
 * Photographs and scans have no text layer, so the words have to be recognised.
 * PaddleOCR (PP-OCRv6) runs locally through ONNX: the models are ~6 MB, cached
 * on first use, and nothing is sent anywhere afterwards.
 *
 * Every value read this way is marked `source: 'ocr'`, because recognition adds
 * character-level noise that a native file never has.
 */
/**
 * Estimate how far the page is rotated, by projection profile.
 *
 * Ink is projected onto a set of horizontal bands at each candidate angle. When
 * the angle matches the page's tilt, every text line falls into one band and the
 * profile is spiky; when it does not, lines smear across bands. The angle whose
 * profile has the greatest energy is the page's rotation.
 *
 * This runs on the pixels rather than on recognised boxes: the recogniser groups
 * regions across the form's columns, so their vertical spread reflects the
 * layout, not the tilt.
 */
export async function estimateSkew(bytes: Uint8Array): Promise<number> {
  const sharp = (await import('sharp')).default;
  const { data, info } = await sharp(bytes)
    .greyscale()
    .resize({ width: 500, withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  let total = 0;
  for (let i = 0; i < data.length; i++) total += data[i];
  const threshold = total / data.length - 25;

  const ink: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[y * width + x] < threshold) ink.push(x, y);
    }
  }
  if (ink.length < 4000) return 0; // too little ink to judge

  let best = 0;
  let bestScore = -1;
  for (let degrees = -8; degrees <= 8; degrees += 0.25) {
    const slope = Math.tan((degrees * Math.PI) / 180);
    const offset = Math.ceil(Math.abs(slope) * width) + 1;
    const bands = new Float64Array(height + offset * 2);
    for (let i = 0; i < ink.length; i += 2) {
      const band = Math.round(ink[i + 1] - ink[i] * slope) + offset;
      if (band >= 0 && band < bands.length) bands[band]++;
    }
    let score = 0;
    for (let i = 0; i < bands.length; i++) score += bands[i] * bands[i];
    if (score > bestScore) { bestScore = score; best = degrees; }
  }
  return best;
}

async function recognise(bytes: Uint8Array): Promise<{ lines: Line[]; confidence: number }> {
  const { PaddleOcrService } = await import('ppu-paddle-ocr');
  const service = new PaddleOcrService();
  await service.initialize();
  try {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const result: any = await service.recognize(buffer);
    const lines: Line[] = (result.lines ?? []).map((line: any[]) =>
      line.map((r) => ({
        x: r.box?.x ?? 0, y: r.box?.y ?? 0, w: r.box?.width ?? 0, h: r.box?.height ?? 0,
        text: String(r.text ?? '').trim(), confidence: r.confidence ?? 0,
      })).filter((r: Region) => r.text),
    ).filter((l: Line) => l.length);
    return { lines, confidence: result.confidence ?? 0 };
  } finally {
    await service.destroy();
  }
}

/**
 * The value for a label is what sits to its right on the same line, or failing
 * that the lines directly beneath it in the same column. A region that is itself
 * a label is never taken as a value.
 */
function valueFor(label: Region, line: Line, lines: Line[], lineIndex: number, pageWidth: number): string {
  const right: Region[] = [];
  let edge = label.x + label.w;
  for (const r of line.filter((r) => r.x > label.x).sort((a, b) => a.x - b.x)) {
    if (r.x - edge > pageWidth * COLUMN_GAP) break; // next column of the form
    if (isHeading(r.text)) break;
    right.push(r);
    edge = r.x + r.w;
  }
  if (right.length) return right.map((r) => r.text).join(' ');

  // A header row spans the table's columns; the values beneath it belong to data
  // rows that cannot be paired with a heading by position alone.
  if (line.filter((r) => isHeading(r.text)).length >= 3) return '';

  // Otherwise take following lines that start within the label's column.
  const out: string[] = [];
  const leftEdge = label.x;
  for (let i = lineIndex + 1; i < Math.min(lines.length, lineIndex + 6); i++) {
    const below = lines[i].filter((r) => Math.abs(r.x - leftEdge) < Math.max(60, label.w));
    if (!below.length) break;
    if (below.some((r) => isHeading(r.text))) break;
    const joined = below.map((r) => r.text).join(' ');
    // Values on these forms are typed in capitals; an all-lowercase fragment is
    // the tail of the printed heading, not data.
    if (!out.length && !/[A-Z0-9]{2}/.test(joined)) continue;
    out.push(joined);
  }
  return out.join('\n');
}

/**
 * Add up the per-item weights a certificate lists instead of a single total —
 * but only when every item was read. If the page yields four commodities and
 * three weights, one was missed, and a total that is short by one line item is
 * far worse than no total at all: it looks like a discrepancy against the B/L.
 */
function sumWeights(text: string, itemCount: number): { total: string; parts: string[] } | null {
  const parts = [...text.matchAll(/([\d,]+(?:\.\d+)?)\s*KGS/gi)].map((m) => m[1].replace(/,/g, ''));
  if (parts.length < 2 || itemCount < 2) return null;
  if (parts.length !== itemCount) return null;
  const total = parts.reduce((acc, p) => acc + Number(p), 0);
  if (!Number.isFinite(total)) return null;
  return { total: `${Math.round(total * 1000) / 1000} KGS`, parts };
}

/** Rotate the page upright and read it again when it is measurably tilted. */
async function recogniseUpright(bytes: Uint8Array): Promise<{
  lines: Line[]; confidence: number; correctedBy: number;
}> {
  const skew = await estimateSkew(bytes).catch(() => 0);
  const first = await recognise(bytes);
  if (Math.abs(skew) < 0.4) return { ...first, correctedBy: 0 };

  try {
    const sharp = (await import('sharp')).default;
    const straightened = await sharp(bytes)
      .rotate(-skew, { background: '#ffffff' })
      .jpeg({ quality: 95 })
      .toBuffer();
    const second = await recognise(new Uint8Array(straightened));
    // Keep the correction only if it actually read better.
    if (second.confidence >= first.confidence - 0.01 && second.lines.length >= first.lines.length * 0.8) {
      return { ...second, correctedBy: skew };
    }
  } catch {
    // Straightening is an improvement, not a requirement; fall back to the original.
  }
  return { ...first, correctedBy: 0 };
}

export async function parseImage(bytes: Uint8Array, fileName: string): Promise<ParsedDoc> {
  const { lines, confidence, correctedBy } = await recogniseUpright(bytes);
  const warnings: string[] = [];
  if (correctedBy) {
    warnings.push(`${fileName}: the page was tilted ${correctedBy.toFixed(1)}° and was straightened before reading.`);
  }
  const text = lines.map((l) => l.map((r) => r.text).join(' ')).join('\n');
  const pageWidth = Math.max(1, ...lines.flat().map((r) => r.x + r.w));

  if (!lines.length) {
    warnings.push(`${fileName}: no text could be recognised in this image.`);
  } else if (pageWidth < 500) {
    warnings.push(
      `${fileName}: the page is only ${Math.round(pageWidth)}px across, far too small to read reliably. ` +
      'Re-photograph it larger, or supply the source PDF or spreadsheet.',
    );
  } else if (pageWidth < 700) {
    warnings.push(
      `${fileName}: the page is only ${Math.round(pageWidth)}px across. Values may be misread — ` +
      'check them against the picture.',
    );
  } else if (confidence < 0.9) {
    warnings.push(
      `${fileName}: recognition confidence is ${(confidence * 100).toFixed(0)}%. ` +
      'Check the values against the picture, or supply the source PDF or spreadsheet instead.',
    );
  }

  const fields: Partial<Record<FieldKey, Extracted>> = {};
  const rejected: string[] = [];
  const put = (key: FieldKey, raw: string, what: string) => {
    const v = stripNotes(raw);
    if (!v || fields[key]) return;
    // Positional extraction on a photograph can land on the wrong thing. A value
    // that does not look like what it claims to be is dropped, not trusted.
    const reason = implausible(key, v);
    if (reason) {
      rejected.push(`${key} (${reason})`);
      return;
    }
    fields[key] = { raw: v, where: `${fileName} (${what})`, source: 'ocr' };
  };

  // --- Labelled regions.
  lines.forEach((line, i) => {
    for (const region of line) {
      for (const [key, re] of Object.entries(LABEL_ALIASES) as [FieldKey, RegExp][]) {
        const heading = withoutBoxNumber(region.text);
        if (!re.test(heading)) continue;
        // Prefer a neighbouring region. Only fall back to the remainder of the
        // heading itself, since headings carry trailing prose ("/ Aircraft etc.")
        // that reads like a value but is not one.
        const neighbour = valueFor(region, line, lines, i, pageWidth);
        const inline = stripLabel(heading, re).replace(/^[（(][^）)]*[）)]\s*/, '').trim();
        // Values on these forms are typed in capitals. A lowercase remainder is
        // the rest of the printed heading ("Marks and" -> "and"), never data.
        const usableInline = /[A-Z0-9]{2}/.test(inline) && !/^[\/(,.:;-]/.test(inline);
        const value = neighbour || (usableInline ? inline : '');
        put(key, value, region.text.slice(0, 34));
        break;
      }
    }
  });

  // --- Shapes, matched anywhere on the page.
  const grab = (re: RegExp, key: FieldKey, what: string) => {
    const m = text.match(re);
    if (m) put(key, m[0].trim(), what);
  };
  grab(/\b[A-Z]{4}\d{7}\b/, 'containerNo', 'container no.');
  grab(/\b[\d,]+(?:\.\d+)?\s*(?:CBM|M3)\b/i, 'measurement', 'measurement');
  grab(/FREIGHT\s+(?:PREPAID|COLLECT)/i, 'freightTerms', 'freight terms');
  const type = text.match(/\b(\d{2}'?\s?(?:GP|HQ|HC|RF|NOR|OT|FR)|\d{2}FT)\b/i);
  if (type) put('containerType', type[1].toUpperCase().replace(/\s/g, ''), 'container type');

  // A certificate states the grand total in words and figures.
  const total = text.match(/TOTAL[\s\S]{0,80}?\((\d[\d,]*)\)\s*(CARTONS?|CTNS?|PKGS?|PACKAGES?)/i);
  if (total) put('packages', `${total[1]} ${total[2].toUpperCase()}`, 'total line');
  else grab(/\b\d[\d,]*\s*(?:CTNS?|CARTONS?|PKGS?|PACKAGES?|PLTS?|PALLETS?|BAGS?|ROLLS?|PCS)\b/i, 'packages', 'packages');

  // Weight: a single figure if the form states one, otherwise the sum of the
  // per-item weights a certificate of origin lists line by line.
  // How many commodity lines the certificate has, used to check that the weights
  // add up over a complete set.
  const itemCount = Math.max(
    (text.match(/HS\s*CODE/gi) ?? []).length,
    [...text.matchAll(/\((\d[\d,]*)\)\s*CARTONS?/gi)].length - (total ? 1 : 0),
  );

  // Goods: commodity names follow "CARTONS OF ..." on a certificate.
  if (!fields.goods) {
    const names = [...text.matchAll(/CARTONS?\s*(?:OF)?([\s\S]{0,80}?)HS\s*CODE/gi)]
      .map((m) => m[1]
        .replace(/["“”'`*]/g, ' ')
        .replace(/\b(?:PE|WO|CC|PSR|RVC)\b/gi, ' ')           // origin criteria marks
        .replace(/[\d,]+(?:\.\d+)?\s*KGS[^\n]*/gi, ' ')     // weights and G.W.
        .replace(/\b[A-Z]{2}\d{6,}\b/g, ' ')                // invoice numbers
        .replace(/\b[A-Z]{3}\.?\s?\d{1,2},?\s?\d{4}\b/gi, ' ') // dates
        .replace(/\bG\.?\s*W\.?\b/gi, ' ')
        .replace(/\s+/g, ' ')
        // Whatever survives from the neighbouring columns is a stray letter or
        // two before the description proper.
        .replace(/^(?:\W|\b[A-Z]{1,2}\b)*(?:\bOF\b)?/i, '')
        .replace(/\s+/g, ' ')
        .trim())
      .filter((n) => n.length > 2)
      .filter((n, i, all) => all.indexOf(n) === i);
    if (names.length) put('goods', names.join(', '), 'item descriptions');
    // The same completeness check as the weights: a description list that is
    // short by one commodity would read as a discrepancy against the B/L.
    if (names.length && itemCount > 1 && names.length !== itemCount) {
      warnings.push(
        `${fileName}: ${itemCount} commodity lines are present but only ${names.length} could be read ` +
        `(${names.join(', ')}). Check the description against the document.`,
      );
    }
  }

  if (!fields.grossWeight) {
    const summed = total ? sumWeights(text, itemCount) : null;
    const single = text.match(/[\d,]+(?:\.\d+)?\s*KGS/i);
    if (summed) {
      put('grossWeight', summed.total, `summed from ${summed.parts.length} line items`);
      warnings.push(
        `${fileName}: no single gross weight is stated; ${summed.parts.join(' + ')} were added to give ${summed.total}.`,
      );
    } else if (total) {
      // Certificate-shaped: the weight is spread across line items. If they could
      // not all be read, report nothing — the first line item is not the total,
      // and reporting it would read as a discrepancy against the B/L.
      warnings.push(
        `${fileName}: the per-item weights could not be read as a complete set, so no gross weight is reported. ` +
        'Read it off the document, or supply the source file.',
      );
    } else if (single) put('grossWeight', single[0], 'gross weight');
  }


  const reg = text.match(/\(?\s*(\d{9,14})\s*\/\s*([A-Z]{1,3}\d{5,10}-?[A-Z]?)\s*\)?/);
  if (reg) put('consigneeRegNo', `${reg[1]} / ${reg[2]}`, 'registration no.');
  const phone = text.match(/(?:TEL|FAX|PHONE|HP)[^\n:：]*[:：][^\S\n]*([+\d][\d ()+\-]{6,})/i);
  if (phone) put('consigneePhone', phone[1].trim(), 'tel/fax');

  for (const key of ['consignee', 'notifyParty', 'shipper'] as FieldKey[]) {
    const held = fields[key];
    if (!held) continue;
    const cleaned = held.raw
      .split('\n')
      .filter((l) => !/^(TEL|FAX|PHONE|HP)\b/i.test(l.trim()) && !(reg && l.includes(reg[0].trim())))
      .join('\n')
      .trim();
    if (cleaned) fields[key] = { ...held, raw: cleaned };
  }

  const codes = findHsCodes(text);
  const six = [...text.matchAll(/HS\s*CODE\s*[:：]?\s*(\d{4})\.\s?(\d{2})/gi)].map((m) => `${m[1]}${m[2]}`);
  const allCodes = [...new Set([...codes, ...six])];
  if (allCodes.length) put('hsCodes', allCodes.join(', '), 'HS codes');

  // --- Directives.
  const directives: Directive[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/[（(]([^）)]*)[）)]/g)) {
    const inner = m[1];
    if (!SUPPRESS_MARKERS.some((k) => inner.includes(k))) continue;
    const key = inner.replace(/\s+/g, '').toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const emails = findEmails(inner);
    const where = `${fileName} (instruction)`;
    if (emails.length) {
      directives.push({ id: `no-email-${directives.length}`, raw: m[0], where,
        meaning: `Do not show the email address ${emails[0]} on the B/L.`, forbid: { kind: 'email', value: emails[0] } });
    } else if (HS_WORDS.some((w) => inner.toUpperCase().includes(w.toUpperCase()))) {
      directives.push({ id: `no-hs-${directives.length}`, raw: m[0], where,
        meaning: 'Do not print HS / customs codes on the B/L.', forbid: { kind: 'hsCodes' } });
    }
  }

  if (rejected.length) {
    warnings.push(`${fileName}: discarded implausible readings for ${rejected.join(', ')}.`);
  }
  if (!fields.consignee) warnings.push(`${fileName}: no consignee could be located.`);
  const pod = fields.portOfDischarge ?? fields.finalDestination ?? fields.placeOfDelivery;
  if (pod && !canonicalPort(pod.raw)) {
    warnings.push(`Port "${pod.raw}" is not in the alias table, so it is compared as plain text.`);
  }

  return {
    kind: 'BL', format: 'image', fileName, fields, directives, text,
    emails: findEmails(text), warnings,
  };
}
