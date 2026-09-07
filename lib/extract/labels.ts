import type { FieldKey } from '../types';

/**
 * Field labels as they appear on shipping paperwork, in English and Chinese.
 * Shared by the Word and Excel readers so the two cannot drift apart.
 *
 * Each pattern is anchored at the start: a label cell or line begins with the
 * label. Composite headings such as "Ocean Vessel(船名)/Voy.No.(航次)" and
 * "Kind of packages:Description of Goods(包装类型与货名)" are matched by their
 * leading words.
 */
export const LABEL_ALIASES: Partial<Record<FieldKey, RegExp>> = {
  shipper: /^(SHIPPER|PRODUCTS?\s+CONSIGNED\s+FROM|EXPORTER|发货人|托运人)/i,
  consignee: /^(CONSIGNEE|CNEE|PRODUCTS?\s+CONSIGNED\s+TO|收货人)/i,
  notifyParty: /^(NOTIFY(\s*PARTY)?|通知人)/i,
  placeOfReceipt: /^(PLACE\s+OF\s+RECEIPT|收货地)/i,
  portOfLoading: /^(PORT\s+OF\s+LOADING|POL|装货港|起运港)/i,
  portOfDischarge: /^(PORT\s+OF\s+DISCHARGE|POD|卸货港)/i,
  placeOfDelivery: /^(PLACE\s+OF\s+DELIVERY|交货地)/i,
  finalDestination: /^(FINAL\s+DESTINATION|目的地)/i,
  vesselVoyage: /^(OCEAN\s+VESSEL|VESSEL(?:'?S)?\s*(NAME)?|船名航次|船名)/i,
  goods: /^(DESCRIPTION|DESC|COMMODITY|GOODS|KIND\s+OF\s+PACKAGES|品名|货名|包装类型)/i,
  packages: /^(NO\.?\s*OF\s+(CONTAINERS?|PACKAGES?|P'?KGS?)|NUMBER\s+OF\s+PACKAGES|箱数|件数)/i,
  grossWeight: /^(GROSS\s*WEIGHT|G\.?W\.?\b|毛重)/i,
  measurement: /^(MEASUREMENT|CBM\b|尺码|体积)/i,
  marks: /^(MARKS?(\s+AND\s+NUMBERS?)?|唛头)/i,
  freightTerms: /^(FREIGHT|付款方式|运费)/i,
  containerNo: /^(CONTAINER(\s*(NO|NUMBER))?|柜号|箱号)/i,
  sealNo: /^(SEAL(\s*(NO|NUMBER))?|封号|铅封)/i,
  soNo: /^(D\/R\s*NO|S\/O\s*NO|B\/L\s*NO|BOOKING\s*NO|提单号|工作编号)/i,
};

export function isLabel(text: string): boolean {
  return Object.values(LABEL_ALIASES).some((re) => re.test(text.trim()));
}

/** Strip the label from a "LABEL: value" string, leaving the value. */
export function stripLabel(text: string, re: RegExp): string {
  return text.replace(re, '').replace(/^[^\S\n]*[:：]?[^\S\n]*/, '').trim();
}

/**
 * Chinese shipping-instruction shorthand: parentheticals telling the agent to
 * keep something off the bill of lading.
 *   (email : x@y.com 只提供不显示在提单)   "for our reference, keep it off the B/L"
 *   (提单不显示海关编码)                    "do not print HS codes on the B/L"
 */
export const SUPPRESS_MARKERS = [
  '不显示在提单', '不显示于提单', '提单不显示', '不打在提单', '不要显示', '不显示',
];
export const HS_WORDS = ['海关编码', '海关编号', 'HS编码', 'HS CODE', 'HSCODE', '税则号'];

/** True when a parenthetical is an instruction rather than part of the value. */
export function isInstruction(parenthetical: string): boolean {
  return SUPPRESS_MARKERS.some((k) => parenthetical.includes(k)) || /只提供/.test(parenthetical);
}

/** Remove instruction parentheticals so they do not pollute an extracted value. */
export function stripNotes(text: string): string {
  return text
    .replace(/[（(][^）)]*[）)]/g, (m) => (isInstruction(m) ? '' : m))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
