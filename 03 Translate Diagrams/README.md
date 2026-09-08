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

The controller discovers `.ai` files in nested folders, runs one Illustrator session, and returns a failed process result if any diagram fails. It uses only the ChatGPT-authenticated Codex subscription. Before each model request and retry, it freshly queries OpenAI's official frontier metadata and the live subscription catalog, verifies the exact model and `xhigh`, and records the resolution. Failed discovery, an unavailable frontier, or a model change stops the entire run without another model query or file retry. No bundled/local model catalog, paid API credentials, or fallback model is accepted. See the root README for live-discovery requirements. Reference workbooks, Adobe files, generated scans, translations, logs, and temporary files are local-only inputs or outputs.
