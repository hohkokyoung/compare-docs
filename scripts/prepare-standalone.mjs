/**
 * Next's standalone output traces most of what the server needs, but not the
 * static assets or a couple of native packages it loads dynamically. This copies
 * the missing pieces so the bundle runs on a machine with no node_modules.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const DIST = process.env.NEXT_DIST_DIR || '.next-build';
const root = process.cwd();
const standalone = join(root, DIST, 'standalone');

if (!existsSync(join(standalone, 'server.js'))) {
  console.error(`No standalone build at ${standalone}. Run the Next build first.`);
  process.exit(1);
}

// 1. Static chunks — Next leaves these behind.
const staticFrom = join(root, DIST, 'static');
const staticTo = join(standalone, DIST, 'static');
if (existsSync(staticFrom)) {
  mkdirSync(join(standalone, DIST), { recursive: true });
  cpSync(staticFrom, staticTo, { recursive: true });
  console.log('copied static assets');
}

// 2. public/ (favicons etc.), if present.
const publicFrom = join(root, 'public');
if (existsSync(publicFrom)) {
  cpSync(publicFrom, join(standalone, 'public'), { recursive: true });
  console.log('copied public/');
}

// 3. Native/dynamic packages the trace can miss. Copy the whole tree so their
//    own nested node_modules (native .node binaries) come along.
// pdfjs ships its worker as a separate file the trace omits; exceljs and the OCR
// stack load assets dynamically. Replace these wholesale so nothing is missing.
const FULL = ['@napi-rs', 'ppu-ocv', 'ppu-paddle-ocr', 'onnxruntime-node', 'sharp', '@img', 'pdfjs-dist', 'exceljs', 'mammoth'];
for (const pkg of FULL) {
  const from = join(root, 'node_modules', pkg);
  const to = join(standalone, 'node_modules', pkg);
  if (!existsSync(from)) continue;
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true, dereference: true });
  console.log(`copied ${pkg}`);
}
console.log('standalone prepared.');
