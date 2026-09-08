"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const ROOT = path.resolve(__dirname, "..");
const resolverModule = import(pathToFileURL(path.join(
  ROOT, "02 Translate Text", "Code", "Resolve-LatestSubscriptionModel.mjs",
)).href);

function guidance(model = "gpt-frontier") {
  return `---\nlatestModelInfo:\n  model: ${model}\n  migrationGuide: /guide\n  promptingGuide: /prompt\n---\n# Official guidance\n`;
}

function model(slug = "gpt-frontier", effort = "xhigh") {
  return { slug, visibility: "list", supported_reasoning_levels: [{ effort }] };
}

function fixture() {
  const state = {
    guidance: guidance(), catalog: { models: [model()] }, calls: [], cliCalls: [],
    auth: { auth_mode: "chatgpt", tokens: { access_token: "fixture-credential", account_id: "fixture-account" } },
    login: "Logged in using ChatGPT", catalogStatus: 200,
  };
  const deps = {
    runCli: (_runtime, args) => {
      state.cliCalls.push(args);
      return args[0] === "login" ? state.login : "codex-cli 0.152.1";
    },
    readAuth: () => state.auth,
    fetchImpl: async (url, options) => {
      state.calls.push({ url, options });
      if (new URL(url).hostname === "developers.openai.com") {
        if (state.guidanceError) throw new Error("fixture transport detail");
        return new Response(state.guidance, { status: state.guidanceStatus || 200 });
      }
      if (state.catalogError) throw new Error("fixture-credential must never appear in diagnostics");
      return new Response(JSON.stringify(state.catalog), { status: state.catalogStatus });
    },
  };
  return { state, deps };
}

test("every resolution queries both live authorities without cache and records only nonsecret evidence", async () => {
  const resolver = await resolverModule;
  const { state, deps } = fixture();
  for (let query = 0; query < 2; query++) {
    const result = await resolver.resolveLatestSubscriptionModel({ expectedModel: "gpt-frontier" }, deps);
    assert.equal(result.model, "gpt-frontier");
    assert.equal(result.reasoningEffort, "xhigh");
    assert.equal(result.discovery, "live-no-cache");
    assert.equal(result.sourceUrl, resolver.OFFICIAL_MODEL_SOURCE);
    assert.match(result.officialMetadataSha256, /^[0-9a-f]{64}$/);
    assert.match(result.catalogSha256, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(JSON.stringify(result), /fixture-credential|fixture-account/);
  }
  assert.equal(state.calls.length, 4, "the second query must not reuse the first resolution");
  for (const { url, options } of state.calls) {
    assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "error", "credentials must not follow a redirect");
    assert.match(options.headers["Cache-Control"], /no-cache/);
    assert.ok(options.signal);
    if (url === resolver.OFFICIAL_MODEL_SOURCE) assert.equal(options.headers.Authorization, undefined);
    else {
      assert.equal(new URL(url).origin, "https://chatgpt.com");
      assert.equal(new URL(url).searchParams.get("client_version"), "0.152.1");
      assert.equal(options.headers.Authorization, "Bearer fixture-credential");
    }
  }
  assert.deepEqual(state.cliCalls, [["login", "status"], ["--version"], ["login", "status"], ["--version"]]);
});

test("missing, hidden, duplicate, or insufficient-effort frontier never selects an older model", async () => {
  const resolver = await resolverModule;
  for (const current of [[], [{ ...model(), visibility: "hidden" }], [model(), model()],
    [{ ...model(), upgrade: { model: "gpt-next" } }], [model("gpt-frontier", "high")],
    [{ ...model(), minimal_client_version: [99, 0, 0] }]]) {
    const { state, deps } = fixture();
    state.catalog.models = [{ ...model("gpt-older"), priority: 0 }, ...current];
    await assert.rejects(resolver.resolveLatestSubscriptionModel({}, deps), { code: resolver.MODEL_POLICY_ERROR });
  }
});

test("changed frontier or weaker reasoning prevents the next query", async () => {
  const resolver = await resolverModule;
  const { state, deps } = fixture();
  await resolver.resolveLatestSubscriptionModel({}, deps);
  state.guidance = guidance("gpt-next");
  state.catalog.models = [model("gpt-next")];
  await assert.rejects(resolver.resolveLatestSubscriptionModel({ expectedModel: "gpt-frontier" }, deps), /Start a new job/);
  assert.equal(state.calls.length, 3, "a stale job must stop as soon as the official change is known");
  await assert.rejects(resolver.resolveLatestSubscriptionModel({ reasoningEffort: "high" }, deps), /requires xhigh/);
  assert.equal(state.calls.length, 3);
});

test("live minimum client versions accept strict dotted strings and integer tuples", async () => {
  const resolver = await resolverModule;
  for (const minimum of ["0.152.0", "0.152.1", [0, 152, 1], "0.151.99"]) {
    const { state, deps } = fixture();
    state.catalog.models[0].minimal_client_version = minimum;
    assert.equal((await resolver.resolveLatestSubscriptionModel({}, deps)).model, "gpt-frontier");
  }
  for (const minimum of ["0.153.0", "0.152.2", [0, 153, 0]]) {
    const { state, deps } = fixture();
    state.catalog.models[0].minimal_client_version = minimum;
    await assert.rejects(resolver.resolveLatestSubscriptionModel({}, deps), /requires a newer Codex client/);
  }
  for (const minimum of [null, "", "0.152", "0.152.1-beta", "0.152.1junk", " 0.152.1", "9007199254740992.0.0", [], [0, 152], [0, "152", 1], [0, -1, 1]]) {
    const { state, deps } = fixture();
    state.catalog.models[0].minimal_client_version = minimum;
    await assert.rejects(resolver.resolveLatestSubscriptionModel({}, deps), /invalid minimum client version/);
  }
});

test("live discovery failures cannot reuse a previously successful resolution or leak credentials", async () => {
  const resolver = await resolverModule;
  for (const failure of ["guidanceError", "catalogError", "catalogStatus", "guidanceStatus"]) {
    const { state, deps } = fixture();
    await resolver.resolveLatestSubscriptionModel({}, deps);
    state[failure] = failure.endsWith("Status") ? 503 : true;
    await assert.rejects(resolver.resolveLatestSubscriptionModel({}, deps), (error) => {
      assert.equal(error.code, resolver.MODEL_POLICY_ERROR);
      assert.doesNotMatch(error.message, /fixture-credential|fixture transport detail/);
      return true;
    });
  }
});

test("metadata must explicitly identify one official frontier instead of inferring it from prose", async () => {
  const resolver = await resolverModule;
  assert.equal(resolver.parseOfficialFrontier(guidance().replace(/\n/g, "\r\n")), "gpt-frontier");
  for (const malformed of [
    "# Latest model: gpt-frontier", "---\nother: gpt-frontier\n---\n",
    guidance().replace("  model: gpt-frontier", "  model: gpt-frontier\n  model: gpt-other"),
    guidance().replace("  migrationGuide: /guide", "latestModelInfo:\n  model: gpt-other"),
    guidance().replace("gpt-frontier", "https://example.test/model"),
  ]) assert.throws(() => resolver.parseOfficialFrontier(malformed), /unambiguous frontier/);
});

test("API-key, missing, and alternate authentication stop before authenticated discovery", async () => {
  const resolver = await resolverModule;
  for (const auth of [null, { auth_mode: "apikey" }, { auth_mode: "chatgpt", tokens: {} },
    { auth_mode: "chatgpt", OPENAI_API_KEY: "fixture-key", tokens: { access_token: "fixture-credential", account_id: "fixture-account" } }]) {
    const { state, deps } = fixture();
    state.auth = auth;
    await assert.rejects(resolver.resolveLatestSubscriptionModel({}, deps), /ChatGPT session is required/);
    assert.equal(state.calls.length, 1);
  }
  const { state, deps } = fixture();
  state.login = "Logged in using an API key";
  await assert.rejects(resolver.resolveLatestSubscriptionModel({}, deps), /signed in with ChatGPT/);
  assert.equal(state.calls.length, 1);
});

// Execute the actual diagram retry loop in isolation, without loading or running Adobe.
test("diagram retries resolve again and a frontier failure escapes all file retries", async () => {
  const source = fs.readFileSync(path.join(ROOT, "03 Translate Diagrams", "Code", "Illustrator_Translate_Diagrams_Batch.cjs"), "utf8");
  const queryCode = source.slice(source.indexOf("async function translateDiagramOnce("), source.indexOf("function validateTranslations("));
  let resolutions = 0;
  let queries = 0;
  const policyFailure = Object.assign(new Error("frontier changed"), { code: "LATEST_MODEL_POLICY_FAILURE" });
  const context = {
    MODEL: "gpt-frontier", REASONING_EFFORT: "xhigh", MAX_SUBSCRIPTION_RETRIES: 3,
    TARGET_LANGUAGE: "French", EDITORIAL_POLICY: null, editorialRules: require("../Code/TranslationEditorialRules.cjs"),
    CODEX_QUERY_TIMEOUT_MS: 1000, path,
    makeInputItems: () => [{ skipTranslation: false }], buildDelimitedPrompt: () => "synthetic prompt",
    buildResponseSchema: () => ({}), writeJson() {}, writeTextAtomic() {}, removeFileIfExists() {},
    resolveSubscriptionModel: async (expected) => {
      assert.equal(expected, "gpt-frontier");
      if (++resolutions === 2) throw policyFailure;
      return { model: expected, reasoningEffort: "xhigh" };
    },
    runCodex: () => { queries++; return { status: 1 }; },
    sleep: async () => {}, console: { warn() {} },
  };
  vm.createContext(context);
  vm.runInContext(queryCode, context);
  await assert.rejects(context.translateDiagramOnce({ runs: [{ id: "synthetic" }] }, {
    codexSchemaJson: "schema.json", codexPromptText: "prompt.txt", codexResponseJson: "response.json", codexRequestJson: "request.json",
  }), /frontier changed/);
  assert.equal(resolutions, 2);
  assert.equal(queries, 1, "the second query must never be sent");

  const fileCode = source.slice(source.indexOf("async function processFileWithRetry("), source.indexOf("async function main("));
  context.ILLUSTRATOR_RETRY_LIMIT = 3;
  context.processFileInSession = async () => { throw policyFailure; };
  context.startIllustratorSession = () => assert.fail("policy failures must not relaunch Adobe");
  vm.runInContext(fileCode, context);
  await assert.rejects(context.processFileWithRetry({
    sessionPaths: {}, getSession: () => ({ state: { exited: false } }),
  }), /frontier changed/);
});
