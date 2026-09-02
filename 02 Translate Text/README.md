# Stage 2: Translate Text

Stage 2 prepares an isolated edition, translates a protected four-column XLSX through the ChatGPT-authenticated Codex harness, validates it, transactionally imports it into local ICML, and audits the resulting InDesign layout.

## Workspace contract

For a production edition, `Run-Translation-Job.ps1 -Action Prepare` creates a copied INDD at the edition root with local `Text` and `Diagrams` folders. Central administrative state is stored under `02 Translate Text/Jobs/<book>/<language>/<job-id>` and includes immutable input snapshots, the output workbook, reports, resumable subscription state, and a manifest.

Preparation validates containment, extracts the ICML archive without path escapes or duplicates, verifies Content IDs, copies only the configured production resources, and records hashes. A recoverable journal owns partial workspace creation; retrying an interrupted preparation safely rolls back or recognizes the committed result.

## Translation contract

The source workbook uses exactly four columns:

```text
ParagraphStyleRange id
ParagraphStyleRange content
Content tag
Content content
```

Columns A and C are immutable identifiers. Translation and QA preserve segment counts, XML-sensitive constructs, protected source sections, glossary locks, and nonblank content. QA never stops counting at its reporting limit: all issues influence pass/fail, while only a bounded number are written to a report. A changed workbook is always revalidated against its new hash and, if it changed after import, must be imported again.

The active provider is `CodexSubscription` at `xhigh`. `Code/Resolve-LatestSubscriptionModel.mjs` resolves the newest visible frontier entry from the installed Codex harness catalog and verifies that exact entry supports `xhigh`. The job records that model, resolves it again immediately before each query, and fails if it changes. The CLI must report ChatGPT sign-in; API keys, paid endpoints, alternate endpoints, and older-model fallbacks are rejected.

## Run

From the repository root:

```powershell
& '.\Run-Translation-Job.ps1' -Action Prepare -Book DEMO -Language French -EditionName 'French' -GlossaryProfile 'French'
& '.\Run-Translation-Job.ps1' -Action Translate
& '.\Run-Translation-Job.ps1' -Action Import
& '.\Run-Translation-Job.ps1' -Action Finalize
& '.\Run-Translation-Job.ps1' -Action Complete
```

Use `Status` for the current state, `Validate` after an authorized workbook correction, and `Export` to resume Adobe relinking that was deferred because another InDesign document was open. `Import` verifies the QA workbook hash, payload fingerprint, ICML snapshot, and exact Content-ID coverage before starting its recoverable multi-file transaction.

Before any InDesign action, save and close unrelated documents. Adobe operations must run serially.

