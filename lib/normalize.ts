import type { Comparator } from './types';
import { canonicalPort } from './ports';

/** Uppercase, strip punctuation runs, collapse whitespace. */
export function normText(s: string): string {
  return s
    .toUpperCase()
    .replace(/[.,;:'"`()\[\]]/g, ' ')
    .replace(/[-\/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Alphanumerics only — for container numbers, seals, booking refs. */
export function normId(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Digits only, with the international prefix normalised away. */
export function normPhone(s: string): string {
  const digits = s.replace(/\D/g, '');
  // A local Malaysian number may be written 03-388 8648 or +60 3-388 8648.
  return digits.replace(/^0+/, '');
}

/** First number in the string, as a canonical decimal string. */
export function normNumber(s: string): string | null {
  const m = s.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  if (!Number.isFinite(n)) return null;
  // 8263.00 and 8263.000 must land on the same string.
  return String(Math.round(n * 1000) / 1000);
}

const PACKAGE_UNITS: Record<string, string> = {
  CTN: 'CARTON', CTNS: 'CARTON', CARTON: 'CARTON', CARTONS: 'CARTON', CTS: 'CARTON',
  PKG: 'PACKAGE', PKGS: 'PACKAGE', PACKAGE: 'PACKAGE', PACKAGES: 'PACKAGE',
  PLT: 'PALLET', PLTS: 'PALLET', PALLET: 'PALLET', PALLETS: 'PALLET',
  BAG: 'BAG', BAGS: 'BAG', ROLL: 'ROLL', ROLLS: 'ROLL', PCS: 'PIECE', PIECE: 'PIECE', PIECES: 'PIECE',
  CASE: 'CASE', CASES: 'CASE', DRUM: 'DRUM', DRUMS: 'DRUM', BALE: 'BALE', BALES: 'BALE',
};

/** "816 CTNS" and "816CARTONS" both become "816 CARTON". */
export function normPackages(s: string): string | null {
  const m = s.toUpperCase().match(/(\d[\d,]*)\s*([A-Z]+)/);
  if (!m) return null;
  const count = m[1].replace(/,/g, '');
  const unit = PACKAGE_UNITS[m[2]] ?? m[2];
  return `${Number(count)} ${unit}`;
}

/**
 * Vessel and voyage. Carriers write the voyage with or without a marker —
 * "MV DEMO EXPRESS V.001E" and "MV DEMO EXPRESS 001E" are the same sailing.
 */
export function normVessel(s: string): string {
  return normText(s)
    .split(' ')
    .filter((t) => t && !/^(V|VOY|VOYAGE|VSL)$/.test(t))
    .join(' ');
}

/** Unordered token set, so goods listed in a different order still match. */
export function normList(s: string): string {
  return normText(s)
    .split(/\s*(?:,|\n|\|)\s*|\s{2,}/)
    .map((t) => t.trim())
    .filter(Boolean)
    .sort()
    .join(' | ');
}

/**
 * Normalise a value for a given comparator. Returns null when the value cannot
 * be interpreted under that comparator (e.g. a port with no known alias), which
 * the comparison layer treats as "fall back to plain text".
 */
export function normalizeFor(comparator: Comparator, raw: string): string | null {
  switch (comparator) {
    case 'text': return normText(raw);
    case 'id': return normId(raw);
    case 'phone': return normPhone(raw);
    case 'number': return normNumber(raw);
    case 'packages': return normPackages(raw);
    case 'list': return normList(raw);
    case 'vessel': return normVessel(raw);
    case 'port': return canonicalPort(raw.trim());
  }
}

/** Extract every HS/HTS code (6, 8 or 10 digits, optionally spaced) from text. */
export function findHsCodes(text: string): string[] {
  const out = new Set<string>();
  const re = /\b(\d{4})[\s.]?(\d{2})[\s.]?(\d{2})(?:[\s.]?(\d{2}))?\b/g;
  for (const m of text.matchAll(re)) {
    const digits = [m[1], m[2], m[3], m[4]].filter(Boolean).join('');
    // Reject things that are plainly not tariff codes: years, phone fragments,
    // postcodes, weights. HS chapters run 01-97.
    const chapter = Number(digits.slice(0, 2));
    if (chapter < 1 || chapter > 97) continue;
    if (digits.length < 8) continue;
    out.add(digits);
  }
  return [...out];
}

export function findEmails(text: string): string[] {
  return [...new Set(text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? [])];
}

/**
 * Characters optical recognition confuses between letters and digits. Folding
 * these together lets an OCR slip like "SAMPLE C0 LTD" match "SAMPLE CO LTD" without
 * blurring digit-to-digit distinctions: 858 and 838 stay different, because 3
 * and 5 are not confusable with each other.
 */
const CONFUSABLE: Record<string, string> = { '0': 'O', '1': 'I', '5': 'S', '8': 'B', '2': 'Z', '6': 'G' };

export function foldOcr(text: string): string {
  return text
    .toUpperCase()
    .replace(/[012568]/g, (c) => CONFUSABLE[c] ?? c)
    .replace(/[^A-Z0-9]/g, '');
}

/** Countries that appear as an optional last line of an address. */
const COUNTRIES = [
  'MALAYSIA', 'CHINA', 'SINGAPORE', 'INDONESIA', 'THAILAND', 'VIETNAM', 'PHILIPPINES',
  'INDIA', 'HONGKONG', 'TAIWAN', 'KOREA', 'JAPAN', 'CAMBODIA', 'MYANMAR', 'BRUNEI',
  'PRCHINA', 'PEOPLESREPUBLICOFCHINA',
];

/**
 * An address with the country spelled out and the same address without it are
 * the same address. Returns the address stripped of a trailing country, with
 * spacing removed so wrapping differences do not matter.
 *
 * `ocrTolerant` additionally folds the letter/digit pairs OCR confuses.
 */
export function addressKey(text: string, ocrTolerant = false): string {
  const flat = ocrTolerant ? foldOcr(text) : normText(text).replace(/\s+/g, '');
  for (const country of COUNTRIES) {
    if (flat.length > country.length && flat.endsWith(country)) return flat.slice(0, -country.length);
  }
  return flat;
}
