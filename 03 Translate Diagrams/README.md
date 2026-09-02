# Stage 3: Translate Diagrams

Stage 3 translates text recursively across a selected folder of Adobe Illustrator files.

- `Code/Illustrator_Translate_Diagrams_Batch.cjs` is the Node.js controller.
- `Code/Illustrator_Translate_Diagrams.jsx` is the Illustrator worker launched by the controller.
- The local `Reference/New Acronyms Symbols.xlsx` supplies diagram-specific labels.
- The local Stage 1 book map selects the canonical word and acronym runtime JSON.

Run from the repository root:

```powershell
node '.\03 Translate Diagrams\Code\Illustrator_Translate_Diagrams_Batch.cjs'
```

For a readiness check that does not launch Illustrator:

```powershell
$env:AI_TARGET_LANGUAGE = 'French'
$env:AI_BOOK = 'DEMO'
node '.\03 Translate Diagrams\Code\Illustrator_Translate_Diagrams_Batch.cjs' --check
```

The controller discovers `.ai` files in nested folders, runs one Illustrator session, and returns a failed process result if any diagram fails. It uses only the ChatGPT-authenticated Codex subscription, resolves the current harness frontier before each model request, requires `xhigh`, and rejects paid API credentials or fallback models. Reference workbooks, Adobe files, generated scans, translations, logs, and temporary files are local-only inputs or outputs.

