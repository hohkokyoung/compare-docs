import type { Directive, DiscoveredField, Extracted, FieldKey, ParsedDoc, Side, SideConflict } from './types';
import { FIELD_SPECS, labelFor } from './fields';
import { normalizeFor, normText } from './normalize';
import { discoverFields } from './extract/discover';

const SPEC_BY_KEY = new Map(FIELD_SPECS.map((s) => [s.key, s]));

/** Compare two raw values the way the field's own comparator would. */
function agree(key: FieldKey, x: string, y: string): boolean {
  const comparator = SPEC_BY_KEY.get(key)?.comparator ?? 'text';
  const nx = normalizeFor(comparator, x);
  const ny = normalizeFor(comparator, y);
  if (nx === null || ny === null) return normText(x) === normText(y);
  return nx === ny;
}

/**
 * Merge the documents dropped on one side into a single set of fields.
 *
 * A side may hold a booking confirmation, a shipping instruction and a packing
 * list at once; between them they describe one shipment. The first document to
 * state a field wins, and any later document that states it *differently* is
 * recorded as a conflict — a disagreement within one side is worth knowing about
 * before the two sides are compared at all.
 */
export function bundleSide(label: string, docs: ParsedDoc[]): Side {
  const fields: Partial<Record<FieldKey, Extracted>> = {};
  const conflicts: SideConflict[] = [];
  const seenDirective = new Set<string>();
  const directives: Directive[] = [];

  for (const doc of docs) {
    for (const [key, value] of Object.entries(doc.fields) as [FieldKey, Extracted][]) {
      const held = fields[key];
      if (!held) {
        fields[key] = { ...value, file: doc.fileName };
        continue;
      }
      if (agree(key, held.raw, value.raw)) continue;

      const existing = conflicts.find((c) => c.key === key);
      if (existing) {
        if (!existing.values.some((v) => v.raw === value.raw)) {
          existing.values.push({ file: doc.fileName, raw: value.raw });
        }
      } else {
        conflicts.push({
          key,
          label: labelFor(key),
          values: [
            { file: held.file ?? '?', raw: held.raw },
            { file: doc.fileName, raw: value.raw },
          ],
        });
      }
    }

    for (const d of doc.directives) {
      const id = `${d.forbid.kind}:${d.forbid.value ?? d.raw}`.replace(/\s+/g, '').toUpperCase();
      if (seenDirective.has(id)) continue;
      seenDirective.add(id);
      directives.push({ ...d, file: doc.fileName });
    }
  }

  const discovered: DiscoveredField[] = [];
  const seenLabel = new Set<string>();
  for (const doc of docs) {
    for (const field of discoverFields(doc.text, doc.fileName)) {
      if (seenLabel.has(field.key)) continue;
      seenLabel.add(field.key);
      discovered.push(field);
    }
  }

  return {
    label,
    docs,
    fields,
    directives,
    emails: [...new Set(docs.flatMap((d) => d.emails))],
    text: docs.map((d) => d.text).join('\n'),
    warnings: docs.flatMap((d) => d.warnings.map((w) => (w.includes(d.fileName) ? w : `${d.fileName}: ${w}`))),
    conflicts,
    discovered,
  };
}
