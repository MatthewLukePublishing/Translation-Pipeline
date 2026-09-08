const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const modulePromise = import(pathToFileURL(path.join(__dirname, "../02 Translate Text/Code/SourcePackage.mjs")).href);

test("shared-string canonicalization preserves literal XML entities, IDs and boundary spaces", async () => {
  const { default: XLSX, restoreLiteralCells } = await import(pathToFileURL(path.join(__dirname, "../Code/SheetJsNode.mjs")).href);
  const rows = [["00001", "&amp; &apos; &quot; &lt;x&gt;", "", " leading "], ["", "", "00002", "=literal"]];
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([["1", "incorrectly decoded", "", "trimmed"], ["", "", "2", "=literal"]]);
  XLSX.utils.book_append_sheet(workbook, sheet, "Content");
  restoreLiteralCells(sheet, rows);
  const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx", bookSST: true });
  const roundTrip = XLSX.read(bytes, { type: "buffer" });
  assert.deepEqual(XLSX.utils.sheet_to_json(roundTrip.Sheets.Content, { header: 1, raw: true, defval: "", range: "A1:D2" }), rows);
  assert.throws(() => restoreLiteralCells({ A1: { f: "1+1" } }, [["value"]]), /Unexpected formula/);
});

test("Node workbook adapter supports file I/O from real ESM entry points", async () => {
  const { spawnSync } = require("node:child_process");
  const adapter = pathToFileURL(path.join(__dirname, "../Code/SheetJsNode.mjs")).href;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "translate-esm-xlsx-"));
  try {
    const file = path.join(temporary, "synthetic.xlsx");
    const script = `import XLSX from ${JSON.stringify(adapter)};const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([["00001","éclair"," leading ","=literal"]]),"Content");XLSX.writeFile(wb,${JSON.stringify(file)});const read=XLSX.readFile(${JSON.stringify(file)});console.log(JSON.stringify(XLSX.utils.sheet_to_json(read.Sheets.Content,{header:1,raw:true})));`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [["00001", "éclair", " leading ", "=literal"]]);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test("fresh ICML indexing preserves nested tables, tokens, whitespace and empty segments", async () => {
  const { indexIcml } = await modulePromise;
  const source = '<Story><ParagraphStyleRange id="old"><Content> A&amp;B </Content><Table><ParagraphStyleRange/><ParagraphStyleRange><Content/><?test x?><Content><?ACE 18?></Content></ParagraphStyleRange></Table></ParagraphStyleRange><ParagraphStyleRange><Content> C </Content></ParagraphStyleRange></Story>';
  const result = indexIcml(source);
  assert.deepEqual(result.rows, [
    ["00000", " A&amp;B <?ACE 18?>", "00000", " A&amp;B "],
    ["", "", "00001", ""], ["", "", "00002", "<?ACE 18?>"],
    ["00001", " C ", "00003", " C "],
  ]);
  assert.equal(result.text.replace(/ id="\d+"/g, ""), source.replace(' id="old"', ""));
  assert.equal(indexIcml('<ParagraphStyleRange><Content>x</Content></ParagraphStyleRange>', result.counters).rows[0][2], "00004");
  for (const broken of ['<Content>x</Content>', '<ParagraphStyleRange><Content>x', '<ParagraphStyleRange>', '</ParagraphStyleRange>']) assert.throws(() => indexIcml(broken));
  const quoted = indexIcml('<ParagraphStyleRange><Content>&quot;A&amp;B&apos;s&quot; &lt;x&gt;</Content></ParagraphStyleRange>');
  assert.equal(quoted.rows[0][3], '&quot;A&amp;B&apos;s&quot; &lt;x&gt;');
  assert.match(quoted.text, /&amp;B/);
});

test("central jobs and legacy isolated jobs are accepted without allowing sibling paths", async () => {
  const { isProductionJobLocation } = await modulePromise;
  const root = path.resolve("synthetic"), workspace = path.join(root, "edition"), central = path.join(root, "Jobs");
  assert.equal(isProductionJobLocation(path.join(central, "Book/French/job"), workspace, central), true);
  assert.equal(isProductionJobLocation(path.join(workspace, "Translation Job"), workspace, central), true);
  for (const target of [root, central, path.join(root, "Jobs-other/job"), path.join(root, "other/job")]) assert.equal(isProductionJobLocation(target, workspace, central), false);
});

test("source packages reject changed files, changed originals and incomplete inventories", async () => {
  const { sha256, verifySourcePackage } = await modulePromise;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "translate-source-test-"));
  try {
    const original = path.join(temp, "original.indd"), root = path.join(temp, "package");
    fs.mkdirSync(root); fs.writeFileSync(original, "synthetic document");
    const names = ["source.indd", "content_export.xlsx", "Text.zip"];
    for (const name of names) fs.writeFileSync(path.join(root, name), `synthetic ${name}`);
    const record = { schemaVersion: 1, status: "complete", originalDocument: original, originalDocumentSha256: sha256(original), document: names[0], files: names.map(name => ({ path: name, sha256: sha256(path.join(root, name)) })) };
    const write = () => fs.writeFileSync(path.join(root, "source_package.json"), JSON.stringify(record));
    write(); assert.equal(verifySourcePackage(root).status, "complete");
    fs.writeFileSync(original, "changed source"); assert.throws(() => verifySourcePackage(root), /current source document changed/);
    fs.writeFileSync(original, "synthetic document");
    record.status = "exporting"; write(); assert.throws(() => verifySourcePackage(root), /incomplete/);
    record.status = "complete"; record.files[0].path = "../original.indd"; write(); assert.throws(() => verifySourcePackage(root), /path or hash/);
    record.files[0].path = "source.indd"; write();
    fs.writeFileSync(path.join(root, "source.indd"), "changed snapshot"); assert.throws(() => verifySourcePackage(root), /file changed/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
