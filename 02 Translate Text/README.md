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

The Node workbook adapter initializes real filesystem support and serializes
the exact authored strings through shared strings, preserving leading-zero IDs,
boundary spaces and literal ICML entities. Unicode line/paragraph separators
are validated alongside ordinary line breaks. Equivalent separator encodings
are restored only when the complete ordered break count matches; missing or
additional breaks still fail validation.

The active provider is `CodexSubscription` at `xhigh`. `Code/Resolve-LatestSubscriptionModel.mjs` queries OpenAI's live frontier metadata and the authenticated Codex subscription service before every new query. Both fresh responses must confirm the exact official model and `xhigh` support. No bundled catalog, local cache, or catalog ranking determines the model. The job and each query record the model and live verification evidence; a changed or unavailable frontier stops the job. The CLI must report ChatGPT sign-in; API keys, paid endpoints, alternate endpoints, and older-model fallbacks are rejected. See the root README for authentication and live-discovery requirements.

Conflicting explicit glossary terms are errors. An expanded definition shared by
different acronyms can instead have genuinely different contextual meanings.
Those alternatives are recorded in the job plan and sent to the translator for
service/context disambiguation; they are never forced into a single global lock.
Deterministic glossary QA covers unambiguous locks; contextual choices still
require linguistic review against the source and book rules.

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

`Prepare -DeferRelink` can create and translate the isolated source package
without opening Adobe. The workspace remains explicitly awaiting relink; run
`Export` before importing/finalizing it.

The Adobe controller opens the isolated document once, yields between bounded
steps, checks UI-thread idleness without COM polling, and preserves checkpoint
saves between link batches. It does not discard a modified document on failure.
Audits do not save changes. The launcher streams progress separately from its
Boolean completion result, so a paused translation cannot accidentally proceed
to validation as though it were complete.

When a structurally invalid draft has intact group identifiers, only its failing
groups are sent for an independent targeted recheck (at most two attempts).
Valid groups remain unchanged, and the original draft is retained privately.
Every recheck repeats live frontier resolution and ChatGPT authentication with
`xhigh`, exactly like a primary query; model or authentication failures stop the
job. Style-boundary spacing failures require natural rephrasing, never blind
padding that would break French contractions.
Saved responses are revalidated on resume; implementation corrections can
trigger the same bounded recheck without discarding valid groups. When an
official-unit preservation rule applies, headquarters qualifiers and their
abbreviated unit type form one protected name before glossary matching. This
prevents a translated qualifier from being combined with an English unit type.
New queries protect line breaks with dedicated tokens, so the model does not
have to reproduce Unicode control-code escapes. Tokens must remain in their
original segment and order. Earlier valid drafts remain resumable; malformed
drafts receive the bounded targeted recheck.

Typography finalization first audits the exact document and requested styles,
then applies language in groups of 20 styles and sizes in groups of five, with
separate checkpoint saves. Its report remains incomplete until all steps and
the scoped close succeed. Layout audits inspect styles, links and stories in
separate bounded calls; they never update links, save, or discard unsaved work.
An error leaves the isolated document available for recovery, without closing
any unrelated document. Resume a failed finalization only after reviewing its
incomplete report and safely saving or closing that exact document.
Completion checks the current workbook against both QA and import hashes, and
binds the final layout report and INDD to their finalization hashes. Changed
files cannot reuse a stale passing audit. Older jobs without a hashed layout
report require a fresh finalization before completion; existing outputs are
not silently rewritten.

## Translating the current edition

The mapped Origin package is a snapshot, not a live export. When the English
edition has changed, preparation refuses the stale mapped snapshot. Export a
new source package to a new product-owned directory:

```powershell
& '.\02 Translate Text\Code\InDesign\Export-CurrentSourcePackage.ps1' -DocumentPath '<current English INDD>' -DestinationPath '<new product source-package folder>'
& '.\Run-Translation-Job.ps1' -Action Prepare -Book DEMO -Language French -EditionName 'French new edition' -GlossaryProfile 'French' -SourcePackagePath '<new product source-package folder>'
```

The exporter works on a copy, audits stories in bounded calls, then exports five
stories per call. It includes otherwise unlinked running headings. The English
original is never saved or overwritten. It requires no open documents and waits
for background work using Windows process state, without queuing COM polls.
The final source-package marker is published only after the literal workbook
round-trip, story inventory and file hashes pass. Incomplete packages cannot be
used; keep a failed package for diagnosis until recovery is resolved. Preparation
also rejects a package if the original English document has since changed, and
records immutable source provenance in the new job.

Model discovery accepts the live service's dotted minimum-client-version string
as well as older tuple metadata, while strictly rejecting malformed or newer
requirements. Updating the official Codex client does not install a model:
frontier identity and subscription availability are still queried live before
every model request.
