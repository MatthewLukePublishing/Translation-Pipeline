# Diagram text ledgers

A ledger records the text every diagram in a book contains, so a new language
can be translated and reinserted without exporting that text again.

## Files

- `FPST-Diagram-Text-Ledger.json` — every diagram in *First Person Shooter
  Tactics* (115 diagrams, 2,022 text units).

## Format

`schemaVersion` is `diagram-text-ledger-1`.

```text
book, sourceLanguage, generatedUtc, sourceLabel, sourceFolder
extraction.method, extraction.adobeRequired, extraction.ligatureNormalization
terms.*
diagramCount, textUnitCount
diagrams[]: order, file, relativePath, bytes, sha256, textUnitCount, textUnits[]
  textUnits[]: id, font, kind, text, plain, matrix
```

Field notes:

- `id` is `<diagram stem>#<nnnn>`, stable while the diagram's own text order is
  unchanged.
- `kind` is `openSans`, `sourceCode`, or `other`. ChakraPetch and League Gothic
  text currently lands in `other`, and the Stage 3 scanner does not look for
  those families yet.
- `text` preserves the line as Illustrator drew it. `plain` collapses
  whitespace and is the key to translate against.
- `matrix` is the PDF text matrix `[a, b, c, d, e, f]` for the line, which gives
  its position and size on the page.
- `sha256` is the hash of the `.ai` file the units were read from. Re-check it
  before reinserting, because the ledger's unit order is only valid for that
  exact file.

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

Translate the ledger, then apply it through the Stage 3 diagram workflow, which
opens Illustrator once for the whole folder and lets it substitute fonts and
reflow the translated lines.

## Content terms

Every string in these ledgers is published content: (c) 2026 Matthew Luke
Publishing, all rights reserved, not covered by the repository's MIT licence.
Using, copying, redistributing, or translating it presumes permission was
granted. See `DATA-LICENCE.md`.
