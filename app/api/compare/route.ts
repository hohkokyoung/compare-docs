import { NextResponse } from 'next/server';
import { parseSi } from '../../../lib/extract/docxSi';
import { parseBl } from '../../../lib/extract/pdfBl';
import { parseXlsx } from '../../../lib/extract/xlsxSheet';
import { parseImage } from '../../../lib/extract/imageOcr';
import { bundleSide } from '../../../lib/bundle';
import { compareSides } from '../../../lib/compare';
import { runAssist } from '../../../lib/llm/assist';
import { providerFromEnv } from '../../../lib/llm/provider';
import type { ParsedDoc } from '../../../lib/types';

export const runtime = 'nodejs';
export const maxDuration = 120;

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_FILES_PER_SIDE = 10;

const IMAGE_EXT = /\.(jpe?g|png|webp|bmp|tiff?|heic)$/i;

function formatOf(file: File): 'docx' | 'pdf' | 'xlsx' | 'image' | null {
  const name = file.name.toLowerCase();
  if (name.endsWith('.docx')) return 'docx';
  if (name.endsWith('.pdf')) return 'pdf';
  if (name.endsWith('.xlsx') || name.endsWith('.xlsm')) return 'xlsx';
  if (IMAGE_EXT.test(name)) return 'image';
  if (file.type === 'application/pdf') return 'pdf';
  if (file.type.includes('wordprocessingml')) return 'docx';
  if (file.type.includes('spreadsheetml')) return 'xlsx';
  if (file.type.startsWith('image/')) return 'image';
  return null;
}

async function parse(file: File): Promise<ParsedDoc> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  switch (formatOf(file)) {
    case 'docx': return parseSi(bytes, file.name);
    case 'pdf': return parseBl(bytes, file.name);
    case 'xlsx': return parseXlsx(bytes, file.name);
    case 'image': return parseImage(bytes, file.name);
    default: throw new Error(`${file.name}: unsupported file type. Accepts .docx, .pdf, .xlsx and images.`);
  }
}

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const filesOf = (field: string) => form.getAll(field).filter((f): f is File => f instanceof File && f.size > 0);
    const groups = [
      { label: String(form.get('labelA') || 'Side A'), files: filesOf('a') },
      { label: String(form.get('labelB') || 'Side B'), files: filesOf('b') },
    ];

    for (const g of groups) {
      if (!g.files.length) {
        return NextResponse.json({ error: `${g.label} has no documents. Add at least one file to each side.` }, { status: 400 });
      }
      if (g.files.length > MAX_FILES_PER_SIDE) {
        return NextResponse.json({ error: `${g.label} has ${g.files.length} files; the limit is ${MAX_FILES_PER_SIDE}.` }, { status: 400 });
      }
      for (const f of g.files) {
        if (f.size > MAX_BYTES) {
          return NextResponse.json({ error: `${f.name} is larger than 25 MB.` }, { status: 400 });
        }
        if (!formatOf(f)) {
          return NextResponse.json({ error: `${f.name}: unsupported file type. Accepts .docx, .pdf, .xlsx and images (jpg, png).` }, { status: 400 });
        }
      }
    }

    // Images run through OCR, which is heavier than parsing a native file, so
    // each side's documents are read in sequence rather than all at once.
    const parsed: ParsedDoc[][] = [];
    for (const g of groups) {
      const docs: ParsedDoc[] = [];
      for (const f of g.files) docs.push(await parse(f));
      parsed.push(docs);
    }
    const bundles = groups.map((g, i) => bundleSide(g.label, parsed[i]));

    // Only reaches the network if the rules left a gap; see lib/llm/assist.ts.
    const { sides, assist } = await runAssist(bundles, providerFromEnv());
    return NextResponse.json(compareSides(sides[0], sides[1], assist));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `Could not read the documents: ${message}` }, { status: 500 });
  }
}
