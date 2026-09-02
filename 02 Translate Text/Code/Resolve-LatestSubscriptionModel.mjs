import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const REQUIRED_REASONING_EFFORT = "xhigh";
export const MODEL_POLICY = "official_latest_frontier";
export const MODEL_CATALOG_SOURCE = "codex-cli:debug-models";

function codexEnvironment() {
  const childEnv = { ...process.env };
  for (const name of [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_ORG_ID",
    "OPENAI_ORGANIZATION",
    "OPENAI_PROJECT",
  ]) delete childEnv[name];
  return childEnv;
}

function defaultCodexCliPath() {
  const configured = String(process.env.CODEX_CLI_JS || "").trim();
  if (configured) return path.resolve(configured);
  const appData = String(process.env.APPDATA || "").trim();
  return appData
    ? path.join(appData, "npm", "node_modules", "@openai", "codex", "bin", "codex.js")
    : "";
}

export function supportsEffort(model, effort) {
  return Array.isArray(model?.supported_reasoning_levels) &&
    model.supported_reasoning_levels.some((entry) => entry?.effort === effort);
}

export function selectLatestCatalogModel(catalog) {
  const candidates = (Array.isArray(catalog?.models) ? catalog.models : [])
    .map((model, catalogIndex) => ({ ...model, catalogIndex }))
    .filter((model) => (
      typeof model.slug === "string" &&
      /^gpt-[a-z0-9.-]+$/i.test(model.slug) &&
      model.visibility === "list" &&
      !model.upgrade
    ));
  if (!candidates.length) {
    throw new Error("Codex model catalog has no visible subscription model.");
  }
  candidates.sort((left, right) => {
    const leftPriority = Number.isFinite(Number(left.priority)) ? Number(left.priority) : Number.MAX_SAFE_INTEGER;
    const rightPriority = Number.isFinite(Number(right.priority)) ? Number(right.priority) : Number.MAX_SAFE_INTEGER;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    const leftLatest = /latest\s+frontier/i.test(String(left.description || "")) ? 0 : 1;
    const rightLatest = /latest\s+frontier/i.test(String(right.description || "")) ? 0 : 1;
    return leftLatest - rightLatest || left.catalogIndex - right.catalogIndex;
  });
  return candidates[0];
}

export function assertModelSupportsEffort(model, requiredEffort = REQUIRED_REASONING_EFFORT) {
  if (!supportsEffort(model, requiredEffort)) {
    throw new Error(
      `The newest visible Codex subscription model '${model?.slug || "(blank)"}' does not support ` +
      `'${requiredEffort}'. Refusing to fall back to an older model.`
    );
  }
  return model;
}

function loadCodexModelCatalog({ nodePath, cliPath, timeoutMs }) {
  if (!cliPath || !fs.existsSync(cliPath)) {
    throw new Error(`The official standalone Codex CLI was not found: ${cliPath || "(blank)"}`);
  }
  const run = spawnSync(nodePath, [cliPath, "debug", "models"], {
    cwd: path.dirname(cliPath),
    env: codexEnvironment(),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (run.error) throw new Error(`Could not read the Codex model catalog: ${run.error.message}`, { cause: run.error });
  if (run.status !== 0) {
    const diagnostics = `${run.stdout || ""}\n${run.stderr || ""}`.trim().slice(-8000);
    throw new Error(`Codex model catalog failed with exit code ${run.status}: ${diagnostics}`);
  }
  try {
    return JSON.parse(String(run.stdout || "").replace(/^\uFEFF/, "").trim());
  } catch (error) {
    throw new Error(`Codex model catalog returned invalid JSON: ${error.message}`, { cause: error });
  }
}

export async function resolveLatestSubscriptionModel(options = {}) {
  const nodePath = path.resolve(String(options.nodePath || process.env.CODEX_NODE_EXE || process.execPath));
  const cliPath = path.resolve(String(options.cliPath || defaultCodexCliPath() || "."));
  const timeoutMs = Number(options.timeoutMs || 60000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000) {
    throw new Error("Model-catalog timeout must be an integer of at least 1000 milliseconds.");
  }
  const catalog = loadCodexModelCatalog({ nodePath, cliPath, timeoutMs });
  const selected = selectLatestCatalogModel(catalog);
  assertModelSupportsEffort(selected);
  return {
    schemaVersion: 2,
    policy: MODEL_POLICY,
    model: selected.slug,
    displayName: String(selected.display_name || selected.slug),
    description: String(selected.description || ""),
    catalogPriority: Number.isFinite(Number(selected.priority)) ? Number(selected.priority) : null,
    reasoningEffort: REQUIRED_REASONING_EFFORT,
    resolvedAt: new Date().toISOString(),
    sourceUrl: MODEL_CATALOG_SOURCE,
  };
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedUrl) {
  resolveLatestSubscriptionModel()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`LATEST_MODEL_RESOLUTION_FAILED|${error.message}\n`);
      process.exitCode = 1;
    });
}
