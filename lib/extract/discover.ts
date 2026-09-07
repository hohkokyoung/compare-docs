import type { DiscoveredField } from '../types';
import { isLabel } from './labels';

/**
 * Discovery of fields the curated set does not cover.
 *
 * Shipping paperwork carries plenty beyond the twenty-two known fields — a
 * carrier line, a sailing date, a cut-off date, a work number. These appear as
 * explicit `label: value` pairs (`船公司:WHL`, `开航日期:2026-08-28`), often
 * packed several to a cell. This finds them so nothing is silently dropped,
 * while keeping them clearly apart from the checked fields.
 *
 * The bar is deliberately high: only an explicit colon-delimited pair, a
 * sensible-length label that is not already a curated field, and a value that
 * is not itself a heading. A missed extra is a smaller sin than a form full of
 * furniture masquerading as fields.
 */

/** Wording that is a form's printed furniture, never a field worth surfacing. */
const NOISE = [
  /^TEL\b/i, /^FAX\b/i, /^E[-_ ]?MAIL\b/i, /^PHONE\b/i, /^HP\b/i, /^ATTN\b/i,
  /^SEE\b/i, /^NOTE/i, /^REMARK/i, /^SIGNATURE/i, /^DATE\b/i, /^PLACE\b/i,
  /^ISSUED\b/i, /^FROM\b/i, /^TO\b/i, /^VERIFICATION/i, /^COUNTRY/i,
  /^DECLARATION/i, /^CERTIF/i, /HEREBY/i, /OVERLEAF/i, /^HTTP/i, /^WWW\./i,
  // Already handled elsewhere: HS codes and the carton total are curated fields,
  // and the email/HS suppression notes are read as directives.
  /^HS\s*CODE/i, /^TOTAL/i, /^EMAIL/i, /^DESCRIPTION/i,
];

/** Collapse a label to a key so the same field pairs across the two sides. */
export function labelKey(label: string): string {
  return label
    .replace(/[（(][^）)]*[）)]/g, '')       // drop parenthetical translations
    .toUpperCase()
    .replace(/[^A-Z0-9一-鿿]/g, '') // keep letters, digits, CJK
    .trim();
}

/** Does this text contain an actual word (a letter or a CJK character)? */
function hasWord(text: string): boolean {
  return /[A-Za-z一-鿿]/.test(text);
}

function acceptableLabel(label: string): boolean {
  if (label.length < 2 || label.length > 32) return false;
  if (!hasWord(label)) return false;
  if (isLabel(label)) return false;                 // it's a curated field
  if (NOISE.some((re) => re.test(label.trim()))) return false;
  return true;
}

function acceptableValue(value: string, label: string): boolean {
  if (!value || value.length > 60) return false;    // long text is an address, not a field
  if (!hasWord(value) && !/\d/.test(value)) return false;
  if (isLabel(value)) return false;                 // the "value" is actually the next heading
  if (labelKey(value) === labelKey(label)) return false;
  return true;
}

/**
 * Pull discovered fields out of a document's text. Works on any format, because
 * every reader produces line-broken text and the pairs are colon-delimited.
 */
export function discoverFields(text: string, file: string): DiscoveredField[] {
  const out: DiscoveredField[] = [];
  const seen = new Set<string>();

  for (const rawLine of text.split('\n')) {
    // A line may hold more than one pair: "船公司:WHL 开航日期:2026-08-28".
    for (const m of rawLine.matchAll(/([^:：]{2,32}?)\s*[:：]\s*([^:：]{1,60}?)(?=\s{2,}\S+\s*[:：]|$)/g)) {
      const label = m[1].trim().replace(/^[\s\d.、)("'（]+/, ''); // strip leading number, quote or bracket
      const value = m[2].trim();
      if (!acceptableLabel(label) || !acceptableValue(value, label)) continue;
      const key = labelKey(label);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ key, label, value, file });
    }
  }
  return out;
}
