import { chromium } from 'playwright';
import sharp from 'sharp';
const BASE = 'http://127.0.0.1:34170';
const S = process.cwd() + '/samples';
const DSF = 2;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1160, height: 1000 }, deviceScaleFactor: DSF });

const setFiles = async (a, b) => {
  const inp = page.locator('.dropzone input[type=file]');
  await inp.nth(0).setInputFiles([S + '/' + a]);
  await inp.nth(1).setInputFiles([S + '/' + b]);
  await page.waitForTimeout(250);
};
const compare = async () => {
  await page.getByRole('button', { name: /Compare/ }).click();
  await page.waitForSelector('.scores', { timeout: 30000 });
  await page.waitForTimeout(600);
};
const box = async (sel) => page.locator(sel).first().boundingBox();
// Crop full-page PNG between the top of one box and the bottom of another.
const crop = async (png, top, bot, out, pad = 16) => {
  const x = Math.max(0, Math.round((top.x - pad) * DSF));
  const y = Math.max(0, Math.round((top.y - pad) * DSF));
  const w = Math.round((Math.min(1160, top.width + pad * 2)) * DSF);
  const h = Math.round(((bot.y + bot.height + pad) - (top.y - pad)) * DSF);
  const meta = await sharp(png).metadata();
  await sharp(png).extract({ left: x, top: y, width: Math.min(w, meta.width - x), height: Math.min(h, meta.height - y) }).toFile(out);
};

// ---- clean comparison ----
await page.goto(BASE, { waitUntil: 'networkidle' });
await setFiles('instruction.docx', 'confirmation.xlsx');
await compare();
await page.screenshot({ path: '/tmp/clean.png', fullPage: true });
const docs = await box('.panel:has-text("DOCUMENTS")');
const scores = await box('.scores');
const fieldsPanel = await box('.panel:has-text("All fields")');
const extras = await box('.panel:has-text("Additional fields found")');
await crop('/tmp/clean.png', docs, scores, 'docs/img/hero.png');
// fields: the "same value" rows — differently written, same meaning.
const podRow = await box('tr:has-text("Port of discharge")');
const cbmRow = await box('tr:has-text("Measurement")');
await crop('/tmp/clean.png', podRow, cbmRow, 'docs/img/fields.png');
await crop('/tmp/clean.png', extras, extras, 'docs/img/extras.png');
console.log('hero, fields, extras');

// ---- error comparison ----
await page.goto(BASE, { waitUntil: 'networkidle' });
await setFiles('instruction.docx', 'confirmation-with-errors.xlsx');
await compare();
await page.screenshot({ path: '/tmp/err.png', fullPage: true });
const banner = await box('.verdict-banner');
const scores2 = await box('.scores');
await crop('/tmp/err.png', banner, scores2, 'docs/img/errors.png');
console.log('errors');

await browser.close();
