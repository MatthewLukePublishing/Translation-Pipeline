# Stage 3: Translate Diagrams

Stage 3 translates text recursively across a selected folder of Adobe Illustrator files.

Each model request carries the complete diagram-relevant shared editorial rules
and the selected language's conventions once, shared by every diagram in that
request. The job records the policy hash, and each request verifies it again. If
a book has no diagrams, skip this stage entirely; do not create or edit artwork
merely to satisfy the pipeline sequence.

- `Code/Illustrator_Translate_Diagrams_Batch.cjs` is the Node.js controller.
- `Code/Illustrator_Translate_Diagrams.jsx` is the Illustrator worker launched by the controller.
- `Code/DiagramLedger.cjs` reads, verifies and updates the book's diagram text ledger.
- The local `Reference/New Acronyms Symbols.xlsx` supplies diagram-specific labels.
- The local Stage 1 book map selects the canonical word and acronym runtime JSON.

The public MFP/FPST glossary snapshot can supply those runtimes; follow the
Stage 1 guide and published-map example. When a book uses `publishedSource`,
Stage 3 checks that its runtime is current before any model or Adobe operation.
Ambiguous glossary senses are passed as context, not forced substitutions.
The diagram-specific symbol workbook remains a separate input.

## Source selection

The stage reads the diagram text from one of two sources, and it never chooses
between them on its own:

1. **Reuse the recorded ledger** — translate from
   `Ledgers/<BOOK>-Diagram-Text-Ledger.json`, so the text is never exported from
   the artwork again.
2. **Extract from the artwork** — scan the selected folder for `.ai` files and
   export the text from Illustrator, as the stage has always done.

An interactive run with no source flag asks which one to use, and offers no
default:

```text
Diagram text source (no default):
1. Reuse the recorded diagram text ledger
2. Extract text from the Illustrator artwork
Choose 1 or 2 (q to cancel):
```

The controller also accepts the words `ledger` and `extract` in place of `1` and
`2`, in any case. A blank or unrecognised answer asks again. `q`, end of input
(EOF) and Ctrl-C cancel the run before Illustrator starts.

Choose the source up front instead of answering the prompt:

- `--ledger` reuses the book's ledger at
  `Ledgers/<BOOK>-Diagram-Text-Ledger.json`.
- `--ledger=<path>` reuses a ledger stored at another location.
- `--extract` extracts the text from the Illustrator artwork.

`--ledger` and `--extract` together is an error. A noninteractive run, and any
`--check` run, must name `--ledger` or `--extract`; the controller refuses to
guess when it cannot ask. `AI_DIAGRAM_LEDGER` sets only the ledger path, so it
never selects the ledger source by itself.

Both sources share the same request handling: compact JSON prompts, short
temporary ids that are mapped back strictly to the original diagram and item
ids, and numeric-only labels completed locally instead of being sent for
translation. An exact, case-sensitive full glossary label is completed locally
too, but only when its target is unique, no contextual sense applies, and the
ordinary glossary and acronym-lock processing already yields that exact target.
Phrases, changed case, conflicting or nested locks, and ambiguous terms stay
with the model. Ledger mode groups the pending text into bounded multi-diagram
requests before Illustrator starts; extraction mode keeps its per-diagram
request workflow.

```powershell
$env:AI_TARGET_LANGUAGE = 'German'
$env:AI_BOOK = 'FPST'
# Read-only readiness check: names the source instead of prompting
node '.\03 Translate Diagrams\Code\Illustrator_Translate_Diagrams_Batch.cjs' --check --ledger
# Reuse the recorded ledger
node '.\03 Translate Diagrams\Code\Illustrator_Translate_Diagrams_Batch.cjs' --ledger
# Or extract the text from the artwork
node '.\03 Translate Diagrams\Code\Illustrator_Translate_Diagrams_Batch.cjs' --extract
```

## Ledger mode

A ledger records the text of every diagram in a book, so a later language is
translated from that record instead of exporting the text again. The ledger
defaults to `Ledgers/<BOOK>-Diagram-Text-Ledger.json`; use `--ledger=<path>` or
`AI_DIAGRAM_LEDGER` for another location.

Ledger mode translates the pending text in bounded multi-diagram requests
before Illustrator starts, then applies each result to its own diagram:

- A request covers several diagrams of one book and language. It closes at the
  first limit reached: 8 diagrams, 160 pending items, or 24,000 serialized
  source characters. A single diagram larger than a limit still goes as one
  standalone request, so no diagram is ever split across requests. These are
  internal defaults, not user settings.
- Each request carries the complete language and editorial rules once, shared by
  every diagram in it. Diagram context stays separate: items keep their own
  diagram and occurrence identity, and identical strings in different diagrams
  or positions are never merged into one occurrence.
- Numeric-only labels are completed locally and are not sent for translation,
  including inside a mixed request that also holds real prose.
- The model answers with short temporary ids, which are mapped back strictly to
  the original diagram and item ids before any text is applied.
- Prompts are compact JSON, and contextual glossary senses travel only with the
  terms they explain.

What stays the same in ledger mode:

- The ledger is authoritative for source text. Every input diagram must still
  match the hash recorded for it, so start each language from a pristine copy of
  the recorded source. A revised or already translated diagram stops the run
  before Illustrator is launched.
- The one Illustrator session still opens each diagram, locates every recorded
  line in the artwork, and verifies it instead of exporting the text. A line
  that has moved, changed, or gone missing stops the run: nothing is applied and
  no file is published. Batch translation does not remove those artwork reads,
  and native rendering still needs the desktop check.
- Within that session the worker preflights every replacement range before it
  changes anything, builds each frame's final text in memory, and writes a
  changed frame once; a frame whose text does not change is left unassigned. The
  resulting text is unchanged; only the number of DOM writes drops. Native
  Illustrator font, layout, and timing behaviour has not been benchmarked, so no
  Adobe speedup is claimed.
- Only text without a recorded translation for the target language is
  translated; approved translations already recorded in the ledger are reused
  unchanged. Re-running a language after editing its translations in the ledger
  re-applies the reviewed text instead of paying for another query.
- Translations are written back into the ledger only after that diagram's
  artwork has been published, never on the model response alone, and the write
  is guarded against concurrent edits. Commit the ledger with the run that
  produced it. Version 1.4.1 corrected the write-back to use that diagram's
  matched entry; an offline regression verifies other diagrams remain
  unchanged.
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
# With no source flag the run asks for the ledger or the artwork first.
node '.\03 Translate Diagrams\Code\Illustrator_Translate_Diagrams_Batch.cjs'
```

For a readiness check that does not launch Illustrator, name the source too:

```powershell
$env:AI_TARGET_LANGUAGE = 'French'
$env:AI_BOOK = 'DEMO'
node '.\03 Translate Diagrams\Code\Illustrator_Translate_Diagrams_Batch.cjs' --check --extract
```

The controller discovers `.ai` files in nested folders, runs one Illustrator session, and returns a failed process result if any diagram fails. It uses only the ChatGPT-authenticated Codex subscription. Before each model request and retry, it freshly queries OpenAI's official frontier metadata and the live subscription catalog, verifies the exact model and `xhigh`, and records the resolution. Failed discovery, an unavailable frontier, or a model change stops the entire run without another model query or file retry. No bundled/local model catalog, paid API credentials, or fallback model is accepted. See the root README for live-discovery requirements. Reference workbooks, Adobe files, generated scans, translations, logs, and temporary files are local-only inputs or outputs.

Recovery evidence and the run's `performance.json` stay in private run scratch.
That file records the query count, prompt character count, and elapsed
milliseconds; it is not an exact token count, and the program publishes no
translation or Adobe timing benchmark.

Offline evidence from the checked-in FPST ledger and the published French
glossary: the older plan produced 109 one-diagram requests, where the batched
plan needs 19 requests, and it sends 1,521 model-translated items instead of
1,963 model output items. No diagram translation was actually run for these
figures, and the character counts behind them are not token counts.
