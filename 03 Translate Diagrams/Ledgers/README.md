# Diagram text ledgers

A ledger records the text every diagram in a book contains, so a new language
can be translated and reinserted without exporting that text again. Stage 3
reads and updates it in ledger mode; see the
[stage guide](../README.md#ledger-mode).

## Files

- `FPST-Diagram-Text-Ledger.json` — every diagram in *First Person Shooter
  Tactics* (115 diagrams, 2,014 text units, 348 KB, inside the 1 MiB limit the
  public-distribution test enforces).

## Format

`schemaVersion` is `diagram-text-ledger-2`. One text unit is written per line so
Git diffs stay readable.

```text
schemaVersion, book, sourceLanguage, generatedUtc, sourceLabel, sourceFolder
extraction.method, extraction.adobeRequired, extraction.order, extraction.kinds
terms.*
diagramCount, textUnitCount
diagrams[]: order, file, relativePath, bytes, sha256, textUnitCount, textUnits[]
  textUnits[]: id, font, kind, text, plain, translations
```

Field notes:

- `id` is `<diagram stem>#<nnnn>` in drawing order, stable while the diagram's
  text is unchanged.
- `kind` is `prose` (Open Sans, ChakraPetch, League Gothic), `sourceCode`
  (Source Code Pro, resolved from the acronym-symbol workbook), or nothing —
  an unrecognised font fails the ledger build instead of being guessed at.
- `text` is the line as Illustrator drew it, including a trailing newline when
  the PDF recorded one. `plain` collapses whitespace and is the matching key and
  the text the model translates.
- `translations` maps a language name to the text that was applied to the
  diagram, written back by Stage 3 after that diagram was published.
- `sha256` is the hash of the `.ai` file the units were read from. Stage 3
  refuses to process a diagram whose bytes differ from it.

## Regenerating a ledger

Regeneration preserves existing translations for units whose text is unchanged,
so re-running it after an artwork revision keeps the languages that still apply.
It is an offline build; no Adobe application is launched. `pypdf` is required.

```powershell
python '.\Code\Build-DiagramTextLedger.py' '<English diagrams folder>' --book FPST `
  --source-label "Products/<series>/<book>/Interiors/English/Diagrams" ^
  --out '.\Ledgers\<BOOK>-Diagram-Text-Ledger.json'
```

`Code/Verify-DiagramTextLedger.py` re-checks a ledger against PDFium's visible
text and reports any unit it cannot find. The published FPST ledger passes with
2,006 of 2,014 units matched exactly; the remaining 8 are Illustrator's own
hyphenated line fragments (`Angle-of-` / `Attack`) that PDFium re-joins.

## How a ledger is produced

Each `.ai` file carries a PDF-compatible stream beside Illustrator's private
document data. The ledger is read from the text operators in that stream, so no
Adobe application is launched and no diagram is opened or modified.

## Reinserting a translation

Replacing the text inside the `.ai` file itself is not sufficient. Illustrator
embeds only the glyphs the English text uses — the Open Sans subset in
`6 - General Planning - Contingency Planning.ai` contains 15 glyphs — so any
letter or accent the English text does not already contain renders as nothing.
Illustrator also keeps the editable text in its own private stream, which a
PDF-layer edit does not touch; the next Illustrator save would discard it.

Translate the ledger, then apply it with Stage 3 ledger mode, which opens
Illustrator once for the whole folder and lets it substitute fonts and reflow
the translated lines.

## Content terms

Every string in these ledgers is published content: (c) 2026 Matthew Luke
Publishing, all rights reserved, not covered by the repository's MIT licence.
Using, copying, redistributing, or translating it presumes permission was
granted. See `DATA-LICENCE.md`.
