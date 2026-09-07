# SI / B-L Checker

Compares shipping paperwork against a draft bill of lading and reports every
value that disagrees. Each side accepts **any number of documents** in **Word
(.docx), PDF, Excel (.xlsx) or as a photograph** — a booking, an instruction and
a scanned certificate on one side; the draft B/L on the other.

```bash
npm install
npm run dev        # http://localhost:3737
```

Everything runs locally by default — no API key, no network. See
[Optional model assistance](#optional-model-assistance) for the one case that
can change that, and how it tells you.

## What it does

Every document is read into the same set of fields (consignee, notify party,
ports, vessel, container and seal, packages, weight, measurement, goods, freight
terms …), then compared **after normalisation**, so the noise that isn't a real
discrepancy is filtered out:

| The SI says | The B/L says | Verdict |
|---|---|---|
| `MV DEMO EXPRESS 077E` | `MV DEMO EXPRESS V.001E` | same value |
| `PORT KLANG, MALAYSIA` | `PORT KELANG(N)` | port vs its terminal |
| `…SHAH ALAM SELANGOR MALAYSIA` | `…SHAH ALAM SELANGOR` | same address |
| `8263.00 KGS` | `8263.000KGS` | same value |
| `816 CTNS` | `816CARTONS` | same value |
| `65.44 CBM` | `65.440CBM` | same value |
| `NORTH PORT` | `PORT KELANG(N)` | same value |
| `+60 3-000 0000` | `+603-3888648` | same value |
| `800 CTNS` | `816 CARTONS` | **mismatch** |

Three other checks run alongside the field comparison:

- **Instructions.** Chinese parentheticals such as `(提单不显示海关编码)`
  ("don't print HS codes on the B/L") and `(email : … 只提供不显示在提单)` are
  read as rules from any document, and checked against the *opposite* side. A
  confirmation sheet filed next to the instruction may list HS codes quite
  properly for customs; the question is whether the draft followed the brief.
- **Internal consistency of the B/L.** The cargo boxes and the container/seal
  line both state the weight, volume and carton count; if they disagree, the
  draft contradicts itself regardless of the SI.
- **Recognition noise.** A value read from a photograph is marked *read from
  image*. Where two documents differ only in characters optical recognition
  confuses — `RZ0` for `RZO`, `HO0K` for `HOOK` — that is reported as equivalent
  rather than a discrepancy. Digit-to-digit differences are never folded: `858`
  and `838` stay different, which is the whole point.
- **Additional fields.** Anything the readers find as an explicit `label: value`
  pair that is not one of the curated fields — a carrier line, a sailing date, a
  cut-off date — is surfaced in a separate *Additional fields found* section,
  matched across the two sides by exact label. These are shown but never treated
  like a checked field: no normalisation, no port aliases, no OCR folding. A
  fuzzy extra is never mistaken for a verified one.
- **Agreement within a side.** When several documents sit on the same side they
  are merged into one description of the shipment. If two of them state the same
  field differently — a packing list saying 800 cartons where the instruction
  says 816 — that is reported before the two sides are compared at all.
- **Extraction warnings.** A scanned PDF with no text layer, an unrecognised
  port name, an empty consignee box, a form that had to be realigned, or text
  that belongs to no field is reported rather than silently passed.

A value the B/L carries that the SI never mentions (vessel, S/O number, seal) is
marked *SI silent* rather than flagged — there is nothing to check it against.

## How extraction works

Rules first. A language model is optional, and is consulted only for a document
the rules could not read.

- **B/L (PDF)** — `lib/extract/pdfBl.ts`. The blank form is a background image,
  so the text layer has no labels — only position says which value is which.
  `pdfjs-dist` gives each text run with its coordinates; those are clustered
  into blocks (an address becomes one block, so it travels as a unit), the page
  offset is calibrated so a shifted template realigns instead of misfiling, and
  each block is assigned to a cell of `BOXES`. Values with an unmistakable shape
  (container numbers, weights, freight terms) are *also* matched by regex over
  the whole page. A block that lands in no cell raises a warning rather than
  being dropped. A different carrier's form needs a new `BOXES` map; run
  `npx tsx scripts/margins.ts <file.pdf>` to see how much slack each cell has.
- **Confirmation sheets (Excel)** — `lib/extract/xlsxSheet.ts`. A forwarder's
  提单确认件 is a labelled grid, so extraction follows the labels: `exceljs`
  reads the cells, merged ranges collapse to their top-left, and the value for a
  heading is the cell beneath it (or to its right). Bilingual headings such as
  `Ocean Vessel(船名)/Voy.No.(航次)` are never mistaken for values — in a
  spreadsheet the value always has its own cell.
- **Photographs and scans** — `lib/extract/imageOcr.ts`. There is no text layer,
  so the words are recognised with PaddleOCR (PP-OCRv6) through ONNX: ~6 MB of
  models, cached on first run, entirely on-device afterwards. The page is
  straightened first — tilt is measured by projecting ink onto candidate angles
  and taking the one whose profile is spikiest, which is accurate to a quarter of
  a degree. This matters more than it sounds: before deskewing, **one degree of
  tilt was enough to lose fields**, because pairing a label with its value
  depends on their positions. Recognition returns
  boxes, so labels are paired with values by position — a value sits hard against
  its label, and anything further than 4% of the page width away belongs to the
  next column. Numbered box headings ("2.Products consigned to") are never read
  as values, and a row of three or more headings is recognised as a table header
  whose data rows cannot be paired up by position alone. Where a certificate
  lists per-item weights under a grand total, they are added up and the working
  is reported — but only when every item was read. Three weights out of four
  would produce a total that looks like a discrepancy rather than a bad scan, so
  an incomplete set yields nothing and says why.

  Every value read from an image is checked against the shape it should have
  (`lib/extract/validate.ts`). A gross weight must be a number and a unit; a
  container number must be four letters and seven digits; a discharge port must
  not read as a routing sentence. Positional extraction on a photograph can land
  on the wrong thing, and a rejected value is far better than a confident wrong
  one.
- **SI (Word)** — `lib/extract/docxSi.ts`. `mammoth` extracts the text, labelled
  blocks (`CONSIGNEE:`, `DESCRIPTION :`, …) are read with English and Chinese
  aliases, and quantities are matched by shape anywhere in the document. Word
  files are often double-spaced; `blockBreakGap` detects that rhythm so a single
  blank paragraph is treated as spacing rather than a section break.
Label patterns live in `lib/extract/labels.ts`, shared by the Word and Excel
readers so the two cannot drift apart. English and Chinese are both covered.

- **Ports** — `lib/ports.ts` holds the alias table. An unlisted port resolves to
  `null` and is compared as plain text with a warning, rather than being guessed
  equal to something else.

## Optional model assistance

The app works fully offline with no API key — that is the default, and for a
familiar form it is also the steady state. Assistance exists for the case the
rules cannot cover: an unfamiliar carrier's layout.

Set a key to enable it:

```bash
cp .env.example .env.local   # then paste a key from https://aistudio.google.com/apikey
npm run llm:check            # confirms the key works and lists usable models
```

A model is called **only** when a document trips one of these:

- an expected field the rules did not find (consignee, discharge port, packages,
  weight, measurement, goods, and on the B/L also shipper, vessel, container,
  freight terms);
- a warning that casts doubt on the reading — text that landed in no field, a
  form that needed realigning, a port not in the alias table.

A cleanly-read pair never leaves the machine, and `tests/assist.test.ts` asserts
exactly that. Beyond the trigger, three rules keep it honest:

- **The model only fills gaps.** A value the rules produced is never overwritten
  — deterministic code beats a guess.
- **The model never compares.** It extracts; the tested logic in `compare.ts`
  still decides what matches.
- **A failure is not an error.** A rate limit or outage falls back to the
  rules-only result with a note.

Every value a model supplied is tagged *read by model* in the results, and each
run states plainly whether anything was sent. Note that on Google's free tier,
submitted text may be used to improve their models — which is the reason the
trigger is as narrow as it is. `LLM_ASSIST=off` disables it without removing the
key.

## How well images actually read

Measured against a photograph of a Form E, degraded deliberately
(`npx tsx scripts/robust.ts`). "Absent" means the reader declined to answer;
"wrong" means it answered incorrectly.

| Condition | Right | Absent | Wrong | |
|---|---|---|---|---|
| Heavy JPEG artefacts | 7 | 0 | 0 | safe |
| Blur, dim, low contrast | 7 | 0 | 0 | safe |
| Rotated 3°, 7°, −4° | 6–7 | 0–1 | 0 | safe |
| Rotated 1° | 5 | 1 | 1 | warned |
| Half resolution | 0 | 6 | 1 | warned |

The guarantee the tests enforce is not "always right" — it is **never wrong and
silent**. Degraded input yields less, and whatever it does yield is either
correct or accompanied by a warning. `tests/robust.test.ts` asserts this.

A native PDF or spreadsheet is always better than a photograph of one. The
reader will say when a picture is too poor to trust; take it at its word.

## Why not Tesseract

`tesseract.js` is the obvious npm choice and was measured first. On a 794px-wide
photograph of a Form E it read `(858) CARTONS` as `838`, `5580KGS` as `5380` and
HS code `8302.50` as `8302.30` — across four configurations including upscaling,
the `best` trained models and page-segmentation tuning, it peaked at 9 of 12
critical values. The failures are plausible wrong numbers rather than obvious
garbage, which in a tool built to report numeric discrepancies is worse than not
reading the document at all.

PaddleOCR read every number on the same image correctly, in a third of the time.
Its only slips were single letters (`RZ0` for `RZO`), which the comparison folds.

## Extending it

- New port spelling → add it to a group in `lib/ports.ts`.
- New field label (English or Chinese) → add it to `lib/extract/labels.ts`; all
  readers pick it up. This promotes a field from the *Additional fields* section
  into the checked set, where it gets a comparator and normalisation.
- New package unit → add it to `PACKAGE_UNITS` in `lib/normalize.ts`.
- New field to compare → add a `FieldKey` in `lib/types.ts`, a `FIELD_SPECS`
  entry in `lib/compare.ts`, and extraction in both parsers.
- New carrier's B/L layout → add a `BOXES` map for it.

## Tests

```bash
npm test
```

Covers the normalisers, the alias table, both parsers against the real sample
pair in `fixtures/`, and a set of deliberately corrupted drafts (wrong weight,
wrong carton count, wrong terminal at the right port, transposed address,
missing goods, leaked HS codes and email, a self-contradicting B/L) to prove the
checks fire rather than just passing everything.

`tests/image.test.ts` covers the OCR reader against a photographed certificate of
origin, `tests/xlsx.test.ts` covers the Excel reader against a real confirmation sheet,
and `tests/bundle.test.ts` covers multi-document sides — merging, conflict
detection, a sibling supplying a missing field, and cross-format comparison.

`tests/drift.test.ts` additionally proves the PDF reader survives layout
movement: the whole form shifted up to 40pt in either direction, and a consignee
address up to three lines longer, both still extract all sixteen fields exactly.
`npx tsx scripts/stress.ts` runs the same scenarios as a report.

To inspect a pair from the command line:

```bash
npm run check -- fixtures/si-sample.docx fixtures/confirm-sample.xlsx -- fixtures/bl-sample.pdf
```

Files before the `--` form side A, files after it form side B; each side takes
any mix of formats.

`fixtures/` holds real customer documents — don't publish this repo as-is.
