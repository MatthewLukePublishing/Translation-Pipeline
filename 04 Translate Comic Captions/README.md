# Stage 4: Translate Comic Captions

Stage 4 fills only pending cells in the Portuguese caption column of a local workbook. It preserves every other cell value and style, supports bounded resumable batches, and commits the workbook, final state, and report through one recoverable transaction.

Place the real workbook under `Working Files` and run from the repository root:

```powershell
node '.\04 Translate Comic Captions\Code\Translate_Comic_Captions.js'
```

Use `--check` for a read-only readiness check and `--max-batches N` for a bounded run. The translator uses only the ChatGPT-authenticated Codex subscription, requires the latest visible harness frontier with `xhigh`, and does not load paid API credentials. `Working Files`, `Output`, debug payloads, reports, and subscription state are ignored by Git.

