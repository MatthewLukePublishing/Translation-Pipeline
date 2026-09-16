# Stage 1: Translate Glossaries

Stage 1 maintains a standard glossary workbook for each book family and generates the JSON objects consumed by the translation stages.

## Family layout

```text
<family>/Glossary.xlsx
<family>/Runtime/acronyms.json
<family>/Runtime/words.json
```

`Glossary.xlsx` must have exactly two worksheets, `Acronyms` and `Words`. Both use the same ordered headers. `English` is the unique source key; `English Definition` follows it; every target term column is followed by its explicitly named definition column. Formula errors, unnamed columns, and duplicate keys are rejected.

The runtime JSON files are generated artifacts and must not be edited by hand or committed. `book_glossary_map.json` is also local configuration: it binds book codes to families, origin resources, supported profiles, and runtime paths. Start with `../examples/book_glossary_map.example.json`.

## Published MFP and FPST glossaries

`Published/Translation-Glossaries.json` is an owner-approved, versioned snapshot
of the [Translation Glossaries Google Sheet](https://docs.google.com/spreadsheets/d/1BT4y4_qjggRzJ0H8F5h82HACQzkHHvUwnROZIYRuL2M/edit).
It contains 197 MFP acronym rows and 314 FPST rows (65 acronyms and 249 word
senses), with French, German, Portuguese and Spanish terms and definitions.
The MFP French columns were replaced with the approved **French Recommended**
values before this snapshot was exported. The source URL, export date, original
row numbers and XLSX SHA-256 are recorded. Reviewer names from column headings,
comments, accounts, sharing settings and workbook metadata are not exported.
See `../DATA-LICENCE.md` for content terms.

On a clean clone, build these resources offline without private workbooks or
Google authentication:

```powershell
node '.\01 Translate Glossaries\Code\Shared\Build_Glossary_Runtime.cjs' --map '.\examples\book_glossary_map.published.json'
node '.\01 Translate Glossaries\Code\Shared\Build_Glossary_Runtime.cjs' --map '.\examples\book_glossary_map.published.json' --check
```

That example is a **glossary-only** map. To use it in a translation job, copy or
merge its book/profile settings into your local `book_glossary_map.json`, then
configure your own origin and production paths. Diagram symbols still require
the separately documented symbol workbook; the glossary does not replace it.

For an existing family, keep `authoringWorkbook` and add `publishedSource` from
the example. The workbook remains the base: unlisted terms, other languages and
unbound profiles are preserved. Populated sheet fields override corresponding
base fields. Blank recommendations do not delete approved values. Map languages
to named profiles with `publishedSource.languageFields`, for example
`{"French":"French Recommended","German":"German","Portuguese":"Portuguese","Spanish":"Spanish"}`
for MFP. This leaves the historical French Current profile untouched. Do not
drop a local authoring workbook just to copy the public example.

The importer recognizes the FPST Words section explicitly, keeps case and
punctuation, and trims only surrounding cell whitespace. A unique case-only
match retains the base source key. Repeated source terms with distinct meanings
(Camera and Ping) go into `Runtime/contextual.json`; they are not flattened or
locked to one translation. Text and diagram prompts receive all those senses
and must select from context. Combined bilingual definitions are retained as
reference data, not inserted as prose translation locks.

All three runtime files are published transactionally. New text workspaces and
diagram readiness checks reject stale runtimes. New text jobs copy the runtime
and provenance, and hash the contextual choices into the run identity. Existing
jobs and translations are not retroactively edited. Comic-caption workbooks have
no book binding and do not silently inherit MFP/FPST terms.

### Refresh from the sheet

This is a pinned snapshot, **not a live Google connection**. The sheet requires
sign-in, but users of the published snapshot do not need that access. An
authorized maintainer downloads an XLSX export from Google Sheets and runs:

```powershell
node '.\01 Translate Glossaries\Code\Shared\Import_Published_Glossaries.cjs' '<export.xlsx>' --check
node '.\01 Translate Glossaries\Code\Shared\Import_Published_Glossaries.cjs' '<export.xlsx>'
node '.\01 Translate Glossaries\Code\Shared\Build_Glossary_Runtime.cjs'
```

The importer never edits the Google Sheet or authoring workbooks. It rejects
unexpected layouts, formulas, error values and identical duplicate rows before
publication. Review the JSON diff, test and publish the updated snapshot. Never
commit the downloaded XLSX or authentication state. If French Recommended is
maintained locally, synchronize its approved values to the MFP French sheet
columns before refreshing; a sheet import does not authorize replacing that
profile with a different French policy.

From the repository root:

```powershell
node '.\01 Translate Glossaries\Code\Shared\Build_Glossary_Runtime.cjs'
node '.\01 Translate Glossaries\Code\Shared\Build_Glossary_Runtime.cjs' --check
node '.\01 Translate Glossaries\Code\Shared\Validate_Glossary_Workflow.cjs'
```

Use `--family '<exact family name>'` with the builder to process one family. The workflow validator also checks mapped profiles, origin resources, and optional book-instruction modules.

Before authoring new glossary entries or explicitly requested revisions, print the
language-specific editorial guidance with `Build_Glossary_Runtime.cjs --rules French`
(replace French with the target language). This uses the shared versioned rules.
It does not modify approved entries or require private glossary input files.
