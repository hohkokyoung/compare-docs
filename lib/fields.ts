import type { FieldSpec } from './types';

/**
 * The fields compared between the two sides, in the order a documentation clerk
 * would walk a bill of lading. HS codes are deliberately absent: they belong on
 * the instruction and must usually be kept *off* the B/L, so they are handled as
 * a directive rather than as a field to match.
 */
export const FIELD_SPECS: FieldSpec[] = [
  { key: 'shipper', label: 'Shipper', comparator: 'text', requiredOnB: true },
  { key: 'consignee', label: 'Consignee', comparator: 'text', requiredOnB: true, requiredOnA: true },
  { key: 'consigneeRegNo', label: 'Consignee registration no.', comparator: 'id' },
  { key: 'consigneePhone', label: 'Consignee tel / fax', comparator: 'phone' },
  { key: 'notifyParty', label: 'Notify party', comparator: 'text', requiredOnB: true },
  { key: 'placeOfReceipt', label: 'Place of receipt', comparator: 'port' },
  { key: 'vesselVoyage', label: 'Ocean vessel / voyage', comparator: 'vessel', requiredOnB: true },
  { key: 'portOfLoading', label: 'Port of loading', comparator: 'port', requiredOnB: true },
  { key: 'portOfDischarge', label: 'Port of discharge', comparator: 'port', requiredOnB: true, requiredOnA: true },
  { key: 'placeOfDelivery', label: 'Place of delivery', comparator: 'port' },
  { key: 'finalDestination', label: 'Final destination', comparator: 'port' },
  { key: 'containerNo', label: 'Container no.', comparator: 'id', requiredOnB: true },
  { key: 'sealNo', label: 'Seal no.', comparator: 'id', requiredOnB: true },
  { key: 'containerType', label: 'Container type', comparator: 'id' },
  { key: 'packages', label: 'No. of packages', comparator: 'packages', requiredOnB: true, requiredOnA: true },
  { key: 'grossWeight', label: 'Gross weight', comparator: 'number', requiredOnB: true, requiredOnA: true },
  { key: 'measurement', label: 'Measurement (CBM)', comparator: 'number', requiredOnB: true, requiredOnA: true },
  { key: 'goods', label: 'Description of goods', comparator: 'list', requiredOnB: true, requiredOnA: true },
  { key: 'freightTerms', label: 'Freight terms', comparator: 'text' },
  { key: 'marks', label: 'Marks and numbers', comparator: 'text' },
  { key: 'soNo', label: 'S/O no.', comparator: 'id' },
];

/**
 * Human labels for fields that are extracted but not compared directly, so a
 * conflict between documents still reads properly.
 */
export const EXTRA_LABELS: Partial<Record<string, string>> = {
  hsCodes: 'HS codes',
};

export function labelFor(key: string): string {
  const spec = FIELD_SPECS.find((s) => s.key === key);
  if (spec) return spec.label;
  if (EXTRA_LABELS[key]) return EXTRA_LABELS[key]!;
  // Fall back to a readable version of the key: "portOfLoading" -> "Port of loading".
  const words = key.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
