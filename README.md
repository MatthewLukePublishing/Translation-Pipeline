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
- Adobe InDesign for text export/import and final layout operations.
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

## Codex model and authentication policy

Translation is restricted to the ChatGPT-authenticated Codex harness. The pipeline:

- reads the installed Codex harness model catalog and selects its newest visible frontier model at runtime;
- records the exact resolved model in the job record;
- resolves again immediately before every primary model query and fails if the frontier changes;
- requires independent `xhigh` reasoning for primary translation/review calls and rechecks;
- requires `codex login status` to report ChatGPT sign-in;
- removes API-key and alternate-endpoint variables from every model subprocess; and
- has no active paid API provider, API-key fallback, alternate endpoint, or older-model fallback.

If model resolution, catalog validation, authentication, or `xhigh` support fails, the job stops before sending a query.

## Outputs and recovery

Production editions are self-contained beneath the configured book `Interiors` folder. Administrative job state is stored under `02 Translate Text/Jobs`; the current pointer is `02 Translate Text/Active Job.json`. Generated workbooks, reports, model state, diagram logs, and caption outputs remain local and are ignored by Git.

Workspace preparation, ICML import, caption completion, and job archival use transaction journals. On the next run, an interrupted operation either rolls back its owned partial changes or resumes from a validated committed state. Source packages and existing production editions are not overwritten merely because a new job is prepared.

## Troubleshooting

- **No glossary mapping:** create `01 Translate Glossaries/book_glossary_map.json` from the example and verify its relative paths and profile names.
- **Products root rejected:** pass an absolute `-ProductsRoot`, set `TRANSLATION_PRODUCTS_ROOT`, or use the documented sibling `Products` layout.
- **Codex login rejected:** run `codex login`, choose Sign in with ChatGPT, and confirm with `codex login status`. API-key authentication is intentionally refused.
- **Frontier model changed:** restart the job so every query is based on one newly recorded model resolution. The pipeline will not silently continue across a frontier change.
- **Workbook fails QA:** keep columns A and C unchanged, remove formulas and Excel error cells, and rerun `-Action Validate`. A workbook changed after import must be reimported.
- **Import is stale:** restore the exact QA-passed workbook and ICML snapshot, or validate and import the authorized new revision.
- **Adobe step will not start:** save and close unrelated Adobe documents, confirm the configured document and asset paths, then retry the same action. Never run concurrent InDesign operations.
- **Interrupted multi-file operation:** rerun the same action. Do not manually delete its journal or backup files unless you have independently verified the transaction state.

## Repository safety

The `.gitignore` and public-distribution test reject credentials, personal workstation paths, private data folders, common publishing binaries, generated state, and oversized files. Before contributing, run `npm test` and inspect `git diff --cached` so that only maintained source or synthetic examples are proposed.

## Management contract

- Primary entry point: `Run-Translation-Job.ps1`
- Cross-stage code: `Code` (shared infrastructure only; stage-specific code remains with its stage).
- Production jobs: `<Book>\Interiors\<Edition>\Translation Job`.
- Ad hoc jobs: `02 Translate Text\Jobs\<book>\<language>\<job-id>`.
- Active-job pointer: `02 Translate Text\Active Job.json` (generated; one at a time).
- Archive boundary: `_Archive`

The archive is local only and is never published.

## Authentication contract

This program must not store secrets or authentication state locally. All current and future credentials, `.env` files, DPAPI blobs, tokens, private keys, cookies, browser profiles, session state, and provider account contexts belong only in `D:\Google Drive\Publishing\Code\Admin\Access`. Code in this program may reference protected loaders or authenticated sessions from that directory but must never duplicate or print secret values.

## License

Released under the [MIT License](LICENSE). You may download, clone, fork, and modify your own copy.
