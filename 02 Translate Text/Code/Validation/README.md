# Translation validation

`Validate_Translation_Job.js` is part of Step 2. It validates the translated four-column workbook against the job's exported workbook, immutable glossary snapshot, and import-integrity metadata before InDesign import is allowed.

The supported entry points are `Run-Translation-Job.ps1 -Action Translate`, which runs validation automatically, and `Run-Translation-Job.ps1 -Action Validate`, which reruns the gate after an authorized correction. Direct Node execution is for diagnosis only and requires `--job <job-path>`.

Book-specific rules are normalized and merged through
`..\BookTranslationRules.mjs`, the same utility imported by the subscription
translator. Do not duplicate that contract inside the validator.
