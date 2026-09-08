# Stage 4: Translate Comic Captions

Stage 4 fills only pending cells in the Portuguese caption column of a local workbook. It preserves every other cell value and style, supports bounded resumable batches, and commits the workbook, final state, and report through one recoverable transaction.

Caption prompts receive the applicable shared editorial and Portuguese-language
rules. The state pins their policy hash, while response postprocessing applies
only relevant punctuation, date and symbol spacing. Original segment-boundary
whitespace and every non-target cell remain protected. InDesign cross-reference
and native GREP actions belong to document finalization, not this workbook stage.

Place the real workbook under `Working Files` and run from the repository root:

```powershell
node '.\04 Translate Comic Captions\Code\Translate_Comic_Captions.js'
```

Use `--check` for a read-only readiness check and `--max-batches N` for a bounded run. The translator uses only the ChatGPT-authenticated Codex subscription. Before each new query, it freshly queries OpenAI's official frontier metadata and the live subscription catalog, verifies that exact model with `xhigh`, and records the resolution. It stops if discovery fails, the frontier changes, or the current model is unavailable. It never selects a model from a bundled/local catalog or loads paid API credentials. See the root README for live-discovery requirements. `Working Files`, `Output`, debug payloads, reports, and subscription state are ignored by Git.
