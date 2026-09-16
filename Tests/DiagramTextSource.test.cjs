"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const controller = path.resolve(__dirname, "../03 Translate Diagrams/Code/Illustrator_Translate_Diagrams_Batch.cjs");
const { parseDiagramArguments, chooseDiagramTextSource, ask } = require(controller);

test("neither diagram text source is a default; explicit flags select either source", () => {
  assert.deepEqual(parseDiagramArguments([]), { sourceMode: null, ledgerPath: "", checkOnly: false });
  assert.deepEqual(parseDiagramArguments(["--check"]), { sourceMode: null, ledgerPath: "", checkOnly: true });
  assert.deepEqual(parseDiagramArguments(["--ledger"]), { sourceMode: "ledger", ledgerPath: "", checkOnly: false });
  assert.deepEqual(parseDiagramArguments(["--extract", "--check"]), { sourceMode: "extract", ledgerPath: "", checkOnly: true });
  assert.deepEqual(parseDiagramArguments(["--check", "--ledger=custom ledger.json"]), {
    sourceMode: "ledger", ledgerPath: "custom ledger.json", checkOnly: true,
  });
});

test("conflicting sources, empty paths, and unknown flags fail rather than falling back", () => {
  for (const args of [["--extract", "--ledger"], ["--ledger=a.json", "--extract"]]) {
    assert.throws(() => parseDiagramArguments(args), /not both/);
  }
  for (const arg of ["--ledger=", "--ledger=  "]) {
    assert.throws(() => parseDiagramArguments([arg]), /nonempty ledger path/);
  }
  assert.throws(() => parseDiagramArguments(["--ledger=a.json", "--ledger=b.json"]), /only one diagram ledger path/);
  assert.throws(() => parseDiagramArguments(["--extrcat"]), /Unknown argument/);
});

test("the prompt accepts either choice, without Enter or invalid input selecting a default", async () => {
  for (const [answer, expected] of [["1", "ledger"], ["2", "extract"], [" LEDGER ", "ledger"], ["extract", "extract"]]) {
    const answers = ["", " ", "wrong", answer];
    const prompts = [];
    const messages = [];
    const result = await chooseDiagramTextSource(parseDiagramArguments([]), {
      interactive: true,
      question: async (prompt) => { prompts.push(prompt); assert.ok(answers.length); return answers.shift(); },
      report: (message) => messages.push(message),
    });
    assert.equal(result, expected);
    assert.equal(prompts.length, 4);
    assert.equal(messages.length, 3);
    assert.match(prompts[0], /no default/);
    assert.match(prompts[0], /1\. Reuse.*ledger/);
    assert.match(prompts[0], /2\. Extract.*artwork/);
  }
});

test("an explicit source bypasses the source question, including unattended readiness checks", async () => {
  for (const mode of ["ledger", "extract"]) {
    for (const interactive of [true, false]) {
      const result = await chooseDiagramTextSource(parseDiagramArguments([`--${mode}`, "--check"]), {
        interactive,
        question: () => assert.fail("Explicit source must not prompt again"),
      });
      assert.equal(result, mode);
    }
  }
});

test("missing source fails unattended or in check mode before asking anything else", async () => {
  for (const [args, interactive] of [[[], false], [["--check"], false], [["--check"], true]]) {
    await assert.rejects(chooseDiagramTextSource(parseDiagramArguments(args), {
      interactive,
      question: () => assert.fail("Unattended readiness checks cannot prompt"),
    }), /Specify --ledger or --extract/);
  }
});

test("cancelling the source question never chooses a mode", async () => {
  await assert.rejects(chooseDiagramTextSource(parseDiagramArguments([]), {
    interactive: true, question: async () => "q",
  }), /cancelled/);
  await assert.rejects(chooseDiagramTextSource(parseDiagramArguments([]), {
    interactive: true, question: async () => { throw new Error("Input closed"); },
  }), /Input closed/);
});

test("the real question rejects EOF and Ctrl-C instead of silently exiting or selecting a default", { timeout: 2000 }, async () => {
  for (const cancel of ["eof", "interrupt"]) {
    const input = new PassThrough();
    const output = new PassThrough();
    if (cancel === "interrupt") output.isTTY = true;
    try {
      const answer = ask("Choose: ", { input, output });
      const rejection = assert.rejects(answer, /Input closed or cancelled/);
      if (cancel === "eof") input.end();
      else input.write("\u0003");
      await rejection;
    } finally { input.destroy(); output.destroy(); }
  }
});

test("the real CLI gates missing and conflicting choices before glossary, authentication, or Adobe work", () => {
  for (const args of [[], ["--check"], ["--ledger", "--extract"], ["--ledger="]]) {
    const run = spawnSync(process.execPath, [controller, ...args], {
      encoding: "utf8", timeout: 5000, windowsHide: true,
      env: { ...process.env, AI_TARGET_LANGUAGE: "", AI_BOOK: "", AI_DIAGRAM_LEDGER: "not-a-mode-selection.json" },
    });
    assert.equal(run.error, undefined);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /No diagram text source selected|not both|nonempty ledger path/);
    assert.doesNotMatch(run.stdout, /Target language:|Book code:|DIAGRAM_SUBSCRIPTION_READY/);
  }
  for (const mode of ["ledger", "extract"]) {
    const run = spawnSync(process.execPath, [controller, `--${mode}`, "--check"], {
      encoding: "utf8", timeout: 5000, windowsHide: true,
      env: { ...process.env, AI_TARGET_LANGUAGE: "", AI_BOOK: "" },
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Set AI_TARGET_LANGUAGE/);
  }
});
