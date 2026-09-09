# Translation Pipeline

Translation Pipeline is a Windows-oriented publishing workflow for glossary maintenance, ICML text translation, Illustrator diagram text, and spreadsheet-based comic captions. It treats each translation as an auditable job, validates content identifiers and workbook integrity, and uses recoverable transactions when several related files must change together.

The repository contains source code, synthetic examples, and offline tests. It intentionally excludes books, translations, glossary workbooks, Adobe files, production outputs, job records, reports, logs, credentials, and historical archives.

## Requirements

- Windows 10 or later.
- PowerShell 7 (`pwsh`).
- Node.js 24 LTS or later and npm.
- Git when running the distribution-safety test.
- The official Codex CLI, authenticated with **Sign in with ChatGPT**, for translation stages.
- Microsoft Excel is optional; the pipeline reads and writes XLSX through Node.js libraries.
- Adobe InDesign for source export, link refresh and final layout operations.
  ICML import and spacing rules run offline without Adobe.
- Adobe Illustrator for diagram translation.

The offline test suite does not require Codex, credentials, network access, Microsoft Office, InDesign, or Illustrator.

## Install

Clone the repository and install the exact locked dependencies:

```powershell
git clone https://github.com/MatthewLukePublishing/translation-pipeline.git
Set-Location .\translation-pipeline
npm ci --ignore-scripts
npm test
```

`npm test` syntax-checks the maintained Node.js and PowerShell source and runs synthetic regression, transaction-recovery, path-safety, and public-distribution tests. It never launches Adobe applications or calls a model.

## Configure inputs

All real inputs are local and ignored by Git. Start with the files under `examples`:

1. Copy `examples/book_glossary_map.example.json` to `01 Translate Glossaries/book_glossary_map.json` and replace the `DEMO` paths with your own book resources.
2. Create `01 Translate Glossaries/<family>/Glossary.xlsx` with `Acronyms` and `Words` worksheets. Each begins with `English`, `English Definition`, and paired term/definition columns for every target language.
3. Put the generated `acronyms.json` and `words.json` under the family’s `Runtime` folder. Synthetic JSON shapes are included in `examples`.
4. Put the source four-column workbook, ICML ZIP, and optional standard INDD under `02 Translate Text/Origin Files`.
5. If the book needs mandatory terminology rules, copy `examples/book_translation_instructions.example.json` to `02 Translate Text/Book Instructions/<BOOK>.json` and reference it from the map.
6. Set each book’s product paths in the map. You can also pass `-ProductsRoot` to the launcher or set `TRANSLATION_PRODUCTS_ROOT`.

The four text-workbook headers are:

```text
ParagraphStyleRange id
ParagraphStyleRange content
Content tag
Content content
```

Columns A and C are protected identifiers. Do not renumber or edit them in a translated workbook.

## Usage

Run commands from the repository root. A normal text job follows this sequence:

```powershell
& '.\Run-Translation-Job.ps1' -Action Prepare -Book DEMO -Language French -EditionName 'French' -GlossaryProfile 'French'
& '.\Run-Translation-Job.ps1' -Action Translate
& '.\Run-Translation-Job.ps1' -Action Import
& '.\Run-Translation-Job.ps1' -Action Finalize
& '.\Run-Translation-Job.ps1' -Action Complete
```

Use `-Action Status` at any time. If Adobe relinking was deferred because an InDesign document was open, save and close it, then use `-Action Export` before continuing. Use `-Action Validate` after an authorized workbook correction. `Deactivate` and `Activate` switch the single active-job pointer without moving a self-contained edition.

Other stages:

```powershell
# Build or check runtime glossaries
node '.\01 Translate Glossaries\Code\Shared\Build_Glossary_Runtime.cjs'
node '.\01 Translate Glossaries\Code\Shared\Build_Glossary_Runtime.cjs' --check

# Translate Illustrator diagrams (interactive)
node '.\03 Translate Diagrams\Code\Illustrator_Translate_Diagrams_Batch.cjs'

# Translate the configured comic-caption workbook
node '.\04 Translate Comic Captions\Code\Translate_Comic_Captions.js'
```

Read the stage README files before preparing data or launching an Adobe application.

## Editorial rules across the pipeline

`Code/TranslationEditorialRules.json` is the versioned runtime policy for English,
French, German, Spanish, Portuguese, Dutch, Italian, Turkish, Polish and Swedish.
It distinguishes the supplied house style from native-language adaptations and
records its source references. The original private workbook is not distributed.
Protected source sections and book-specific terminology take precedence.

- Glossary authoring: `Build_Glossary_Runtime.cjs --rules French` prints only the
  applicable glossary guidance. Building runtime JSON never restyles approved terms.
- Text, diagrams and captions: prompts receive their own stage's rules and a policy
  hash. Text/caption postprocessing normalizes applicable date and symbol spacing;
  text QA checks mechanical typography outside protected source and glossary locks.
- ICML import: the workbook must have passed QA under the current policy. The
  recoverable import changes matching Content IDs, then runs every applicable
  spacing formula directly on ICML text before writing the files. Adjacent style
  segments are handled together; XML, IDs, formatting, credits and panel-generated
  references remain protected. The report records this spacing-only derivation
  from the approved workbook and binds it to the exact resulting ICML hashes.
- InDesign finalization: checks layer order and body-indent styles and emits exact
  encoded definitions for the **Cross-References panel > Define Cross-Reference
  Formats > Definition** editor. All language-specific cross-reference changes
  must use that panel encoder, never scripted building-block edits or flattened
  reference text. Update only the indicated references using the panel, then save
  and close the document. The finalizer verifies the result read-only.
  Formats used exclusively by protected paragraphs
  remain unchanged. Mixed protected/unprotected formats require explicit review.
- Offline GREP: translation postprocessing runs the shared and target-language
  expressions before workbook export; import handles context across style runs.
  Finalize and Complete verify the exact imported ICML set without invoking the
  InDesign GREP interface. Every applicable expression, including zero matches,
  and every language exclusion is recorded. See the
  [text-stage guide](02%20Translate%20Text/README.md#editorial-rules-and-finishing-order).

Apply revised rules to an already accepted translation with the appropriate job
active:

```powershell
& '.\Run-Translation-Job.ps1' -Action ReviewRules -MaxBatches 1
& '.\Run-Translation-Job.ps1' -Action Translate
& '.\Run-Translation-Job.ps1' -Action Import
& '.\Run-Translation-Job.ps1' -Action Finalize
& '.\Run-Translation-Job.ps1' -Action Complete
```

`ReviewRules` transactionally snapshots the accepted workbook and policy and retains
the previous ICML import evidence. It reviews every eligible group against that
baseline; protected groups remain unchanged. It does not itself overwrite ICML or
InDesign output. QA, import, layout and completion are bound to the current policy.

Mechanical QA is not proof of idiom, meaning or section-wide acronym usage: those
remain linguistic-review responsibilities. Caption placement/stacking and TOC
numbering instructions apply when those objects are inserted, reordered or rebuilt;
translation does not reorder existing artwork or rebuild a TOC automatically.
Preserved style ranges retain bold emphasis and italic variables. The final layout
report identifies the automated checks separately from this retained workflow guidance.

Before a panel edit, retain one verified INDD recovery copy in the private job
state. Do not discard unsaved Adobe work or delete recovery evidence during an
interruption. Unknown layout styles/formats fail closed instead of being guessed.

## Codex model and authentication policy

Translation is restricted to the ChatGPT-authenticated Codex harness. The pipeline:

- queries OpenAI's live `latestModelInfo.model` metadata to identify the official frontier, then queries the authenticated Codex service to verify access to that exact model and `xhigh` support;
- records the exact resolved model in the job record;
- repeats both live requests before every new model query, including retries and rechecks, and fails if the frontier changes;
- requires independent `xhigh` reasoning for primary translation/review calls and rechecks;
- requires `codex login status` to report ChatGPT sign-in;
- removes API-key and alternate-endpoint variables from every model subprocess; and
- has no active paid API provider, API-key fallback, alternate endpoint, or older-model fallback.

No model is installed locally. The Codex CLI is the client for hosted model queries and ChatGPT sign-in. Model discovery never uses a bundled catalog, a local model cache, catalog priority, or a saved job's model as its authority. Every discovery request disables caching and rejects redirects.

The official model authority is [OpenAI's live model guidance](https://developers.openai.com/api/docs/guides/latest-model). Availability comes from the same ChatGPT subscription discovery service used by the official Codex client. The resolver reads the existing Codex-managed ChatGPT session from its vendor-owned `auth.json` in memory; it never copies or logs credentials. Keyring-only sessions are not supported by this resolver and cause it to stop.

If either live request, metadata validation, authentication, or `xhigh` support fails, the job stops before sending a query. A current frontier that is missing from the account's live catalog is a blocking failure, even if an older model is available. Job and query records include the exact model, resolution time, source URLs, client version, and metadata hashes; saved resolutions are evidence only and are never reused for model selection.

## Outputs and recovery

Production editions are self-contained beneath the configured book `Interiors` folder. Administrative job state is stored under `02 Translate Text/Jobs`; the current pointer is `02 Translate Text/Active Job.json`. Generated workbooks, reports, model state, diagram logs, and caption outputs remain local and are ignored by Git.

Workspace preparation, glossary runtime publication, ICML import, caption completion, diagram publication, and job archival use recoverable transactions. File-set recovery checks the entire set's original and replacement hashes before changing anything. Conflicting edits, missing required backups, a live transaction owner, or older journals without hashes stop recovery and retain the evidence for manual reconciliation. Source packages and existing production editions are not overwritten merely because a new job is prepared.

Keep input workbooks and job configuration closed to edits during translation. Text and caption publication refuse changed inputs/outputs rather than overwrite newer work. Readiness checks are read-only and refuse pending recovery journals. See [the code review](CODE_REVIEW.md) for the v1.3.1 corrections and validation limits.

## Troubleshooting

- **No glossary mapping:** create `01 Translate Glossaries/book_glossary_map.json` from the example and verify its relative paths and profile names.
- **Products root rejected:** pass an absolute `-ProductsRoot`, set `TRANSLATION_PRODUCTS_ROOT`, or use the documented sibling `Products` layout.
- **Codex login rejected:** run `codex login`, choose Sign in with ChatGPT, and confirm with `codex login status`. API-key authentication is intentionally refused.
- **Frontier model changed:** restart the job so every query is based on one newly recorded model resolution. The pipeline will not silently continue across a frontier change.
- **Frontier unavailable or live discovery failed:** check connectivity and the Codex ChatGPT sign-in. The current frontier must appear in the service's response for this account and client. Re-running discovery must succeed before translation can continue; the program will not substitute an older model or a cached list.
- **Workbook fails QA:** keep columns A and C unchanged, remove formulas and Excel error cells, and rerun `-Action Validate`. A workbook changed after import must be reimported.
- **Import is stale:** restore the exact QA-passed workbook and ICML snapshot, or validate and import the authorized new revision.
- **Adobe step will not start:** save and close unrelated Adobe documents, confirm the configured document and asset paths, then retry the same action. Never run concurrent InDesign operations.
- **Interrupted multi-file operation:** after the original process has stopped, rerun the same action. If recovery reports a conflict or a legacy journal, compare the retained originals, staged replacements and current files before explicitly choosing what to restore. Never delete the journal or backups to bypass the safety check.

## Repository safety

The `.gitignore` and public-distribution test reject credentials, personal workstation paths, private data folders, common publishing binaries, generated state, and oversized files. Before contributing, run `npm test` and inspect `git diff --cached` so that only maintained source or synthetic examples are proposed.

## GitHub publication contract

The canonical public repository is
`https://github.com/MatthewLukePublishing/translation-pipeline`. After an
authorized maintained source or documentation change—including every new
executable or script—passes the relevant offline tests and Publishing
consolidation, commit and push it to that repository in the same task. A change
to distributed behavior must also receive a new version tag and stable GitHub
release. Verify GitHub CI after pushing.

Never publish ignored inputs, generated translations, Adobe files, job records,
credentials, authentication state, archives, or private production data. A
failed validation or push must be reported; it must not be described as
published.

## Management contract

- Primary entry point: `Run-Translation-Job.ps1`
- Cross-stage code: `Code` (shared infrastructure only; stage-specific code remains with its stage).
- Production outputs: `<Book>\Interiors\<Edition>` (isolated from the English source).
- Current production and ad hoc job records: `02 Translate Text\Jobs\<book>\<language>\<job-id>`.
- Legacy production job records: `<Book>\Interiors\<Edition>\Translation Job` (still supported).
- Active-job pointer: `02 Translate Text\Active Job.json` (generated; one at a time).
- Archive boundary: `_Archive`

The archive is local only and is never published.

## Authentication contract

This program must not store secrets or authentication state locally. All current and future credentials, `.env` files, DPAPI blobs, tokens, private keys, cookies, browser profiles, session state, and provider account contexts belong only in `D:\Google Drive\Publishing\Code\Admin\Access`. Code in this program may reference protected loaders or authenticated sessions from that directory but must never duplicate or print secret values.

## License

Released under the [MIT License](LICENSE). You may download, clone, fork, and modify your own copy.
