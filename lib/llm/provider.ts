import type { FieldKey } from '../types';

/** What a field means, sent to the model so it does not have to guess. */
export const FIELD_PROMPTS: Partial<Record<FieldKey, string>> = {
  shipper: 'Shipper: the exporting company name and full address.',
  consignee: 'Consignee: the receiving company name and address. Exclude any tel/fax line and any company registration number.',
  notifyParty: 'Notify party. Often literally "SAME AS CONSIGNEE".',
  placeOfReceipt: 'Place of receipt (inland origin), a place name only.',
  vesselVoyage: 'Ocean vessel name and voyage number, e.g. "MV DEMO EXPRESS 001E".',
  portOfLoading: 'Port of loading, a port name only.',
  portOfDischarge: 'Port of discharge, a port name only.',
  placeOfDelivery: 'Place of delivery, a port or place name only.',
  finalDestination: 'Final destination, a port or place name only.',
  containerNo: 'Container number: four letters then seven digits.',
  sealNo: 'Seal number.',
  containerType: "Container size and type, e.g. \"40'HQ\" or \"20GP\".",
  packages: 'Number of packages with its unit, e.g. "816 CARTONS".',
  grossWeight: 'Gross weight with unit, e.g. "8263.000KGS".',
  measurement: 'Measurement with unit, e.g. "65.440CBM".',
  goods: 'Description of goods: the commodity names only, comma separated. Exclude HS codes and boilerplate such as "SHIPPER\'S LOAD, COUNT & SEAL".',
  freightTerms: 'Freight terms, e.g. "FREIGHT PREPAID" or "FREIGHT COLLECT".',
  marks: 'Marks and numbers. Often "N/M".',
  soNo: 'Shipping order (S/O) number.',
};

export interface ExtractRequest {
  kind: 'SI' | 'BL';
  text: string;
  /** Only the fields the rules could not find. */
  wanted: FieldKey[];
}

export interface Provider {
  name: string;
  extract(req: ExtractRequest): Promise<Partial<Record<FieldKey, string>>>;
}

export function buildPrompt(req: ExtractRequest): string {
  const doc = req.kind === 'BL' ? 'draft ocean bill of lading' : 'shipping instruction';
  const fields = req.wanted
    .map((k) => `- ${k}: ${FIELD_PROMPTS[k] ?? k}`)
    .join('\n');
  return [
    `You are reading the text of a ${doc}. The text is given in reading order; the`,
    'printed form labels are not present because they are part of a background image.',
    '',
    'Extract ONLY these fields:',
    fields,
    '',
    'Rules:',
    '- Copy values verbatim from the document. Do not reformat, expand or translate them.',
    '- Preserve line breaks within an address as "\\n".',
    '- If a field is genuinely not present, use null. Never guess a plausible value.',
    '',
    'Document text:',
    '"""',
    req.text,
    '"""',
  ].join('\n');
}

/**
 * Google Gemini via the Developer API. The free tier needs only a Google account
 * (no card); note that on the free tier Google may use submitted text to improve
 * its models, which is why this is only ever called for documents the rules
 * could not read.
 */
/** Free tiers overload and rate-limit routinely; both are worth waiting out. */
const RETRYABLE = new Set([429, 500, 503]);

async function postWithRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
  let last: Response | null = null;
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(url, init);
    if (res.ok || !RETRYABLE.has(res.status)) return res;
    last = res;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 800 * 2 ** i));
  }
  return last!;
}

export function gemini(apiKey: string, model = process.env.GEMINI_MODEL || 'gemini-3.5-flash'): Provider {
  return {
    name: `google:${model}`,
    async extract(req) {
      const properties = Object.fromEntries(
        req.wanted.map((k) => [k, { type: 'STRING', nullable: true, description: FIELD_PROMPTS[k] ?? k }]),
      );
      const res = await postWithRetry(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: buildPrompt(req) }] }],
            generationConfig: {
              temperature: 0,
              responseMimeType: 'application/json',
              responseSchema: { type: 'OBJECT', properties },
            },
          }),
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300);
        const hint = res.status === 404
          ? ` Run "npm run llm:check" to see which models this key can use.`
          : RETRYABLE.has(res.status)
            ? ' Retried and still failing; the rules-only result stands.'
            : '';
        throw new Error(`Gemini ${res.status}: ${detail}${hint}`);
      }
      const body = await res.json();
      const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof text !== 'string') throw new Error('Gemini returned no JSON payload.');
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const out: Partial<Record<FieldKey, string>> = {};
      for (const key of req.wanted) {
        const v = parsed[key];
        if (typeof v === 'string' && v.trim()) out[key] = v.trim();
      }
      return out;
    },
  };
}

/** Reads provider configuration from the environment. Returns null when unset. */
export function providerFromEnv(): Provider | null {
  if (process.env.LLM_ASSIST === 'off') return null;
  const key = process.env.GEMINI_API_KEY?.trim();
  return key ? gemini(key) : null;
}
