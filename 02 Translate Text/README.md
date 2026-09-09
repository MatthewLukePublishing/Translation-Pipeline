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

A blank recommended glossary-table cell retains the corresponding English
source cell; it never erases an abbreviation or definition. Table standardization
and QA share the same renderer and preserve boundary whitespace. In French prose,
definition-presence checks accept regular gender/number agreement for one-word
terms ending in `-é`; explicit abbreviations and source matches remain exact.

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

`Import` first validates the current workbook. When bytes or payload changed after
an earlier import, QA atomically invalidates the old import/finalization evidence.
A valid edited workbook becomes `ready_for_import`; invalid edits become
`qa_failed`. Only the unchanged, already-imported workbook can resume link refresh
without reimporting. No manual manifest reset is required.
Re-import verifies the complete previous successful ICML output set by path and
SHA-256, instead of requiring the now-superseded English export. Missing evidence
or later ICML edits still block all writes; user changes are never overwritten.
Completion resolves the live frontier again, records that evidence, and refuses
to complete if the frontier changed or discovery fails during layout work.

Before any InDesign action, save and close unrelated documents. Adobe operations must run serially.

Finalization requires both zero overset stories and zero overflowing table cells.
Tables are inventoried by story ID and cells checked in separate batches of at most
50. Missing/incomplete cell audits and nested tables stop finalization explicitly;
nested tables require a separately scoped audit implementation before completion.

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
the scoped close succeed. Generic `German` selects InDesign's exact
`German: 2006 Reform` dictionary; it must be installed, with no fallback to old
rules or a regional variant. Reports retain both the translation language and
the native dictionary name, and final audits use the same mapping. Profiles
may omit point size and leading to preserve source typography.
Layout audits inspect styles, links and stories in
separate bounded calls; they never update links, save, or discard unsaved work.
An error leaves the isolated document available for recovery, without closing
any unrelated document. Resume a failed finalization only after reviewing its
incomplete report and safely saving or closing that exact document.
Completion checks the current workbook against both QA and import hashes, and
binds the final layout report and INDD to their finalization hashes. Changed
files cannot reuse a stale passing audit. Older jobs without a hashed layout
report require a fresh finalization before completion; existing outputs are
not silently rewritten.

## Editorial rules and finishing order

The shared ten-language policy routes prose rules to model prompts, mechanical
typography to postprocessing and QA, and document rules to finalization.
`ReviewRules` snapshots the accepted workbook and invalidates its old import
evidence before reviewing it. Protected credits remain verbatim.

All language-specific cross-reference changes must be entered through
**Cross-References > Define Cross-Reference Formats > Definition**. The panel
encoder owns the dynamic format codes and targeted reference updates. The
translator preserves cached `CrossReferenceSource` segments, the importer
rejects direct edits to them, and GREP excludes their ranges. The read-only
editorial verifier checks both format definitions and generated text wrappers;
saving a definition alone does not prove that the references were refreshed.
Native page-number variables are inspected through their read-only displayed
results; their internal marker is never mistaken for a missing page number or
converted to plain text. Missing or unresolved variable results fail the audit.
Keep one verified INDD recovery copy before panel edits. Never update all
references when only a small identified subset needs updating.

Spacing corrections belong in translation, not a later manual cleanup. Model
prompts request final Unicode typography, and text postprocessing runs every
applicable expression before exporting the workbook. The importer also runs the
rules directly on ICML text, before its first write, to handle patterns spanning
adjacent bold/italic Content segments. No InDesign interface is used for GREP.
The supplied matrix has four French punctuation expressions,
unit spacing, math spacing and ten language-specific date expressions. The
pipeline escapes the invalid bare plus sign, completes the explicit math
spacing-after rule, and limits dates to horizontal whitespace and native month
names. All 17 expressions remain documented in `Code/TranslationGrepRules.cjs`;
each job records the applicable runs, including zero matches, and explicit
language exclusions for the others.

```powershell
# After normal translation QA; these commands do not launch Adobe.
node '.\02 Translate Text\Code\Import_Translation_Workbook.mjs' --job '<job>' --dry-run
node '.\02 Translate Text\Code\Import_Translation_Workbook.mjs' --job '<job>'
node '.\02 Translate Text\Code\IcmlGrepJob.mjs' --job '<job>'
```

The normal `Import` action includes the same offline pass, followed by Adobe link
refresh. Direct Node import requires `ready_for_import` and current QA. Save,
check in and close the edition before writes: edition lock files block the
transaction. Dry-run never writes or recovers a journal. Workbook/ICML hashes
are checked before writing; changes made after export/import are not overwritten.

`Code/IcmlGrep.cjs` executes the fixed matrix's tested JavaScript equivalents,
not the native InDesign regex engine. It decodes text entities for matching but
patches only changed horizontal spaces at their original XML offsets. It never
serializes the document, moves letters across style boundaries, crosses table
cells/paragraphs, changes structural tabs, or edits cross-reference/variable
nodes. Protected source IDs, Credits styles, book names and glossary locks come
from QA. Unsupported XML content fails closed; metadata CDATA stays opaque.

`reports/icml_grep_import.json` records all per-file runs and exclusions.
Import publishes ICML, report and manifest in one recoverable transaction, then
finalization/completion recheck every imported file against its hash and current
rules. The approved workbook is not silently rewritten for a style-boundary
spacing correction: the report explicitly records the deterministic derivation
and retains both the workbook hash and resulting ICML hashes.

Older imports require current QA and reimport to acquire this evidence. If native
InDesign checkout/save has stripped Content IDs or changed the ICML, stop for
reconciliation with the retained snapshot; never invent IDs or overwrite manual
edits. Panel-only cross-reference changes and layout audits remain separate.
The native GREP utility is retained for explicitly scoped, document-owned text,
but is no longer invoked by this translation pipeline.

NNBSP is a descriptive label, never manuscript text or a GREP expression. The
offline engine writes actual U+202F (narrow nonbreaking space) and U+00A0 (NBSP).
If giving manual InDesign fallback instructions, provide paste-ready syntax from
the rule matrix; do not tell the user to type the letters `NNBSP`.

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
