/** Re-runs the full extractor under simulated layout drift. */
import { readFileSync } from 'node:fs';
import { loadItems, extractFromItems, toBlocks, calibrate, type Item } from '../lib/extract/pdfBl.ts';

const { items } = await loadItems(new Uint8Array(readFileSync('fixtures/bl-sample.pdf')));
const baseline = extractFromItems(items, 'bl.pdf');
const KEYS = ['shipper', 'consignee', 'notifyParty', 'placeOfReceipt', 'vesselVoyage', 'portOfLoading',
              'portOfDischarge', 'placeOfDelivery', 'finalDestination', 'grossWeight', 'measurement',
              'packages', 'goods', 'containerNo', 'sealNo', 'freightTerms'] as const;

function report(label: string, items: Item[]) {
  const got = extractFromItems(items, 'bl.pdf');
  const off = calibrate(toBlocks(items));
  const broken = KEYS.filter((k) => got.fields[k]?.raw !== baseline.fields[k]?.raw);
  const status = broken.length ? `${broken.length} field(s) changed: ${broken.join(', ')}` : 'all 16 fields identical';
  console.log(`${label.padEnd(46)} calibrated dy=${String(off.dy).padStart(3)}  ${status}`);
  for (const k of broken) {
    console.log(`      ${k}: ${JSON.stringify(baseline.fields[k]?.raw?.slice(0, 34) ?? null)} -> ${JSON.stringify(got.fields[k]?.raw?.slice(0, 34) ?? null)}`);
  }
}

console.log('--- whole form shifted (re-issued template, different print margin) ---');
for (const dy of [3, 6, 9, 12, 18, -6, -12]) {
  report(`shifted ${dy > 0 ? 'up' : 'down'} ${Math.abs(dy)}pt (${(Math.abs(dy) / 2.835).toFixed(1)}mm)`,
         items.map((i) => ({ ...i, y: i.y + dy })));
}

console.log('\n--- a longer consignee (the case that broke it before) ---');
const LINE = 7.8;
for (const extra of [1, 2, 3]) {
  const shifted = items.map((i) => (i.y >= 588 && i.y <= 667 && i.x < 400 ? { ...i, y: i.y + LINE * extra } : i));
  report(`consignee ${6 + extra} lines instead of 6`, shifted);
}

console.log('\n--- text where no box exists (should warn, not vanish) ---');
const stray = [...items, { x: 300, y: 220, w: 60, s: 'ON BOARD 15 AUG 2026' }];
const got = extractFromItems(stray, 'bl.pdf');
console.log('  warnings:', got.warnings);

console.log('\n--- where does it finally break? ---');
for (const dy of [24, 27, 30, 40, -24, -30]) {
  const shifted = items.map((i) => ({ ...i, y: i.y + dy }));
  const got = extractFromItems(shifted, 'bl.pdf');
  const broken = KEYS.filter((k) => got.fields[k]?.raw !== baseline.fields[k]?.raw);
  console.log(`shift ${String(dy).padStart(4)}pt -> ${broken.length ? broken.length + ' broken: ' + broken.join(', ') : 'clean'}; warnings=${got.warnings.length}`);
}
