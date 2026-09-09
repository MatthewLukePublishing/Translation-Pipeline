# Code review — v1.3.1

Reviewed 2026-09-09 across glossary generation, text translation/QA/import,
offline ICML GREP, native-operation boundaries, diagrams, captions, shared
transactions, launcher/job lifecycle, model resolution, and public CI/distribution.
The review prioritizes concrete data-loss and false-success risks, not changes
to approved terminology or translation semantics.

## Corrected findings

| Risk | Correction and regression evidence |
| --- | --- |
| Recovery could delete edits made after a crash, or accept a missing original backup. | Version 2 file-set journals pin old/new hashes; all recovery targets are checked before mutation. Conflicts and legacy journals remain intact. Active-owner recovery and non-exclusive journal creation are blocked. |
| Workspace rollback could restore a foreign active pointer or delete one target before rejecting another. | Validate phase, ownership, redirects and the active pointer before mutation; retain journals when cleanup fails. |
| Caption and text completion could overwrite an output edited during a long query. | Pin loaded inputs and use expected-original hashes at publication; caption hashes describe the exact loaded bytes. Text also rechecks source/configuration before publication. |
| Readiness checks could recover and mutate pending transactions. | Text, caption and glossary check modes refuse pending journals without performing recovery. |
| Glossary acronym/word JSON could come from different generations after failure. | Publish each runtime pair as one recoverable transaction. Validate all destinations before replacing either. |
| QA could retain an import after its protected-text rules changed. | Protection hashes invalidate imports even if workbook bytes are unchanged. QA also rejects input changes during validation. |
| Diagram retries could force-close a desktop application and retry an uncertain save. | Save separate staged output, publish only against the unchanged original, stop on failure, never force-kill Illustrator, reject pre-existing documents, and restore interaction preferences. |
| Diagram runs shared coordination files and omitted uppercase extensions. | Unique run directories, case-insensitive nested discovery, and explicit staging-file exclusions. Worker wait budget now covers the bounded model-query retry budget. |
| Caption checks missed Unicode line separators; final model checks were inconsistent. | Validate all five supported line-break kinds. Captions and diagrams re-resolve the pinned frontier before publication. |
| Raw failed-query output could expose authentication diagnostics. | All three translation runners withhold raw subprocess diagnostics from errors/logs. |
| Panel round-trip reconciliation could silently discard formatting or shared-format changes. | Reject non-reference structural/style changes and changes to formats shared with unselected references. This helper does not author language-specific reference text. |
| New tests required manual inclusion in CI. | Discover public test files automatically while excluding ignored private-data audits. |

## Validation and limits

The public suite uses synthetic fixtures, real workbook round-trips, source
parsers and isolated mocks. No model queries or Adobe application launches are
part of that suite. Existing private translations, production files and approved
glossaries are not rewritten by this review.

Native Illustrator save/render behavior and InDesign layout require a separate
controlled desktop validation; passing mocks do not certify those applications.
File transactions are recoverable, not a database-level lock against arbitrary
external editors. Keep production editors closed during offline publication.
Uncertain recovery intentionally requires human reconciliation rather than
guessing which version to delete. Keyring-only Codex authentication remains an
explicit unsupported case; no credential or model fallback was added.

The dependency audit reports one moderate advisory for `adm-zip` 0.6.0:
[GHSA-vwc7-r8mq-g2x9](https://github.com/advisories/GHSA-vwc7-r8mq-g2x9).
No patched release is listed. The affected disk-extraction methods are not used:
the glossary validator reads entry data in memory, and source packaging creates
an archive from known files. A public regression rejects calls to those extraction
methods. The dependency remains pinned; the audit is not represented as clean.
Downgrading to an old version solely to silence the audit would also discard
other security fixes in the [current release](https://github.com/cthackers/adm-zip/releases/tag/v0.6.0).

The OpenAI Docs check informed the subscription safeguards: ChatGPT sign-in and
API-key authentication are distinct modes, so the pipeline retains its strict
ChatGPT-only contract. See [official authentication guidance](https://learn.chatgpt.com/docs/auth)
and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
