const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const template = fs.readFileSync(path.join(__dirname, "../02 Translate Text/Code/InDesign/Run_Translation_Document.jsx"), "utf8").replace(/^#target[^\n]*\n/, "");

test("bounded Adobe lifecycle opens once and never discards a modified document on error", () => {
  const documentPath = "C:/Synthetic/edition/book.indd";
  let opens = 0, closes = 0, saves = 0;
  const app = { documents: [], backgroundTasks: [], scriptPreferences: { userInteractionLevel: "original" } };
  const doc = { modified: false, links: [], fullName: { fsName: documentPath }, isValid: true,
    save() { saves++; this.modified = false; },
    close() { closes++; app.documents = []; } };
  app.open = () => { opens++; app.documents = [doc]; return doc; };
  const context = { app, UserInteractionLevels: { NEVER_INTERACT: "none" }, SaveOptions: { NO: "no" },
    File: function(file) { this.fsName = file; this.exists = true; },
    Folder: function(folder) { this.fsName = folder; this.exists = true; this.getFiles = () => []; },
    LinkStatus: { LINK_OUT_OF_DATE: "outdated", LINK_EMBEDDED: "embedded" },
  };
  const run = action => {
    const source = template.replace(/__ACTION_JS__/g, JSON.stringify(action))
      .replace(/__DOCUMENT_JS__/g, JSON.stringify(documentPath))
      .replace(/__[A-Z_]+_JS__/g, '"C:/Synthetic"');
    return vm.runInNewContext(source, context);
  };
  assert.match(run("open"), /^OPENED/);
  assert.match(run("audit"), /^AUDIT/);
  assert.match(run("audit"), /^AUDIT/);
  assert.equal(opens, 1, "bounded steps reuse their isolated document");
  assert.equal(closes, 0);
  const updates = [];
  doc.links = [
    { name: "story.icml", filePath: "C:/Synthetic/Text/story.icml" },
    { name: "title.ai", filePath: "C:/Synthetic/Color/title.ai" },
    { name: "photo.jpg", filePath: "C:/Unrelated/photo.jpg" },
  ].map(link => ({ ...link, status: "outdated", update() { updates.push(this.name); this.status = "normal"; } }));
  doc.links.push({ name: "embedded", status: "embedded", get filePath() { throw new Error("Not applicable to embedded link"); } });
  assert.match(run("refresh"), /^REFRESHED/);
  assert.deepEqual(updates, ["story.icml"], "text import must not update artwork or unrelated linked originals");
  assert.equal(saves, 1);
  doc.modified = true;
  assert.match(run("close"), /^ERROR.*modified/);
  assert.equal(closes, 0, "unsaved state must be preserved");
  assert.equal(app.scriptPreferences.userInteractionLevel, "original");
  assert.match(run("checkpoint"), /^CHECKPOINT_SAVED/);
  assert.equal(saves, 2);
  assert.equal(doc.modified, false);
  assert.match(run("close"), /^CLOSED/);
  assert.equal(closes, 1);
  app.backgroundTasks = [{}];
  assert.match(run("open"), /^ERROR.*idle/);
  assert.equal(opens, 1);
});

function typographyHarness() {
  const source = fs.readFileSync(path.join(__dirname, "../02 Translate Text/Code/InDesign/Run_Translation_Typography.jsx"), "utf8").replace(/^#target[^\n]*\n/, "");
  const documentPath = "C:/Synthetic/edition/book.indd";
  const app = { documents: [], backgroundTasks: [], scriptPreferences: { userInteractionLevel: "original" }, languagesWithVendors: [{ name: "French" }] };
  const styles = Array.from({ length: 7 }, (_, i) => ({ id: i, name: `Style ${i}`, isValid: true, pointSize: 12, leading: 14, appliedLanguage: { name: "English" }, fontStyle: "Regular" }));
  let saves = 0, closes = 0, updates = 0;
  const doc = { name: "book.indd", modified: false, fullName: { fsName: documentPath }, pages: [{}], allParagraphStyles: styles,
    documentPreferences: { pageWidth: 6, pageHeight: 9 },
    stories: [{ id: 1, isValid: true, overflows: false, itemLink: null, tables: [] }],
    links: ["missing", "outdated", "normal"].map((status, i) => ({ name: `Link ${i}`, filePath: `C:/Synthetic/${i}`, status, update() { updates++; } })),
    save() { saves++; this.modified = false; }, close() { closes++; app.documents = []; }, recompose() {},
  };
  app.open = () => { app.documents = [doc]; return doc; };
  const context = { app, UserInteractionLevels: { NEVER_INTERACT: "none" }, SaveOptions: { NO: "no" }, LinkStatus: { LINK_MISSING: "missing", LINK_OUT_OF_DATE: "outdated", LINK_EMBEDDED: "embedded" }, File: function(file) { this.fsName = file; this.exists = true; } };
  function run(action, options = {}) {
    const values = { ACTION: action, DOCUMENT: documentPath, START: options.start ?? 0, COUNT: options.count ?? 25, SETTINGS: options.settings ?? [], LANGUAGE: "French" };
    return vm.runInNewContext("Array.prototype.indexOf = undefined;\n" + source.replace(/__([A-Z]+)_JS__/g, (_, key) => JSON.stringify(values[key])), context);
  }
  return { app, doc, styles, run, context, counts: () => ({ saves, closes, updates }) };
}

test("editorial inventory is bounded, read-only and reads only applicable block properties", () => {
  const h = typographyHarness();
  h.context.BuildingBlockTypes = { CUSTOM_STRING_BUILDING_BLOCK: 1, FULL_PARAGRAPH_BUILDING_BLOCK: 2 };
  h.doc.layers = [{ id: 1, name: "Body", visible: true, locked: false }];
  const format = { id: 3, name: "Text", buildingBlocks: [
    { blockType: 1, customText: "(consulter « ", get appliedDelimiter() { throw Error("Inapplicable"); } },
    { blockType: 2, appliedDelimiter: ":", includeDelimiter: false, get customText() { throw Error("Inapplicable"); } },
  ] };
  h.doc.crossReferenceFormats = [format];
  h.doc.crossReferenceSources = [{ id: 7, appliedFormat: format, sourceText: { parentStory:{id:1},contents:'reference',textVariableInstances:[],paragraphs: [{ appliedParagraphStyle: h.styles[0] }] }, get status() { throw Error("Undocumented property"); } }];
  h.run("open");
  assert.match(h.run("editorial-summary"), /^EDITORIAL_SUMMARY\|layers=1\|formats=1\|references=1\|paragraphStyles=7$/);
  assert.match(h.run("editorial-layers"), /^LAYER\|index=0\|id=1\|name=Body/);
  assert.match(h.run("editorial-formats", { count: 10 }), /BLOCK\|formatId=3\|index=1\|type=2\|customText=\|delimiter=%3A\|includeDelimiter=false/);
  assert.match(h.run("editorial-references"), /^REFERENCE\|index=0\|id=7\|formatId=3\|storyId=1\|text=reference\|paragraphStyle=Style%200$/);
  assert.match(h.run("editorial-formats", { count: 11 }), /^ERROR.*ten cross-reference/);
  assert.match(h.run("editorial-references", { count: 26 }), /^ERROR.*twenty-five/);
  h.doc.layers.length = 101;
  assert.match(h.run("editorial-summary"), /^ERROR.*bounded audit limit/);
  assert.deepEqual(h.counts(), { saves: 0, closes: 0, updates: 0 });
});

test("typography audit is bounded and never discards unrelated or modified documents", () => {
  const h = typographyHarness();
  const unrelated = { modified: true, close() { throw new Error("Must never be touched"); } };
  h.app.documents = [unrelated];
  assert.match(h.run("open"), /^ERROR.*existing documents/);
  assert.equal(h.app.documents[0], unrelated);
  h.app.documents = [];
  assert.match(h.run("open"), /^OPENED/);
  assert.match(h.run("summary"), /^SUMMARY.*stories=1.*links=3.*paragraphStyles=7/);
  assert.equal(h.run("styles", { start: 2, count: 2 }).split("\n").length, 2);
  assert.match(h.run("links", { start: 0, count: 2 }), /LINKS\|missing=1\|outdated=1\|embedded=0\|total=2$/);
  assert.match(h.run("stories"), /^STORY.*overflows=false/);
  h.doc.stories[0].overflows = true;
  h.doc.stories[0].textContainers = [1, 1, 2].map(name => ({ parentPage: { name, isValid: true } }));
  h.doc.stories[0].paragraphs = [h.styles[0], h.styles[0], h.styles[1]].map(appliedParagraphStyle => ({ appliedParagraphStyle }));
  assert.match(h.run("stories"), /overflows=true.*pages=1%2C2.*styles=Style%200%3BStyle%201/);
  assert.deepEqual(h.counts(), { saves: 0, closes: 0, updates: 0 });
  h.doc.modified = true;
  assert.match(h.run("close"), /^ERROR.*unsaved changes/);
  assert.match(h.run("styles"), /^ERROR.*unsaved changes/);
  assert.equal(h.app.scriptPreferences.userInteractionLevel, "original");
  h.doc.modified = false;
  h.doc.fullName.fsName = "C:/Synthetic/other.indd";
  assert.match(h.run("language"), /^ERROR.*Unexpected document/);
  assert.equal(h.styles[0].appliedLanguage.name, "English");
  h.doc.fullName.fsName = "C:/Synthetic/edition/book.indd";
  assert.match(h.run("close"), /^CLOSED/);
});

test("GREP reference scope inventory never reads cached text or native variable results", () => {
  const h = typographyHarness(); h.run("open");
  h.doc.crossReferenceSources = [{ id: 7, sourceText: {
    parentStory: { id: 1 },
    get contents() { throw Error("Text must not be read"); },
    get textVariableInstances() { throw Error("Variables must not be read"); },
    get paragraphs() { throw Error("Paragraphs are unnecessary for identity inventory"); },
  } }];
  assert.equal(h.run("editorial-reference-scopes"), "REFERENCE|index=0|id=7|storyId=1");
  assert.match(h.run("editorial-reference-scopes", { count: 26 }), /^ERROR.*twenty-five/);
  assert.deepEqual(h.counts(), { saves: 0, closes: 0, updates: 0 });
});

test("language-specific cross-reference edits cannot bypass the panel encoder", () => {
  const h=typographyHarness();h.run("open");
  const blocks=[{blockType:"CUSTOM_STRING_BUILDING_BLOCK",customText:"(See "},{blockType:"PARAGRAPH_TEXT_BUILDING_BLOCK"},{blockType:"CUSTOM_STRING_BUILDING_BLOCK",customText:")"}];
  const format={id:1,name:"In the text",isValid:true,buildingBlocks:blocks};
  h.doc.crossReferenceFormats={itemByID:id=>id===1?format:null};
  const requested={id:1,name:"In the text",blocks:[{type:blocks[0].blockType,beforeText:"(See ",customText:"(consulter « "},{type:blocks[1].blockType},{type:blocks[2].blockType,beforeText:"stale",customText:" »)"}]};
  assert.match(h.run("editorial-apply-format",{count:1,settings:[requested]}),/^ERROR.*panel format encoder/);
  assert.equal(blocks[0].customText,"(See ");
  requested.blocks[2].beforeText=")";
  assert.match(h.run("editorial-apply-format",{count:1,settings:[requested]}),/^ERROR.*panel format encoder/);
  assert.equal(blocks[0].customText,"(See ");
  assert.equal(blocks[1].blockType,"PARAGRAPH_TEXT_BUILDING_BLOCK");
  let updated=0;
  h.doc.crossReferenceSources={itemByID:id=>id===9?{id:9,isValid:true,appliedFormat:format,update(){updated++;}}:null};
  assert.match(h.run("editorial-update-reference",{count:1,settings:[{id:9,formatId:2}]}),/^ERROR.*panel format encoder/);
  assert.equal(updated,0);
  assert.match(h.run("editorial-update-reference",{count:1,settings:[{id:9,formatId:1}]}),/^ERROR.*panel format encoder/);
  assert.equal(updated,0);
  assert.equal(h.counts().saves,0);
});

test("typography edits touch only the requested batch and require explicit checkpoints", () => {
  const h = typographyHarness();
  h.run("open");
  const settings = h.styles.map(s => ({ path: s.name, pointSize: 10, leading: 12 }));
  assert.match(h.run("apply", { count: 6, settings }), /^ERROR.*five style/);
  assert.match(h.run("apply", { count: 2, settings: [{ path: "Style 0", pointSize: 8 }, { path: "Missing" }] }), /^ERROR.*not found/);
  assert.equal(h.styles[0].pointSize, 12, "validate the entire batch before mutation");
  assert.equal(h.run("apply", { start: 2, count: 2, settings }).split("\n").length, 2);
  assert.deepEqual(h.styles.map(s => s.pointSize), [12, 12, 10, 10, 12, 12, 12]);
  h.run("language", { start: 1, count: 2 });
  assert.deepEqual(h.styles.map(s => s.appliedLanguage.name), ["English", "French", "French", "English", "English", "English", "English"]);
  h.doc.modified = true;
  assert.match(h.run("checkpoint"), /^CHECKPOINT_SAVED/);
  assert.equal(h.counts().saves, 1);
  h.app.backgroundTasks = [{}];
  assert.match(h.run("close"), /^ERROR.*background work/);
  assert.equal(h.counts().closes, 0);
});

test("table-cell audits detect clipping separately from stories and reject uninspected nested tables", () => {
  const h = typographyHarness();
  h.run("open");
  const table = { id: 7, isValid: true, cells: Array.from({ length: 60 }, (_, i) => ({ name: `cell${i}`, overflows: i === 52, tables: [] })) };
  h.doc.stories.itemByID = id => h.doc.stories.find(s => s.id === id);
  h.doc.stories[0].tables.push(table);
  h.doc.stories[0].tables.itemByID = id => id === 7 ? table : null;
  assert.match(h.run("stories"), /overflows=false\|tableCount=1/);
  assert.match(h.run("tables", { settings: [{ storyId: 1 }] }), /^TABLE.*cellCount=60/);
  const scope = [{ storyId: 1, tableId: 7 }];
  assert.match(h.run("cells", { start: 50, count: 10, settings: scope }), /index=52\|name=cell52\|overflows=true/);
  assert.match(h.run("cells", { count: 51, settings: scope }), /^ERROR.*fifty/);
  assert.match(h.run("cells", { settings: [{ storyId: 1, tableId: 9 }] }), /^ERROR.*not found/);
  table.cells[0].tables = [{}];
  assert.match(h.run("cells", { count: 1, settings: scope }), /^ERROR.*Nested tables/);
  assert.deepEqual(h.counts(), { saves: 0, closes: 0, updates: 0 });
  assert.equal(h.app.scriptPreferences.userInteractionLevel, "original");
});
