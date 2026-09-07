import type { Extracted, FieldKey, ParsedDoc } from '../types';
import { findEmails, findHsCodes } from '../normalize';

export interface Item { x: number; y: number; w: number; s: string }

/** A rectangle on the B/L form, in PDF user-space points (origin bottom-left). */
export interface Box { x0: number; x1: number; y0: number; y1: number }

/** A run of text on one baseline, bounded horizontally by a column gap. */
interface Segment { x0: number; x1: number; y: number; text: string }

/** Vertically adjacent segments that overlap horizontally — an address, a cargo list. */
export interface Block { x0: number; x1: number; y0: number; y1: number; lines: string[] }

type BoxName = FieldKey | 'preCarriage' | 'description' | 'containerSeal' | 'totalInWords';

/**
 * Box geometry for the standard 595x842pt B/L form this agent issues (the one
 * whose numbered boxes run 1.Shipper .. 29.Delivery Agent), calibrated against
 * the background template.
 *
 * These coordinates are a starting point, not a fixed truth: `calibrate` shifts
 * them to fit the page actually being read, so a re-issued template or a
 * different print margin does not misfile every value. Anything with an
 * unmistakable shape of its own (container numbers, weights, freight terms) is
 * *also* matched by regex over the whole page.
 */
export const BOXES: Record<BoxName, Box> = {
  soNo:              { x0: 400, x1: 580, y0: 745, y1: 800 },
  shipper:           { x0:  70, x1: 400, y0: 668, y1: 744 },
  consignee:         { x0:  70, x1: 400, y0: 588, y1: 667 },
  notifyParty:       { x0:  70, x1: 400, y0: 528, y1: 587 },
  preCarriage:       { x0:  70, x1: 198, y0: 504, y1: 527 },
  placeOfReceipt:    { x0: 198, x1: 400, y0: 504, y1: 527 },
  vesselVoyage:      { x0:  70, x1: 198, y0: 482, y1: 503 },
  portOfLoading:     { x0: 198, x1: 400, y0: 482, y1: 503 },
  portOfDischarge:   { x0:  70, x1: 228, y0: 459, y1: 481 },
  placeOfDelivery:   { x0: 228, x1: 390, y0: 459, y1: 481 },
  finalDestination:  { x0: 390, x1: 580, y0: 459, y1: 481 },
  marks:             { x0:  70, x1: 200, y0: 332, y1: 458 },
  description:       { x0: 200, x1: 390, y0: 332, y1: 458 },
  grossWeight:       { x0: 390, x1: 465, y0: 332, y1: 458 },
  measurement:       { x0: 465, x1: 580, y0: 332, y1: 458 },
  containerSeal:     { x0:  70, x1: 420, y0: 290, y1: 331 },
  totalInWords:      { x0:  70, x1: 580, y0: 250, y1: 289 },
  freightTerms:      { x0:  70, x1: 260, y0: 138, y1: 182 },
  // Fields never read from a box — matched by shape anywhere on the page.
  consigneeRegNo:    { x0: 0, x1: 0, y0: 0, y1: 0 },
  consigneePhone:    { x0: 0, x1: 0, y0: 0, y1: 0 },
  containerNo:       { x0: 0, x1: 0, y0: 0, y1: 0 },
  sealNo:            { x0: 0, x1: 0, y0: 0, y1: 0 },
  containerType:     { x0: 0, x1: 0, y0: 0, y1: 0 },
  packages:          { x0: 0, x1: 0, y0: 0, y1: 0 },
  goods:             { x0: 0, x1: 0, y0: 0, y1: 0 },
  hsCodes:           { x0: 0, x1: 0, y0: 0, y1: 0 },
};

/** Boxes that take part in geometric assignment (the ones with real rectangles). */
const PLACED = (Object.entries(BOXES) as [BoxName, Box][]).filter(([, b]) => b.x1 > b.x0);

const BASELINE_TOL = 3;   // items within this vertical distance share a baseline
const COL_GAP = 12;       // horizontal gap wide enough to mean a new column
const ROW_GAP = 13;       // vertical gap wide enough to mean a new block

/** Boilerplate that appears in the description cell but is not a commodity. */
const DESC_BOILERPLATE = [
  /SHIPPER'?S\s+LOAD/i, /COUNT\s*&?\s*SEAL/i, /S\.?T\.?C\.?/i, /SAID\s+TO\s+CONTAIN/i,
  /^\(?\d+\s*\*\s*\d+'?(GP|HQ|RF|NOR)?\)?\s*CONTAINERS?/i, /^N\/M$/i, /^NO\s+MARKS?$/i,
  /^\d[\d,]*\s*(CTNS?|CARTONS?|PKGS?|PACKAGES?|PLTS?|PALLETS?|BAGS?|ROLLS?|PCS)$/i,
  /FREIGHT\s+(PRE)?PAID/i, /FREIGHT\s+COLLECT/i,
];

/** Split each baseline into runs, breaking where a column gap appears. */
function toSegments(items: Item[]): Segment[] {
  const rows: Item[][] = [];
  for (const it of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows.find((r) => Math.abs(r[0].y - it.y) <= BASELINE_TOL);
    if (row) row.push(it);
    else rows.push([it]);
  }

  const make = (run: Item[]): Segment => {
    let text = '';
    let cursor = -Infinity;
    for (const it of run) {
      if (cursor > -Infinity && it.x - cursor > 2) text += ' ';
      text += it.s;
      cursor = it.x + it.w;
    }
    return {
      x0: run[0].x,
      x1: Math.max(...run.map((i) => i.x + i.w)),
      y: run[0].y,
      text: text.replace(/\s+/g, ' ').trim(),
    };
  };

  const segments: Segment[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    let run: Item[] = [row[0]];
    for (let i = 1; i < row.length; i++) {
      const prev = run[run.length - 1];
      if (row[i].x - (prev.x + prev.w) > COL_GAP) {
        segments.push(make(run));
        run = [row[i]];
      } else run.push(row[i]);
    }
    segments.push(make(run));
  }
  return segments.filter((s) => s.text);
}

/**
 * Merge segments that sit directly beneath one another into blocks. A consignee
 * address becomes one block, so it travels as a unit: adding a line or shifting
 * the page moves the whole block rather than stranding its first line in the
 * box above.
 */
export function toBlocks(items: Item[]): Block[] {
  const blocks: Block[] = [];
  for (const seg of toSegments(items).sort((a, b) => b.y - a.y)) {
    const host = blocks.find(
      (b) => b.y0 - seg.y <= ROW_GAP && b.y0 - seg.y >= -BASELINE_TOL
        && seg.x0 < b.x1 + COL_GAP && seg.x1 > b.x0 - COL_GAP,
    );
    if (host) {
      host.lines.push(seg.text);
      host.y0 = Math.min(host.y0, seg.y);
      host.x0 = Math.min(host.x0, seg.x0);
      host.x1 = Math.max(host.x1, seg.x1);
    } else {
      blocks.push({ x0: seg.x0, x1: seg.x1, y0: seg.y, y1: seg.y, lines: [seg.text] });
    }
  }
  return blocks;
}

const centre = (b: Block) => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });

function contains(box: Box, p: { x: number; y: number }, dx: number, dy: number): boolean {
  return p.x >= box.x0 + dx && p.x < box.x1 + dx && p.y >= box.y0 + dy && p.y < box.y1 + dy;
}

/** How far a point sits from the nearest edge of the box it is inside. */
function clearance(box: Box, p: { x: number; y: number }, dx: number, dy: number): number {
  return Math.min(p.x - (box.x0 + dx), (box.x1 + dx) - p.x, p.y - (box.y0 + dy), (box.y1 + dy) - p.y);
}

/**
 * Find the offset that best fits this page's boxes to its content. A B/L printed
 * from a revised template, or with a different margin, shifts every value by the
 * same amount; searching for that shift recovers the correct reading instead of
 * misfiling values into neighbouring boxes.
 *
 * Preference order: place the most blocks, then keep them furthest from box edges.
 */
export function calibrate(blocks: Block[]): { dx: number; dy: number } {
  let best = { dx: 0, dy: 0, placed: -1, clear: -Infinity };
  for (let dy = -40; dy <= 40; dy++) {
    for (let dx = -12; dx <= 12; dx += 3) {
      let placed = 0;
      let worst = Infinity;
      for (const block of blocks) {
        const p = centre(block);
        const box = PLACED.find(([, b]) => contains(b, p, dx, dy));
        if (!box) continue;
        placed++;
        worst = Math.min(worst, clearance(box[1], p, dx, dy));
      }
      if (!placed) continue;
      const better = placed > best.placed
        || (placed === best.placed && worst > best.clear)
        // Prefer the smaller correction when two offsets are equally good.
        || (placed === best.placed && worst === best.clear
            && Math.abs(dy) + Math.abs(dx) < Math.abs(best.dy) + Math.abs(best.dx));
      if (better) best = { dx, dy, placed, clear: worst };
    }
  }
  return { dx: best.dx, dy: best.dy };
}

/** Assign every block to a box, reporting any that belong to none. */
function assign(blocks: Block[], offset: { dx: number; dy: number }) {
  const byBox = new Map<BoxName, Block[]>();
  const orphans: Block[] = [];
  for (const block of blocks) {
    const p = centre(block);
    const hit = PLACED.find(([, b]) => contains(b, p, offset.dx, offset.dy));
    if (!hit) { orphans.push(block); continue; }
    const list = byBox.get(hit[0]) ?? [];
    list.push(block);
    byBox.set(hit[0], list);
  }
  const read = (name: BoxName): string =>
    (byBox.get(name) ?? [])
      .sort((a, b) => b.y1 - a.y1)
      .flatMap((b) => b.lines)
      .join('\n')
      .trim();
  return { read, orphans };
}

async function loadItems(bytes: Uint8Array): Promise<{ items: Item[]; pages: number }> {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: bytes, useSystemFonts: true, isEvalSupported: false }).promise;
  const items: Item[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    for (const raw of content.items as any[]) {
      if (!raw.str || !raw.str.trim()) continue;
      items.push({ x: raw.transform[4], y: raw.transform[5], w: raw.width ?? 0, s: raw.str });
    }
  }
  return { items, pages: doc.numPages };
}

/** Exported so drift can be simulated in tests without synthesising a PDF. */
export function extractFromItems(items: Item[], fileName: string, pages = 1): ParsedDoc {
  const warnings: string[] = [];
  const blocks = toBlocks(items);
  const fullText = blocks
    .sort((a, b) => b.y1 - a.y1)
    .flatMap((b) => b.lines)
    .join('\n');

  if (items.length === 0) {
    warnings.push(
      'This PDF has no text layer — it is probably a pure scan. Field extraction needs a text-based PDF (OCR it first).',
    );
  }
  if (pages > 1) warnings.push(`PDF has ${pages} pages; all pages were read as one form.`);

  const offset = calibrate(blocks);
  if (Math.abs(offset.dy) > 2 || Math.abs(offset.dx) > 2) {
    warnings.push(
      `This B/L sits ${offset.dx ? `${-offset.dx}pt across and ` : ''}${-offset.dy}pt down from the expected form layout; ` +
      'the boxes were realigned to fit. Check a few values against the PDF.',
    );
  }
  const { read, orphans } = assign(blocks, offset);

  // Anything that landed in no box at all is text this parser did not read. Say so
  // rather than dropping it silently — a missed value is worse than a noisy warning.
  if (orphans.length) {
    const shown = orphans.map((o) => JSON.stringify(o.lines.join(' ').slice(0, 40))).join(', ');
    warnings.push(`${orphans.length} block(s) on the B/L were not read into any field: ${shown}.`);
  }

  const fields: Partial<Record<FieldKey, Extracted>> = {};
  const put = (key: FieldKey, raw: string, where: string) => {
    const v = raw.trim();
    if (v) fields[key] = { raw: v, where };
  };

  put('soNo', read('soNo'), 'B/L S/O No.');
  put('shipper', read('shipper'), 'B/L box 1 (Shipper)');
  put('notifyParty', read('notifyParty'), 'B/L box 3 (Notify Party)');
  put('placeOfReceipt', read('placeOfReceipt'), 'B/L box 5 (Place of Receipt)');
  put('vesselVoyage', read('vesselVoyage'), 'B/L box 6 (Ocean Vessel / Voy No.)');
  put('portOfLoading', read('portOfLoading'), 'B/L box 7 (Port of Loading)');
  put('portOfDischarge', read('portOfDischarge'), 'B/L box 9 (Place of Discharge)');
  put('placeOfDelivery', read('placeOfDelivery'), 'B/L box 9 (Place of Delivery)');
  put('finalDestination', read('finalDestination'), 'B/L box 10 (Final Destination)');
  put('marks', read('marks'), 'B/L box 11 (Marks and Numbers)');

  // Consignee: the registration number and phone are separate fields, so lift
  // them out of the address block.
  const consigneeBlock = read('consignee');
  if (consigneeBlock) {
    const reg = consigneeBlock.match(/\(?\s*(\d{9,14})\s*\/\s*([A-Z]{1,3}\d{5,10}-?[A-Z]?)\s*\)?/);
    const phone = consigneeBlock.match(/(?:TEL|FAX|PHONE|HP)[^\n:：]*[:：][^\S\n]*([+\d][\d ()+\-]{6,})/i);
    const body = consigneeBlock
      .split('\n')
      .filter((l) => !(reg && l.includes(reg[0].trim())) && !/^(TEL|FAX|PHONE|HP)\b/i.test(l.trim()))
      .join('\n');
    put('consignee', body, 'B/L box 2 (Consignee)');
    if (reg) put('consigneeRegNo', `${reg[1]} / ${reg[2]}`, 'B/L box 2 (Consignee) — registration no.');
    if (phone) put('consigneePhone', phone[1], 'B/L box 2 (Consignee) — tel/fax');
  }

  put('grossWeight', read('grossWeight') || (fullText.match(/([\d,]+\.?\d*)\s*KGS?\b/i)?.[0] ?? ''), 'B/L box 14 (Gross Weight)');
  put('measurement', read('measurement') || (fullText.match(/([\d,]+\.?\d*)\s*CBM\b/i)?.[0] ?? ''), 'B/L box 15 (Measurement)');

  const descLines = read('description').split('\n').map((l) => l.trim()).filter(Boolean);
  const pkgLine =
    descLines.find((l) => /^\d[\d,]*\s*(CTNS?|CARTONS?|PKGS?|PACKAGES?|PLTS?|PALLETS?|BAGS?|ROLLS?|PCS)\b/i.test(l)) ??
    fullText.match(/\b\d[\d,]*\s*(?:CTNS?|CARTONS?|PKGS?|PACKAGES?|PLTS?|PALLETS?|BAGS?|ROLLS?|PCS)\b/i)?.[0] ??
    '';
  put('packages', pkgLine, 'B/L box 12 (No. of Packages)');
  put('goods', descLines.filter((l) => !DESC_BOILERPLATE.some((re) => re.test(l))).join(', '), 'B/L box 13 (Description of Goods)');

  // Matched by shape anywhere on the form, because agents put this line in the
  // marks column, the description column, or an attached rider.
  const containerNo = fullText.match(/\b([A-Z]{4}\d{7})\b/);
  if (containerNo) put('containerNo', containerNo[1], 'B/L container/seal line');
  const type = fullText.match(/\b(\d{2}'?\s?(?:GP|HQ|HC|RF|NOR|OT|FR)|\d{2}FT)\b/i);
  if (type) put('containerType', type[1].toUpperCase().replace(/\s/g, ''), 'B/L container/seal line');
  const sealLine = fullText.match(/[A-Z]{4}\d{7}\s*\/\s*[^/\n]*\/\s*([A-Z0-9-]{5,15})/);
  if (sealLine) put('sealNo', sealLine[1], 'B/L container/seal line');

  const freight = (read('freightTerms') + '\n' + fullText).match(/FREIGHT\s+(PREPAID|COLLECT|PAYABLE\s+AT\s+\w+)/i);
  if (freight) put('freightTerms', freight[0], 'B/L box 18 (Freight and Charges)');

  const hs = findHsCodes(fullText);
  if (hs.length) put('hsCodes', hs.join(', '), 'B/L (HS codes found in body text)');

  if (!fields.containerNo) warnings.push('No container number (4 letters + 7 digits) found on the B/L.');
  if (!fields.consignee) warnings.push('Consignee box read as empty — check the B/L layout matches the expected form.');

  return { kind: 'BL', format: 'pdf', fileName, fields, directives: [], text: fullText, emails: findEmails(fullText), warnings };
}

export async function parseBl(bytes: Uint8Array, fileName: string): Promise<ParsedDoc> {
  const { items, pages } = await loadItems(bytes);
  return extractFromItems(items, fileName, pages);
}

export { loadItems };
