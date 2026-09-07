/**
 * Compare two sides from the terminal.
 *   npm run check -- <side-A files...> -- <side-B files...>
 */
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { parseSi } from '../lib/extract/docxSi.ts';
import { parseBl } from '../lib/extract/pdfBl.ts';
import { parseXlsx } from '../lib/extract/xlsxSheet.ts';
import { bundleSide } from '../lib/bundle.ts';
import { compareSides } from '../lib/compare.ts';
import type { ParsedDoc } from '../lib/types.ts';

const argv = process.argv.slice(2);
const split = argv.indexOf('--');
if (split < 1 || split === argv.length - 1) {
  console.error('usage: npm run check -- <A files...> -- <B files...>');
  process.exit(1);
}
const groups = [argv.slice(0, split), argv.slice(split + 1)];

async function parse(path: string): Promise<ParsedDoc> {
  const bytes = new Uint8Array(readFileSync(path));
  const name = basename(path);
  switch (extname(path).toLowerCase()) {
    case '.docx': return parseSi(bytes, name);
    case '.pdf': return parseBl(bytes, name);
    case '.xlsx': case '.xlsm': return parseXlsx(bytes, name);
    default: throw new Error(`${name}: unsupported file type.`);
  }
}

const sides = await Promise.all(
  groups.map(async (files, i) =>
    bundleSide(i === 0 ? 'Instructions' : 'Draft B/L', await Promise.all(files.map(parse)))),
);

for (const side of sides) {
  console.log(`\n=== ${side.label}: ${side.docs.map((d) => d.fileName).join(', ')} ===`);
  for (const [k, v] of Object.entries(side.fields)) {
    console.log('  ', k.padEnd(18), JSON.stringify(v!.raw).slice(0, 78), v!.file ? `  [${v!.file}]` : '');
  }
  if (side.conflicts.length) {
    console.log('  CONFLICTS WITHIN THIS SIDE:');
    for (const c of side.conflicts) {
      console.log(`    ${c.label}: ` + c.values.map((v) => `${v.file}=${JSON.stringify(v.raw)}`).join(' vs '));
    }
  }
  if (side.warnings.length) console.log('  warnings:', side.warnings);
}

const report = compareSides(sides[0], sides[1]);
console.log('\n=== Comparison ===');
for (const f of report.fields) {
  if (f.verdict === 'absent_both') continue;
  console.log(
    `${f.verdict.toUpperCase().padEnd(14)} ${f.label.padEnd(26)}`,
    `A=${JSON.stringify(f.a?.raw ?? null).slice(0, 40)}`,
    `B=${JSON.stringify(f.b?.raw ?? null).slice(0, 40)}`,
  );
}
console.log('\nInstructions:');
for (const d of report.directives) console.log(` ${d.verdict.toUpperCase()} — ${d.directive.meaning}\n     ${d.detail}`);
if (report.internal.length) console.log('\nInternal:', report.internal);
console.log('\nSummary:', report.summary);
