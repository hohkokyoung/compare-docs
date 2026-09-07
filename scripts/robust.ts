/**
 * How far can a photograph degrade before extraction stops being trustworthy?
 *
 * Values are compared the way the comparison engine would, so cosmetic noise
 * ("920w" for "920W") does not count. What matters is the distinction between a
 * value that is absent (honest) and one that is wrong (dangerous), and whether a
 * wrong value came with a warning.
 */
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import type { Sharp } from 'sharp';
import { parseImage } from '../lib/extract/imageOcr.ts';
import { foldOcr, normalizeFor } from '../lib/normalize.ts';
import { FIELD_SPECS } from '../lib/fields.ts';
import type { FieldKey } from '../lib/types.ts';

const KEY: FieldKey[] = ['containerNo', 'packages', 'grossWeight', 'goods', 'vesselVoyage', 'portOfDischarge', 'consigneeRegNo'];
const spec = (k: FieldKey) => FIELD_SPECS.find((s) => s.key === k)?.comparator ?? 'text';
const base = await parseImage(new Uint8Array(readFileSync('fixtures/forme-sample.jpeg')), 'base.jpeg');
const baseWarnings = base.warnings.length;

async function probe(name: string, make: (s: Sharp) => Sharp) {
  const buf = await make(sharp('fixtures/forme-sample.jpeg')).jpeg({ quality: 90 }).toBuffer();
  const doc = await parseImage(new Uint8Array(buf), 'probe.jpeg');
  const warned = doc.warnings.length > baseWarnings;

  const right: FieldKey[] = [];
  const absent: FieldKey[] = [];
  const wrong: FieldKey[] = [];
  for (const k of KEY) {
    const want = base.fields[k]?.raw;
    const got = doc.fields[k]?.raw;
    if (!got) { absent.push(k); continue; }
    // Mirror the comparison engine: normalise, then fall back to folding the
    // letter/digit pairs OCR confuses, exactly as compareField does.
    const a = normalizeFor(spec(k), want ?? '');
    const b = normalizeFor(spec(k), got);
    if (a === b || foldOcr(want ?? '') === foldOcr(got)) right.push(k);
    else wrong.push(k);
  }
  const verdict = wrong.length === 0 ? 'safe' : warned ? 'wrong, but warned' : 'WRONG AND SILENT';
  console.log(
    `${name.padEnd(24)} ${String(right.length).padStart(2)} right  ${String(absent.length).padStart(2)} absent  ` +
    `${String(wrong.length).padStart(2)} wrong   ${verdict}`,
  );
  if (wrong.length) console.log(`      wrong: ${wrong.map((k) => `${k}=${JSON.stringify(doc.fields[k]!.raw.slice(0, 28))}`).join(', ')}`);
}

console.log(`baseline: ${KEY.length} fields, ${baseWarnings} warning(s)\n`);
await probe('rotated 1 degree', (s) => s.rotate(1, { background: '#fff' }));
await probe('rotated 3 degrees', (s) => s.rotate(3, { background: '#fff' }));
await probe('rotated 7 degrees', (s) => s.rotate(7, { background: '#fff' }));
await probe('rotated -4 degrees', (s) => s.rotate(-4, { background: '#fff' }));
await probe('half resolution', (s) => s.resize({ width: 397 }));
await probe('double resolution', (s) => s.resize({ width: 1588 }));
await probe('heavy jpeg artefacts', (s) => s.jpeg({ quality: 25 }));
await probe('dim / low contrast', (s) => s.linear(0.55, 40));
await probe('slight blur', (s) => s.blur(1.1));
await probe('tilted and dim', (s) => s.rotate(2.5, { background: '#fff' }).linear(0.6, 35));
