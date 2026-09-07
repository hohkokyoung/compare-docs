import type { FieldKey } from '../types';

/**
 * What a field's value has to look like to be believable.
 *
 * Positional extraction can pick up the wrong thing — a rotated scan shifts the
 * geometry and a printed heading lands where a value should be. Recognising that
 * `"Notes) and walue (FOB) only"` is not a gross weight costs almost nothing and
 * turns a silently wrong answer into an honest gap.
 */
const SHAPE: Partial<Record<FieldKey, RegExp>> = {
  grossWeight: /\d[\d,]*(?:\.\d+)?\s*(?:KGS?|MT|LBS?|TONS?)\b/i,
  measurement: /\d[\d,]*(?:\.\d+)?\s*(?:CBM|M3)\b/i,
  packages: /\d[\d,]*\s*[A-Z]{2,}/i,
  containerNo: /^[A-Z]{4}\d{7}$/,
  sealNo: /^[A-Z0-9-]{5,15}$/i,
  containerType: /^\d{2}'?(?:GP|HQ|HC|RF|NOR|OT|FR)$|^\d{2}FT$/i,
  consigneeRegNo: /\d{9,14}\s*\/\s*[A-Z]{1,3}\d{5,10}/i,
  consigneePhone: /(?:\d[\s()+.-]*){7,}/,  // seven digits, however they are spaced
  freightTerms: /^FREIGHT\s+(?:PREPAID|COLLECT|PAYABLE)/i,
  soNo: /^[A-Z0-9][A-Z0-9\/-]{4,}$/i,
};

/** Wording that only ever appears in a form's printed furniture, never in a value. */
const FURNITURE = /\b(?:Overleaf|criterion|see\s+Notes?|FOB\)|Signature|Declaration|hereby|Certification|Importing\s+Country|applied|quantity,|numbers?\s+on)\b/i;

/** Fields that are free text, where only the furniture check applies. */
const FREE_TEXT: FieldKey[] = [
  'shipper', 'consignee', 'notifyParty', 'goods', 'marks',
  'portOfDischarge', 'placeOfDelivery', 'finalDestination', 'portOfLoading',
  'placeOfReceipt', 'vesselVoyage',
];

/**
 * Whether a value is worth keeping. Returns a reason when it is not, so the
 * caller can say what it threw away rather than dropping it quietly.
 */
export function implausible(key: FieldKey, raw: string): string | null {
  const value = raw.trim();
  if (!value) return 'empty';

  if (FURNITURE.test(value)) return 'reads as printed form wording, not a value';

  const shape = SHAPE[key];
  if (shape && !shape.test(value)) return `does not look like a ${key} value`;

  // A port is a place name. On a tilted scan the routing sentence ("FROM NINGBO,
  // CHINA TO PORT KLANG...") can land in the discharge box; it is not a port.
  if (['portOfDischarge', 'placeOfDelivery', 'finalDestination', 'portOfLoading', 'placeOfReceipt'].includes(key)) {
    if (/\bFROM\b|\bTO\b|\bBY\s+(?:SEA|AIR|RAIL|ROAD)\b/i.test(value)) return 'reads as a routing sentence, not a port';
    if (value.length > 45) return 'too long to be a port name';
  }

  if (FREE_TEXT.includes(key)) {
    // Values are typed in capitals on these forms; a run of lowercase prose is
    // the tail of a heading that positional extraction wandered into.
    const letters = value.replace(/[^A-Za-z]/g, '');
    if (letters.length >= 6) {
      const lower = letters.replace(/[^a-z]/g, '').length / letters.length;
      if (lower > 0.6) return 'reads as lowercase prose rather than a typed value';
    }
  }
  return null;
}
