# Stage 3: Translate Diagrams

Stage 3 translates text recursively across a selected folder of Adobe Illustrator files.

Requests include only the diagram-relevant shared editorial rules and the
selected language's conventions. The job records the policy hash, and each
request verifies it again. If a book has no diagrams, skip this stage entirely;
do not create or edit artwork merely to satisfy the pipeline sequence.

- `Code/Illustrator_Translate_Diagrams_Batch.cjs` is the Node.js controller.
- `Code/Illustrator_Translate_Diagrams.jsx` is the Illustrator worker launched by the controller.
- `Code/DiagramLedger.cjs` reads, verifies and updates the book's diagram text ledger.
- The local `Reference/New Acronyms Symbols.xlsx` supplies diagram-specific labels.
- The local Stage 1 book map selects the canonical word and acronym runtime JSON.

## Ledger mode

A ledger records the text of every diagram in a book, so a later language is
translated from that record instead of exporting the text again. Ledger mode is
opt-in; without `--ledger` the stage scans the artwork as before.

```powershell
$env:AI_TARGET_LANGUAGE = 'German'
$env:AI_BOOK = 'FPST'
node '.\03 Translate Diagrams\Code\Illustrator_Translate_Diagrams_Batch.cjs' --check      # read-only, no Adobe
node '.\03 Translate Diagrams\Code\Illustrator_Translate_Diagrams_Batch.cjs' --ledger
```

The ledger defaults to `Ledgers/<BOOK>-Diagram-Text-Ledger.json`. Use
`--ledger=<path>` or `AI_DIAGRAM_LEDGER` for another location.

What changes in ledger mode:

- The ledger is authoritative for source text. Every input diagram must still
  match the hash recorded for it, so start each language from a pristine copy of
  the recorded source. A revised or already translated diagram stops the run
  before Illustrator is launched.
- The worker locates each ledger line in the document and verifies it, instead
  of exporting text from the artwork. A line that has moved, changed, or gone
  missing stops the run: nothing is applied and no file is published.
- Only text without a recorded translation for the target language is sent to
  the model. Re-running a language after editing its translations in the ledger
  re-applies the reviewed text instead of paying for another query.
- Translations are written back into the ledger after each diagram is
  published, guarded against concurrent edits. Commit the ledger with the run
  that produced it.
  Version 1.4.1 corrects the write-back to use that diagram's matched entry;
  an offline regression verifies other diagrams remain unchanged.
- Text classified as prose — Open Sans, ChakraPetch and League Gothic — is
  translated. Source Code Pro text continues to resolve from the acronym-symbol
  workbook. The legacy scanner recognises the same prose families.

An unrecognised font fails the ledger build rather than being guessed at. See
`Ledgers/README.md` for the format and `DATA-LICENCE.md` for the content terms.

Run from the repository root:

Save and close existing Illustrator documents first. Each run uses separate
coordination files. The worker opens the original but saves only a new sibling
`*.codex-diagram-*.ai` staging file. After the worker closes it, the controller
rechecks the frontier and publishes through a hash-guarded file transaction.
Staging files are excluded from discovery. Any failure stops the batch; the
controller does not force-kill Illustrator or automatically retry an uncertain
save. An interrupted publication journal or staged output must be reconciled
before retrying that file. Keep its recovery evidence until the intended version
has been verified. Native Illustrator rendering still requires a desktop check.

```powershell
node '.\03 Translate Diagrams\Code\Illustrator_Translate_Diagrams_Batch.cjs'
```

For a readiness check that does not launch Illustrator:

```powershell
$env:AI_TARGET_LANGUAGE = 'French'
$env:AI_BOOK = 'DEMO'
node '.\03 Translate Diagrams\Code\Illustrator_Translate_Diagrams_Batch.cjs' --check
```

The controller discovers `.ai` files in nested folders, runs one Illustrator session, and returns a failed process result if any diagram fails. It uses only the ChatGPT-authenticated Codex subscription. Before each model request and retry, it freshly queries OpenAI's official frontier metadata and the live subscription catalog, verifies the exact model and `xhigh`, and records the resolution. Failed discovery, an unavailable frontier, or a model change stops the entire run without another model query or file retry. No bundled/local model catalog, paid API credentials, or fallback model is accepted. See the root README for live-discovery requirements. Reference workbooks, Adobe files, generated scans, translations, logs, and temporary files are local-only inputs or outputs.
