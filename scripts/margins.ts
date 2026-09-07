/**
 * Reports how much slack each B/L box has around the value it holds.
 * Useful when calibrating BOXES for a new carrier's form: anything under about
 * one line height (7.8pt) is a box whose edge is close enough to matter.
 */
import { readFileSync } from 'node:fs';
import { loadItems, BOXES, type Item, type Box } from '../lib/extract/pdfBl.ts';

const file = process.argv[2] ?? 'fixtures/bl-sample.pdf';
const { items } = await loadItems(new Uint8Array(readFileSync(file)));

console.log(`${file}\n`);
console.log('box'.padEnd(18), ' left  right    top bottom   slack');
for (const [name, box] of Object.entries(BOXES) as [string, Box][]) {
  if (box.x1 <= box.x0) continue; // matched by shape, not position
  const inside = items.filter((i: Item) => i.x >= box.x0 && i.x < box.x1 && i.y >= box.y0 && i.y < box.y1);
  if (!inside.length) { console.log(name.padEnd(18), '  — empty —'); continue; }
  const left = Math.min(...inside.map((i) => i.x)) - box.x0;
  const right = box.x1 - Math.max(...inside.map((i) => i.x + i.w));
  const top = box.y1 - Math.max(...inside.map((i) => i.y));
  const bottom = Math.min(...inside.map((i) => i.y)) - box.y0;
  const slack = Math.min(left, right, top, bottom);
  console.log(
    name.padEnd(18),
    left.toFixed(1).padStart(5), right.toFixed(1).padStart(6),
    top.toFixed(1).padStart(6), bottom.toFixed(1).padStart(6),
    slack.toFixed(1).padStart(7), slack < 7.8 ? '  under one line' : '',
  );
}
