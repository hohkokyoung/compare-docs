// Integration tests over the synthetic sample documents in samples/.
// These use invented data only (SAMPLE IMPORTER / DEMO EXPORTER) and are the
// tests published in the public repository. The full suite runs against real
// customer fixtures that are kept private (git-ignored).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSi } from '../lib/extract/docxSi.ts';
import { parseXlsx } from '../lib/extract/xlsxSheet.ts';
import { bundleSide } from '../lib/bundle.ts';
import { compareSides } from '../lib/compare.ts';

const si = await parseSi(new Uint8Array(readFileSync('samples/instruction.docx')), 'instruction.docx');
const good = await parseXlsx(new Uint8Array(readFileSync('samples/confirmation.xlsx')), 'confirmation.xlsx');
const bad = await parseXlsx(new Uint8Array(readFileSync('samples/confirmation-with-errors.xlsx')), 'confirmation-with-errors.xlsx');

const A = () => bundleSide('Instructions', [si]);

test('the Word instruction is read into fields', () => {
  assert.match(si.fields.consignee!.raw, /^SAMPLE IMPORTER/);
  assert.equal(si.fields.packages!.raw, '1000 CTNS');
  assert.equal(si.fields.portOfDischarge!.raw, 'WEST PORT');
  assert.equal(si.directives.length, 2); // keep-email-off, no-HS-codes
});

test('the Excel confirmation is read from its labelled cells', () => {
  assert.match(good.fields.shipper!.raw, /^DEMO EXPORTER/);
  assert.equal(good.fields.packages!.raw, '1000CARTONS');
  assert.equal(good.fields.finalDestination!.raw, 'PORT KELANG(W)');
});

test('formatting-only differences are recognised as the same value', () => {
  const r = compareSides(A(), bundleSide('Draft B/L', [good]));
  const byKey = Object.fromEntries(r.fields.map((f) => [f.key, f.verdict]));
  assert.equal(byKey.packages, 'equivalent');       // 1200 CTNS vs 1200CARTONS
  assert.equal(byKey.grossWeight, 'equivalent');     // 15500.00 vs 15500.000
  assert.equal(byKey.portOfDischarge, 'equivalent'); // WEST PORT vs PORT KELANG(W)
  assert.equal(byKey.goods, 'match');
});

test('a printed HS code is caught against the "do not show" instruction', () => {
  const r = compareSides(A(), bundleSide('Draft B/L', [good]));
  const hs = r.directives.find((d) => d.directive.forbid.kind === 'hsCodes')!;
  assert.equal(hs.verdict, 'violated');
});

test('a wrong carton count and weight are caught', () => {
  const r = compareSides(A(), bundleSide('Draft B/L', [bad]));
  const byKey = Object.fromEntries(r.fields.map((f) => [f.key, f]));
  assert.equal(byKey.packages.verdict, 'mismatch');     // 1200 vs 1150
  assert.equal(byKey.grossWeight.verdict, 'mismatch');  // 15500 vs 15050
  assert.ok(r.summary.mismatches >= 2);
});

test('non-standard fields are surfaced separately', () => {
  const r = compareSides(A(), bundleSide('Draft B/L', [good]));
  const labels = r.discovered.map((d) => d.label);
  assert.ok(labels.includes('船公司'));  // carrier
  assert.ok(r.discovered.length >= 3);
});

test('nothing is sent anywhere for cleanly-read documents', () => {
  const r = compareSides(A(), bundleSide('Draft B/L', [good]));
  assert.equal(r.assist.used, false);
});
