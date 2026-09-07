/** A single value pulled out of a document, with enough provenance to audit it. */
export interface Extracted {
  /** Raw text exactly as it appeared in the source document. */
  raw: string;
  /** Where it came from, e.g. "B/L box 2 (Consignee)" or "SI line 4". */
  where: string;
  /**
   * Which reader produced it. Absent means the deterministic rules read it from
   * a native file; 'ocr' means it was recognised from an image and may carry
   * character-level noise; 'llm' means a language model supplied it.
   */
  source?: 'llm' | 'ocr';
  /** The file it was read from. Set when documents are merged into a side. */
  file?: string;
}

export type FieldKey =
  | 'shipper'
  | 'consignee'
  | 'consigneeRegNo'
  | 'consigneePhone'
  | 'notifyParty'
  | 'placeOfReceipt'
  | 'vesselVoyage'
  | 'portOfLoading'
  | 'portOfDischarge'
  | 'placeOfDelivery'
  | 'finalDestination'
  | 'containerNo'
  | 'sealNo'
  | 'containerType'
  | 'packages'
  | 'grossWeight'
  | 'measurement'
  | 'goods'
  | 'hsCodes'
  | 'freightTerms'
  | 'marks'
  | 'soNo';

/** How a field's two values are compared once normalised. */
export type Comparator =
  | 'text'      // case/punctuation/whitespace-insensitive
  | 'number'    // numeric with tolerance
  | 'packages'  // count + unit synonyms (816 CTNS == 816CARTONS)
  | 'phone'     // digits only
  | 'port'      // canonical port names via alias table
  | 'list'      // unordered set of tokens
  | 'vessel'    // vessel name plus voyage, ignoring the "V." voyage marker
  | 'id';       // alphanumerics only, case-insensitive

export interface FieldSpec {
  key: FieldKey;
  label: string;
  comparator: Comparator;
  /** When true, absence on that side is a finding rather than a shrug. */
  requiredOnB?: boolean;
  requiredOnA?: boolean;
  /** Guidance shown under the field name in the UI. */
  hint?: string;
}

/** An instruction from the SI such as "do not print HS codes on the B/L". */
export interface Directive {
  id: string;
  /** The file that declared it, so it is never checked against itself. */
  file?: string;
  /** The original instruction text, usually Chinese. */
  raw: string;
  /** Plain-English rendering shown in the UI. */
  meaning: string;
  /** What must not appear on the B/L. */
  forbid: { kind: 'email' | 'hsCodes' | 'literal'; value?: string };
  where: string;
}

export interface ParsedDoc {
  kind: 'SI' | 'BL';
  /** The file format it was read from. */
  format: 'docx' | 'pdf' | 'xlsx' | 'image';
  fileName: string;
  fields: Partial<Record<FieldKey, Extracted>>;
  directives: Directive[];
  /** Full text, for the "show me the source" panel. */
  text: string;
  /** Every email address in the document — used by directive checks, not compared. */
  emails: string[];
  warnings: string[];
}

export type Verdict =
  | 'match'          // identical after normalisation and literally the same
  | 'equivalent'     // different text, same meaning (816 CTNS vs 816CARTONS)
  | 'mismatch'       // genuinely different values
  | 'missing_on_b'   // side A states it, side B does not
  | 'missing_on_a'   // side B states it, side A does not
  | 'not_specified'  // absent on a side that is not expected to carry it
  | 'absent_both';

export interface FieldResult {
  key: FieldKey;
  label: string;
  a: Extracted | null;
  b: Extracted | null;
  aNormal: string | null;
  bNormal: string | null;
  verdict: Verdict;
  note?: string;
}

/**
 * A label:value pair a reader found that is not one of the curated fields. These
 * are surfaced but never trusted like a known field: no normalisation, no port
 * aliases, no OCR folding — just the raw text, matched across sides by an exact
 * (case- and punctuation-insensitive) label.
 */
export interface DiscoveredField {
  /** Normalised label, used to pair the same field across the two sides. */
  key: string;
  /** The label as printed. */
  label: string;
  value: string;
  file: string;
}

/** A discovered field seen on one or both sides. */
export interface DiscoveredResult {
  label: string;
  a: DiscoveredField | null;
  b: DiscoveredField | null;
  verdict: 'match' | 'mismatch' | 'a_only' | 'b_only';
}

/** Two documents on the same side stating the same field differently. */
export interface SideConflict {
  key: FieldKey;
  label: string;
  values: { file: string; raw: string }[];
}

/**
 * One side of the comparison: any number of documents, merged into a single set
 * of fields. Both sides accept any mix of .docx, .pdf and .xlsx.
 */
export interface Side {
  label: string;
  docs: ParsedDoc[];
  fields: Partial<Record<FieldKey, Extracted>>;
  directives: Directive[];
  emails: string[];
  text: string;
  warnings: string[];
  /** Disagreements between documents on this side, before any cross-comparison. */
  conflicts: SideConflict[];
  /** Label:value pairs found that are not curated fields. */
  discovered: DiscoveredField[];
}

export type DirectiveVerdict = 'ok' | 'violated' | 'unchecked';

export interface DirectiveResult {
  directive: Directive;
  verdict: DirectiveVerdict;
  detail: string;
}

/** A value one document states twice (cargo boxes vs the container line) that disagrees. */
export interface InternalIssue {
  file: string;
  label: string;
  values: string[];
  detail: string;
}

/** Record of whether a language model was consulted, and for what. */
export interface AssistReport {
  /** True only if a request actually left the machine. */
  used: boolean;
  provider: string;
  /** Which files were sent. */
  docs: string[];
  /** Fields the model supplied that the rules could not. */
  filled: { file: string; key: FieldKey }[];
  /** Why it was called, or why it was not. */
  reasons: string[];
}

export interface ComparisonReport {
  sideA: Side;
  sideB: Side;
  fields: FieldResult[];
  directives: DirectiveResult[];
  internal: InternalIssue[];
  /** Non-curated fields, matched across the two sides by exact label. */
  discovered: DiscoveredResult[];
  assist: AssistReport;
  summary: { mismatches: number; missing: number; equivalent: number; matches: number; violations: number };
}
