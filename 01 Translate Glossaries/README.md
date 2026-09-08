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
