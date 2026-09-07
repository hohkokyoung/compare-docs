import { readFileSync } from 'node:fs';
import { parseImage } from '../lib/extract/imageOcr.ts';
const path = process.argv[2] ?? 'fixtures/forme-sample.jpeg';
const doc = await parseImage(new Uint8Array(readFileSync(path)), path.split('/').pop()!);
for (const [k, v] of Object.entries(doc.fields)) console.log(k.padEnd(18), JSON.stringify(v!.raw).slice(0, 90));
console.log('\nwarnings:', doc.warnings);
