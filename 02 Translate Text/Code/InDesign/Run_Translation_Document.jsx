#target "InDesign"

(function () {
  var ACTION = __ACTION_JS__;
  var DOCUMENT_PATH = __DOCUMENT_JS__;
  var TEXT_FOLDER_PATH = __TEXT_FOLDER_JS__;
  var DIAGRAMS_FOLDER_PATH = __DIAGRAMS_FOLDER_JS__;
  var EXPORT_SCRIPT_PATH = __EXPORT_SCRIPT_JS__;
  var IMPORT_SCRIPT_PATH = __IMPORT_SCRIPT_JS__;
  var JOB_PATH = __JOB_PATH_JS__;
  var MAX_ICML_FILES = 5000;
  var MAX_LINKS_PER_CALL = 40;

  function pathKey(value) {
    return String(value || "").replace(/\\/g, "/").toLowerCase();
  }

  function isIcml(value) {
    return /\.(?:icml|icm)$/i.test(String(value || ""));
  }

  function readUtf8(filePath) {
    var file = new File(filePath);
    if (!file.exists) throw new Error("Missing file: " + filePath);
    file.encoding = "UTF-8";
    if (!file.open("r")) throw new Error("Cannot read file: " + filePath);
    var text = file.read();
    file.close();
    return text.replace(/^\uFEFF/, "");
  }

  function readJson(filePath, label) {
    try {
      var text = readUtf8(filePath);
      if (typeof JSON !== "undefined" && JSON.parse) return JSON.parse(text);
      return eval("(" + text + ")");
    }
    catch (error) { throw new Error("Could not read " + label + ": " + filePath + " | " + error); }
  }

  function collectFiles(folder, output) {
    var children = folder.getFiles();
    for (var index = 0; index < children.length; index++) {
      if (children[index] instanceof Folder) collectFiles(children[index], output);
      else if (isIcml(children[index].name)) output.push(children[index]);
    }
  }

  function collectAllFiles(folder, output) {
    var children = folder.getFiles();
    for (var index = 0; index < children.length; index++) {
      if (children[index] instanceof Folder) collectAllFiles(children[index], output);
      else output.push(children[index]);
    }
  }

  function applyRelinkBatch(document, planned, modifiedError) {
    var batchCount = Math.min(planned.length, MAX_LINKS_PER_CALL);
    for (var planIndex = 0; planIndex < batchCount; planIndex++) {
      planned[planIndex].link.relink(planned[planIndex].file);
      planned[planIndex].link.update();
    }
    if (batchCount) document.save();
    if (document.modified) throw new Error(modifiedError);
    return { processed: batchCount, remaining: planned.length - batchCount };
  }

  function relinkLocalDiagramAssets(document) {
    var diagramsFolder = new Folder(DIAGRAMS_FOLDER_PATH);
    if (!diagramsFolder.exists) throw new Error("Missing local Diagrams folder: " + DIAGRAMS_FOLDER_PATH);
    var localFiles = [];
    collectAllFiles(diagramsFolder, localFiles);
    var localByName = {};
    for (var fileIndex = 0; fileIndex < localFiles.length; fileIndex++) {
      var fileKey = String(localFiles[fileIndex].name).toLowerCase();
      if (localByName[fileKey]) throw new Error("Duplicate local diagram basename: " + localFiles[fileIndex].name);
      localByName[fileKey] = localFiles[fileIndex];
    }
    var localRoot = pathKey(diagramsFolder.fsName) + "/";
    var planned = [];
    var matched = 0;
    for (var linkIndex = 0; linkIndex < document.links.length; linkIndex++) {
      var link = document.links[linkIndex];
      if (isIcml(link.name)) continue;
      var linkName = decodeURI(String(link.name));
      var localFile = localByName[linkName.toLowerCase()];
      if (!localFile) continue;
      matched++;
      var currentPath = "";
      try { currentPath = String(link.filePath || ""); } catch (_) { currentPath = ""; }
      if (pathKey(currentPath).indexOf(localRoot) !== 0) planned.push({ link: link, file: localFile });
    }
    var result = applyRelinkBatch(document, planned, "Document remained modified after local diagram relink batch save.");
    return { processed: result.processed, remaining: result.remaining, matched: matched };
  }

  function collectIcmlLinks(document) {
    var links = [];
    for (var index = 0; index < document.links.length; index++) {
      if (isIcml(document.links[index].name)) links.push(document.links[index]);
    }
    return links;
  }

  function updateIcmlLinksBatch(document) {
    var links = collectIcmlLinks(document);
    var updated = 0;
    var remaining = 0;
    for (var index = 0; index < links.length; index++) {
      try {
        if (links[index].status === LinkStatus.LINK_OUT_OF_DATE) {
          if (updated < MAX_LINKS_PER_CALL) {
            links[index].update();
            updated++;
          } else {
            remaining++;
          }
        }
      } catch (error) {
        throw new Error("Could not update ICML link " + links[index].name + ": " + error);
      }
    }
    return { updated: updated, remaining: remaining, total: links.length };
  }

  function assertManifestStatus(expectedStatus, documentPath) {
    var manifestPath = JOB_PATH + "\\job_manifest.json";
    var manifest = readJson(manifestPath, "job manifest");
    if (String(manifest.status || "") !== expectedStatus) {
      throw new Error("Job manifest did not reach " + expectedStatus + "; found " + String(manifest.status || "(blank)"));
    }
    if (!manifest.document || pathKey(manifest.document.path) !== pathKey(documentPath)) {
      throw new Error("Job manifest document does not match the prepared document.");
    }
    return manifest;
  }

  function runPrepare(document, exportAfterRelink) {
    if (document.modified) throw new Error("Copied document opened with unsaved changes before relinking.");
    var textFolder = new Folder(TEXT_FOLDER_PATH);
    if (!textFolder.exists) throw new Error("Missing local Text folder: " + TEXT_FOLDER_PATH);
    var localFiles = [];
    collectFiles(textFolder, localFiles);
    if (!localFiles.length || localFiles.length > MAX_ICML_FILES) {
      throw new Error("Unexpected local ICML file count: " + localFiles.length);
    }

    var localByName = {};
    for (var localIndex = 0; localIndex < localFiles.length; localIndex++) {
      var localKey = String(localFiles[localIndex].name).toLowerCase();
      if (localByName[localKey]) throw new Error("Duplicate local ICML basename: " + localFiles[localIndex].name);
      localByName[localKey] = localFiles[localIndex];
    }

    var links = collectIcmlLinks(document);
    if (!links.length || links.length > MAX_ICML_FILES) throw new Error("Unexpected linked ICML count: " + links.length);
    var planned = [];
    var uniqueLinkNames = {};
    var localRoot = pathKey(textFolder.fsName) + "/";
    for (var linkIndex = 0; linkIndex < links.length; linkIndex++) {
      var linkName = decodeURI(String(links[linkIndex].name));
      var linkKey = linkName.toLowerCase();
      if (!localByName[linkKey]) throw new Error("No local ICML match for linked file: " + linkName);
      uniqueLinkNames[linkKey] = true;
      var currentPath = "";
      try { currentPath = String(links[linkIndex].filePath || ""); } catch (_) { currentPath = ""; }
      if (pathKey(currentPath).indexOf(localRoot) !== 0) {
        planned.push({ link: links[linkIndex], file: localByName[linkKey] });
      }
    }
    var uniqueCount = 0;
    for (var key in uniqueLinkNames) if (uniqueLinkNames.hasOwnProperty(key)) uniqueCount++;
    if (uniqueCount !== localFiles.length) {
      throw new Error("Local ICML/link set mismatch. Local files: " + localFiles.length + "; unique linked names: " + uniqueCount);
    }

    var result = applyRelinkBatch(document, planned, "Document remained modified after local ICML relink batch save.");
    var batchCount = result.processed;
    var remainingRelinks = result.remaining;
    if (remainingRelinks > 0) {
      return "RELINK_PROGRESS|document=" + document.fullName.fsName +
        "|processed=" + batchCount + "|remaining=" + remainingRelinks + "|total=" + links.length;
    }
    for (var verifyIndex = 0; verifyIndex < links.length; verifyIndex++) {
      var linkedPath = "";
      try { linkedPath = String(links[verifyIndex].filePath || ""); } catch (_) { linkedPath = ""; }
      if (pathKey(linkedPath).indexOf(localRoot) !== 0) {
        throw new Error("ICML link did not resolve inside the local Text folder: " + links[verifyIndex].name);
      }
    }

    var diagrams = relinkLocalDiagramAssets(document);
    if (diagrams.remaining > 0) {
      return "RELINK_PROGRESS|kind=diagrams|document=" + document.fullName.fsName +
        "|processed=" + diagrams.processed + "|remaining=" + diagrams.remaining + "|matched=" + diagrams.matched;
    }

    if (!exportAfterRelink) {
      return "RELINKED|document=" + document.fullName.fsName + "|links=" + links.length + "|uniqueIcml=" + uniqueCount + "|diagramLinks=" + diagrams.matched;
  }
  var exportScript = new File(EXPORT_SCRIPT_PATH);
  if (!exportScript.exists) throw new Error("Missing Step 2 export script: " + EXPORT_SCRIPT_PATH);
  $.global.TRANSLATION_DOCUMENT = document;
  try { $.evalFile(exportScript); }
  finally { $.global.TRANSLATION_DOCUMENT = null; }
    assertManifestStatus("exported", document.fullName.fsName);
    return "PREPARED|document=" + document.fullName.fsName + "|links=" + links.length + "|uniqueIcml=" + uniqueCount + "|diagramLinks=" + diagrams.matched;
  }

  function runAudit(document) {
    var textFolder = new Folder(TEXT_FOLDER_PATH);
    if (!textFolder.exists) throw new Error("Missing local Text folder: " + TEXT_FOLDER_PATH);
    var localFiles = [];
    collectFiles(textFolder, localFiles);
    var localByName = {};
    for (var localIndex = 0; localIndex < localFiles.length; localIndex++) {
      localByName[String(localFiles[localIndex].name).toLowerCase()] = true;
    }
    var links = collectIcmlLinks(document);
    var uniqueLinks = {};
    var matched = 0;
    var pageNamed = 0;
    var unmatched = [];
    var samples = [];
    for (var linkIndex = 0; linkIndex < links.length; linkIndex++) {
      var linkName = decodeURI(String(links[linkIndex].name));
      var linkKey = linkName.toLowerCase();
      uniqueLinks[linkKey] = true;
      if (localByName[linkKey]) matched++;
      else if (unmatched.length < 20) unmatched.push(linkName);
      if (/^Page_\d+_/i.test(linkName)) pageNamed++;
      if (samples.length < 20) {
        var linkPath = "";
        try { linkPath = String(links[linkIndex].filePath || ""); } catch (_) { linkPath = ""; }
        samples.push(linkName + "=>" + linkPath);
      }
    }
    var uniqueCount = 0;
    for (var key in uniqueLinks) if (uniqueLinks.hasOwnProperty(key)) uniqueCount++;
    return "AUDIT|document=" + document.fullName.fsName +
      "|links=" + links.length +
      "|uniqueLinks=" + uniqueCount +
      "|localIcml=" + localFiles.length +
      "|matchedLinks=" + matched +
      "|pageNamedLinks=" + pageNamed +
      "|unmatched=" + unmatched.join(";") +
      "|samples=" + samples.join(";");
  }

  function runImport(document) {
    if (document.modified) throw new Error("Prepared document has unsaved changes before import.");
  var importScript = new File(IMPORT_SCRIPT_PATH);
  if (!importScript.exists) throw new Error("Missing Step 2 import script: " + IMPORT_SCRIPT_PATH);
  $.global.TRANSLATION_IMPORT_RESULT = "NOT_STARTED";
  $.global.TRANSLATION_DOCUMENT = document;
  try { $.evalFile(importScript); }
  finally { $.global.TRANSLATION_DOCUMENT = null; }
  var importResult = String($.global.TRANSLATION_IMPORT_RESULT || "NO_RESULT");
  if (importResult.indexOf("ERROR|") === 0 || importResult === "NOT_STARTED" || importResult === "STARTED") {
    throw new Error("Import script did not complete: " + importResult);
  }
  assertManifestStatus("imported", document.fullName.fsName);
  return "IMPORT_WRITTEN|document=" + document.fullName.fsName + "|result=" + importResult;
}

  function runRefresh(document) {
    if (document.modified) throw new Error("Prepared document has unsaved changes before link refresh.");
    var refresh = updateIcmlLinksBatch(document);
    if (refresh.updated) document.save();
    if (document.modified) throw new Error("Document remained modified after link refresh batch save.");
    if (refresh.remaining > 0) {
      return "REFRESH_PROGRESS|document=" + document.fullName.fsName +
        "|updated=" + refresh.updated + "|remaining=" + refresh.remaining + "|total=" + refresh.total;
    }
    return "REFRESHED|document=" + document.fullName.fsName + "|updated=" + refresh.updated + "|total=" + refresh.total;
  }

  var opened = null;
  try {
    if (app.documents.length !== 0) throw new Error("InDesign must have no open documents before an automated Step 2 operation.");
    var documentFile = new File(DOCUMENT_PATH);
    if (!documentFile.exists) throw new Error("Missing InDesign document: " + DOCUMENT_PATH);
    opened = app.open(documentFile, false);
    if (pathKey(opened.fullName.fsName) !== pathKey(documentFile.fsName)) {
      throw new Error("InDesign opened an unexpected document.");
    }
    var result;
    if (ACTION === "audit") result = runAudit(opened);
    else if (ACTION === "prepare") result = runPrepare(opened, true);
    else if (ACTION === "relink") result = runPrepare(opened, false);
    else if (ACTION === "import") result = runImport(opened);
    else if (ACTION === "refresh") result = runRefresh(opened);
    else throw new Error("Unsupported Step 2 InDesign action: " + ACTION);
    opened.close(SaveOptions.NO);
    opened = null;
    return result;
  } catch (error) {
    try { if (opened && opened.isValid) opened.close(SaveOptions.NO); } catch (_) {}
    return "ERROR|" + String(error).replace(/[\r\n]+/g, " ");
  }
}());
