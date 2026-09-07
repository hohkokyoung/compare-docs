export {};

/** Verifies the configured key works and lists the models it can reach. */
const key = process.env.GEMINI_API_KEY?.trim();
if (!key) {
  console.log('GEMINI_API_KEY is not set — the app runs rules-only, fully offline.');
  process.exit(0);
}
const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
  headers: { 'x-goog-api-key': key },
});
if (!res.ok) {
  console.error(`Key rejected (HTTP ${res.status}): ${(await res.text()).slice(0, 400)}`);
  process.exit(1);
}
const { models = [] } = (await res.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
const usable = models
  .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
  .map((m) => m.name.replace(/^models\//, ''));
console.log(`Key works. ${usable.length} model(s) support generateContent:\n`);
for (const m of usable) console.log('  ', m, /flash/i.test(m) ? '  <- free-tier candidate' : '');
console.log(`\nCurrent GEMINI_MODEL: ${process.env.GEMINI_MODEL || 'gemini-flash-latest (default)'}`);
if (!usable.includes(process.env.GEMINI_MODEL || 'gemini-flash-latest')) {
  console.log('That model is not in the list above — set GEMINI_MODEL in .env.local to one that is.');
}
