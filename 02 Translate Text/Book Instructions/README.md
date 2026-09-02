# Book Translation Instructions

This folder holds optional local JSON modules containing mandatory, book-specific translation rules. The book’s entry in `01 Translate Glossaries/book_glossary_map.json` selects a module through `translationInstructions`.

Start with `../../examples/book_translation_instructions.example.json`. Each schema-version-2 module has `baseRules` applied to every target language and optional `languageExceptions` merged for one language. Rules can provide prompt instructions, preferred examples, protected source patterns, forbidden target patterns, and narrowly scoped glossary exclusions.

Preparation copies the complete module into the immutable job input and records its SHA-256 hash. Translation and independent QA use the same normalized rule contract. Book rules take precedence over generic guidance and glossary wording when they explicitly conflict.

Real modules are private inputs and are ignored by Git.

