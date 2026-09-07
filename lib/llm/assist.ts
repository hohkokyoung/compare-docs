import type { AssistReport, FieldKey, ParsedDoc, Side } from '../types';
import type { Provider } from './provider';

/**
 * Fields every shipping document names, whatever its type. Checked against a
 * whole side, not a single file: with several documents per side, one may
 * legitimately omit what another supplies.
 *
 * Weight and volume are deliberately absent. A certificate of origin states
 * weight but never cubic metres, and treating that as a failed reading would
 * send an image to a model on every certificate — the opposite of the narrow
 * trigger this is meant to be. A field genuinely absent from the paperwork is
 * reported by the comparison instead.
 */
const CORE: FieldKey[] = ['consignee', 'packages', 'goods'];
/** A discharge port under any of its names satisfies the destination requirement. */
const DESTINATION: FieldKey[] = ['portOfDischarge', 'placeOfDelivery', 'finalDestination'];

/** Warnings that mean a reading is doubtful even where fields were found. */
const DOUBT = [/not read into any field/, /realigned/, /not in the alias table/, /read as empty/, /no consignee/];

export interface Need {
  /** Core fields absent from the side as a whole. */
  missing: FieldKey[];
  /** Documents whose own reading is suspect. */
  doubtful: ParsedDoc[];
  reasons: string[];
}

export function assessSide(side: Side): Need {
  const missing = CORE.filter((k) => !side.fields[k]);
  if (!DESTINATION.some((k) => side.fields[k])) missing.push('portOfDischarge');

  const reasons: string[] = [];
  if (missing.length) reasons.push(`${side.label}: rules found no ${missing.join(', ')}.`);

  const doubtful = side.docs.filter((d) => d.warnings.some((w) => DOUBT.some((re) => re.test(w))));
  for (const d of doubtful) reasons.push(`${side.label}: ${d.fileName} was read with doubt.`);

  return { missing, doubtful, reasons };
}

/**
 * Fill gaps the rules left, and only gaps. A value the rules produced is never
 * overwritten: those come from tested, deterministic code, and a model's guess
 * is not an improvement on a known-good reading.
 */
export async function runAssist(
  sides: Side[],
  provider: Provider | null,
): Promise<{ sides: Side[]; assist: AssistReport }> {
  const needs = sides.map(assessSide);
  const reasons = needs.flatMap((n) => n.reasons);
  const assist: AssistReport = {
    used: false,
    provider: provider?.name ?? 'none',
    docs: [],
    filled: [],
    reasons,
  };

  if (!reasons.length) {
    assist.reasons = ['Every document was read cleanly by the rules; no model was called.'];
    return { sides, assist };
  }
  if (!provider) {
    assist.reasons.push('No model configured (set GEMINI_API_KEY to enable assistance).');
    return { sides, assist };
  }

  const out: Side[] = [];
  for (let i = 0; i < sides.length; i++) {
    const side = sides[i];
    const need = needs[i];
    if (!need.reasons.length) { out.push(side); continue; }

    // Ask the doubtful documents first; if core fields are still missing, ask the
    // rest of the side's documents too.
    const queue = [...need.doubtful];
    if (need.missing.length) {
      for (const d of side.docs) if (!queue.includes(d)) queue.push(d);
    }

    const docs = [...side.docs];
    const fields = { ...side.fields };
    for (const doc of queue) {
      if (!doc.text.trim()) {
        assist.reasons.push(`${doc.fileName}: no text to send — OCR the file first.`);
        continue;
      }
      const wanted = need.missing.length ? need.missing : CORE;
      const stillWanted = wanted.filter((k) => !fields[k]);
      const ask = need.doubtful.includes(doc) && !stillWanted.length ? CORE : stillWanted;
      if (!ask.length) continue;

      try {
        const got = await provider.extract({ kind: doc.kind, text: doc.text, wanted: ask });
        assist.used = true;
        assist.docs.push(doc.fileName);
        const index = docs.findIndex((d) => d === doc);
        const docFields = { ...doc.fields };
        for (const [key, raw] of Object.entries(got) as [FieldKey, string][]) {
          if (fields[key]) continue; // rules win
          const value = { raw: raw.replace(/\\n/g, '\n'), where: `read by ${provider.name}`, source: 'llm' as const, file: doc.fileName };
          fields[key] = value;
          docFields[key] = value;
          assist.filled.push({ file: doc.fileName, key });
        }
        docs[index] = { ...doc, fields: docFields };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        assist.reasons.push(`${doc.fileName}: model call failed (${message}). Rules-only result shown.`);
      }
    }
    out.push({ ...side, docs, fields });
  }

  return { sides: out, assist };
}
