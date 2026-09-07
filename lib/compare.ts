import type {
  AssistReport, ComparisonReport, Directive, DirectiveResult, DiscoveredResult, FieldKey, FieldResult,
  FieldSpec, InternalIssue, ParsedDoc, Side, Verdict,
} from './types';
import { FIELD_SPECS } from './fields';
import { isInstruction } from './extract/labels';
import { addressKey, findHsCodes, foldOcr, normalizeFor, normText } from './normalize';
import { portRelation } from './ports';

export { FIELD_SPECS };

/**
 * Where the cargo is going has three names on the forms — discharge port, place
 * of delivery, final destination — and documents fill in different ones. A
 * certificate states only "Port of Discharge"; a B/L may state only the final
 * destination. Treat the family as one question rather than reporting a value
 * as missing because it was written in the next box along.
 */
const DESTINATION: FieldKey[] = ['portOfDischarge', 'placeOfDelivery', 'finalDestination'];

function destinationFallback(side: Side, key: FieldKey) {
  if (!DESTINATION.includes(key)) return null;
  for (const alt of DESTINATION) {
    if (alt === key) continue;
    const value = side.fields[alt];
    if (value) return { value, alt };
  }
  return null;
}

function compareField(spec: FieldSpec, a: Side, b: Side): FieldResult {
  let av = a.fields[spec.key] ?? null;
  let bv = b.fields[spec.key] ?? null;
  let substituted = '';

  if (av && !bv) {
    const fallback = destinationFallback(b, spec.key);
    if (fallback) { bv = fallback.value; substituted = `${b.label} states this as ${fallback.alt}`; }
  } else if (!av && bv) {
    const fallback = destinationFallback(a, spec.key);
    if (fallback) { av = fallback.value; substituted = `${a.label} states this as ${fallback.alt}`; }
  }

  const base = { key: spec.key, label: spec.label, a: av, b: bv };

  if (!av && !bv) {
    const required = spec.requiredOnA || spec.requiredOnB;
    return {
      ...base, aNormal: null, bNormal: null,
      verdict: required ? 'missing_on_b' : 'absent_both',
      note: required ? 'Required, but stated on neither side.' : undefined,
    };
  }
  if (av && !bv) {
    return {
      ...base, aNormal: normalizeFor(spec.comparator, av.raw), bNormal: null,
      verdict: 'missing_on_b',
      note: `${a.label} states this but ${b.label} does not show it.`,
    };
  }
  if (!av && bv) {
    return {
      ...base, aNormal: null, bNormal: normalizeFor(spec.comparator, bv.raw),
      verdict: spec.requiredOnA ? 'missing_on_a' : 'not_specified',
      note: spec.requiredOnA
        ? `${b.label} states this but ${a.label} does not — nothing to check it against.`
        : `Not stated on ${a.label}; carried from the booking. Verify manually if it matters.`,
    };
  }

  const an = normalizeFor(spec.comparator, av!.raw);
  const bn = normalizeFor(spec.comparator, bv!.raw);
  const also = (note?: string) => [substituted, note].filter(Boolean).join('. ') || undefined;

  // A comparator that cannot interpret one side (an unknown port, an unparseable
  // number) must not silently pass — fall back to text and say so.
  if (an === null || bn === null) {
    const af = normText(av!.raw);
    const bf = normText(bv!.raw);
    return {
      ...base, aNormal: af, bNormal: bf,
      verdict: af === bf ? 'match' : 'mismatch',
      note: `Compared as plain text — the ${spec.comparator} rule could not interpret the ${an === null ? a.label : b.label} value.`,
    };
  }

  if (an !== bn) {
    // A certificate names the port; the B/L names the berth inside it. Less
    // specific is not the same as contradictory.
    if (spec.comparator === 'port' && portRelation(av!.raw, bv!.raw) === 'compatible') {
      return {
        ...base, aNormal: an, bNormal: bn, verdict: 'equivalent',
        note: also(`One names the port and the other the terminal within it (${an} / ${bn}). Compatible, but confirm the berth is right.`),
      };
    }
    // Optical recognition confuses O with 0 and S with 5. Where a value came
    // from an image, retry with those folded together before calling it a
    // discrepancy — digit-to-digit differences still stand.
    const fromImage = av!.source === 'ocr' || bv!.source === 'ocr';
    if (fromImage && foldOcr(av!.raw) === foldOcr(bv!.raw)) {
      return {
        ...base, aNormal: an, bNormal: bn, verdict: 'equivalent',
        note: also('Differs only in characters that optical recognition confuses (O/0, S/5, B/8). Check against the image if it matters.'),
      };
    }
    // An address that spells out the country and one that stops at the state are
    // the same address; forms differ on this constantly.
    if (spec.comparator === 'text') {
      const ax = addressKey(av!.raw, fromImage);
      const bx = addressKey(bv!.raw, fromImage);
      if (ax && ax === bx) {
        return {
          ...base, aNormal: an, bNormal: bn, verdict: 'equivalent',
          note: also('Same address; one spells out the country and the other does not.'),
        };
      }
    }
    return { ...base, aNormal: an, bNormal: bn, verdict: 'mismatch', note: also() };
  }
  const literallySame = av!.raw.trim() === bv!.raw.trim();
  return {
    ...base, aNormal: an, bNormal: bn,
    verdict: literallySame ? 'match' : 'equivalent',
    note: also(literallySame ? undefined : `Written differently but equivalent (both resolve to "${an}").`),
  };
}

/**
 * Text as it would be *printed*, with instruction parentheticals removed. An
 * instruction that says "keep this email off the B/L" contains the email itself;
 * finding it there is not a breach of the instruction.
 */
function printedText(doc: ParsedDoc): string {
  return doc.text.replace(/[（(][^）)]*[）)]/g, (m) => (isInstruction(m) ? '' : m));
}

/**
 * Check each instruction against the *opposite* side only.
 *
 * "Do not print HS codes on the B/L" is about the document being verified, not
 * about its own siblings: a booking confirmation filed alongside the instruction
 * may list HS codes quite properly for customs. Checking across the side divide
 * keeps the question the one that matters — did the draft follow the brief?
 */
function checkDirectives(sideA: Side, sideB: Side): DirectiveResult[] {
  const pairs: { directive: Directive; targets: ParsedDoc[] }[] = [
    ...sideA.directives.map((directive) => ({ directive, targets: sideB.docs })),
    ...sideB.directives.map((directive) => ({ directive, targets: sideA.docs })),
  ];

  return pairs.map(({ directive, targets: all }) => {
    const targets = all.filter((d) => d.fileName !== directive.file);
    if (!targets.length) {
      return {
        directive,
        verdict: 'unchecked' as const,
        detail: 'No document on the other side to check this against.',
      };
    }
    const names = targets.map((t) => t.fileName).join(', ');

    switch (directive.forbid.kind) {
      case 'email': {
        const target = directive.forbid.value!.toLowerCase();
        const hits = targets.filter((d) => printedText(d).toLowerCase().includes(target));
        return {
          directive,
          verdict: hits.length ? 'violated' : 'ok',
          detail: hits.length
            ? `${directive.forbid.value} is printed on ${hits.map((h) => h.fileName).join(', ')}, but the instruction says to keep it off.`
            : `${directive.forbid.value} does not appear on ${names}. Correct.`,
        };
      }
      case 'hsCodes': {
        const hits = targets
          .map((d) => ({ file: d.fileName, codes: findHsCodes(printedText(d)) }))
          .filter((h) => h.codes.length);
        return {
          directive,
          verdict: hits.length ? 'violated' : 'ok',
          detail: hits.length
            ? hits.map((h) => `${h.file} prints HS codes ${h.codes.join(', ')}`).join('; ') + '. The instruction says not to show them.'
            : `No HS codes found on ${names}. Correct.`,
        };
      }
      default:
        return {
          directive,
          verdict: 'unchecked' as const,
          detail: 'Could not work out what this instruction refers to — read it and check by hand.',
        };
    }
  });
}

/**
 * A B/L states the cargo totals twice: in the cargo boxes and again on the
 * container/seal line. Disagreement between the two is an error in that document
 * itself, independent of anything it is compared with.
 */
function checkInternal(docs: ParsedDoc[]): InternalIssue[] {
  const issues: InternalIssue[] = [];
  const pairs: { label: string; key: FieldKey; re: RegExp; comparator: 'number' | 'packages' }[] = [
    { label: 'Gross weight', key: 'grossWeight', re: /([\d,]+(?:\.\d+)?)\s*KGS?\b/i, comparator: 'number' },
    { label: 'Measurement', key: 'measurement', re: /([\d,]+(?:\.\d+)?)\s*CBM\b/i, comparator: 'number' },
    { label: 'No. of packages', key: 'packages', re: /(\d[\d,]*)\s*(?:CTNS?|CARTONS?|PKGS?|PACKAGES?|PLTS?|PALLETS?|BAGS?|ROLLS?|PCS)\b/i, comparator: 'packages' },
  ];

  for (const doc of docs) {
    // The recap line: a slash-joined summary, with or without a container number.
    const line = doc.text.split('\n').find((l) => /(^|\s|\/)([A-Z]{4}\d{7})?\s*\/\s*\d{2}'?\s?(GP|HQ|HC|RF|NOR)/i.test(l));
    if (!line) continue;
    for (const p of pairs) {
      const onLine = line.match(p.re)?.[0];
      const inBox = doc.fields[p.key]?.raw;
      if (!onLine || !inBox) continue;
      const x = normalizeFor(p.comparator, onLine);
      const y = normalizeFor(p.comparator, inBox);
      if (x && y && x !== y) {
        issues.push({
          file: doc.fileName,
          label: p.label,
          values: [inBox.trim(), onLine.trim()],
          detail: `${doc.fileName} states "${inBox.trim()}" in its cargo box but "${onLine.trim()}" on its own container line.`,
        });
      }
    }
  }
  return issues;
}

/**
 * Pair discovered (non-curated) fields across the two sides by their exact
 * label. These are compared as plain text — they have no comparator, no aliases —
 * and reported apart from the checked fields so a fuzzy extra is never mistaken
 * for a verified one.
 */
function matchDiscovered(a: Side, b: Side): DiscoveredResult[] {
  const byKey = new Map<string, DiscoveredResult>();
  for (const field of a.discovered) {
    byKey.set(field.key, { label: field.label, a: field, b: null, verdict: 'a_only' });
  }
  for (const field of b.discovered) {
    const existing = byKey.get(field.key);
    if (existing) {
      existing.b = field;
      existing.verdict = normText(existing.a!.value) === normText(field.value) ? 'match' : 'mismatch';
    } else {
      byKey.set(field.key, { label: field.label, a: null, b: field, verdict: 'b_only' });
    }
  }
  // Surface disagreements and both-sides matches first; lone extras after.
  const order = { mismatch: 0, match: 1, a_only: 2, b_only: 2 };
  return [...byKey.values()].sort((x, y) => order[x.verdict] - order[y.verdict]);
}

const NO_ASSIST: AssistReport = {
  used: false, provider: 'none', docs: [], filled: [], reasons: ['Rules only.'],
};

export function compareSides(sideA: Side, sideB: Side, assist: AssistReport = NO_ASSIST): ComparisonReport {
  const fields = FIELD_SPECS.map((spec) => compareField(spec, sideA, sideB));
  const directives = checkDirectives(sideA, sideB);
  const internal = checkInternal([...sideA.docs, ...sideB.docs]);
  const discovered = matchDiscovered(sideA, sideB);

  const count = (v: Verdict) => fields.filter((f) => f.verdict === v).length;
  return {
    sideA, sideB, fields, directives, internal, discovered, assist,
    summary: {
      mismatches: count('mismatch'),
      missing: count('missing_on_b') + count('missing_on_a'),
      equivalent: count('equivalent'),
      matches: count('match'),
      violations: directives.filter((d) => d.verdict === 'violated').length
        + internal.length + sideA.conflicts.length + sideB.conflicts.length,
    },
  };
}
