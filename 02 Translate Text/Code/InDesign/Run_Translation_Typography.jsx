#target "InDesign"

(function () {
  var action = __ACTION_JS__, documentPath = __DOCUMENT_JS__;
  var start = __START_JS__, count = __COUNT_JS__;
  var requested = __SETTINGS_JS__, languageName = __LANGUAGE_JS__;
  function key(v) { return String(v || "").replace(/\\/g, "/").toLowerCase(); }
  function enc(v) { return encodeURIComponent(String(v === undefined || v === null ? "" : v)); }
  function contains(items, value) {
    for (var i = 0; i < items.length; i++) if (items[i] === value) return true;
    return false;
  }
  function type(v) { try { return String(v.reflect.name); } catch (_) { return ""; } }
  function stylePath(style) {
    var parts = [String(style.name)], parent = style.parent, guard = 0;
    while (parent && type(parent) === "ParagraphStyleGroup") {
      if (++guard > 20) throw new Error("Unexpected paragraph-style nesting.");
      parts.unshift(String(parent.name)); parent = parent.parent;
    }
    return parts.join("/");
  }
  function boundedLength(length, limit, label) {
    if (length > limit) throw new Error(label + " exceeds the bounded audit limit: " + length);
    return length;
  }
  var interaction = app.scriptPreferences.userInteractionLevel;
  try {
    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
    if (app.backgroundTasks.length) throw new Error("InDesign background work is active.");
    var file = new File(documentPath), doc;
    if (!file.exists) throw new Error("Missing InDesign document: " + documentPath);
    if (action === "open") {
      if (app.documents.length) throw new Error("Close existing documents before this isolated typography operation; none were changed.");
      doc = app.open(file, false);
      if (key(doc.fullName.fsName) !== key(file.fsName)) throw new Error("Unexpected document path.");
      return "OPENED|path=" + enc(doc.fullName.fsName);
    }
    if (app.documents.length !== 1) throw new Error("Expected only the isolated typography document.");
    doc = app.documents[0];
    if (key(doc.fullName.fsName) !== key(file.fsName)) throw new Error("Unexpected document path.");
    if (action === "checkpoint") {
      if (doc.modified) doc.save();
      if (doc.modified) throw new Error("Document remains modified after checkpoint.");
      return "CHECKPOINT_SAVED|path=" + enc(documentPath);
    }
    if (doc.modified) throw new Error("Document has unsaved changes; they were preserved.");
    if (action === "close") {
      doc.close(SaveOptions.NO);
      return "CLOSED|path=" + enc(documentPath);
    }
    if (count < 1 || count > 100 || start < 0 || Math.floor(start) !== start) throw new Error("Invalid bounded typography range.");
    var rows = [], styles, i, s, finish;
    if (action === "summary") {
      return "SUMMARY|name=" + enc(doc.name) + "|path=" + enc(doc.fullName.fsName) + "|modified=" + enc(doc.modified) +
        "|pages=" + enc(boundedLength(doc.pages.length, 2000, "Pages")) +
        "|stories=" + enc(boundedLength(doc.stories.length, 5000, "Stories")) +
        "|links=" + enc(boundedLength(doc.links.length, 10000, "Links")) +
        "|paragraphStyles=" + enc(boundedLength(doc.allParagraphStyles.length, 1000, "Styles")) +
        "|pageWidth=" + enc(doc.documentPreferences.pageWidth) + "|pageHeight=" + enc(doc.documentPreferences.pageHeight);
    }
    if (action === "styles" || action === "language") {
      styles = doc.allParagraphStyles;
      boundedLength(styles.length, 1000, "Styles");
      finish = Math.min(styles.length, start + count);
      var language = null;
      if (action === "language") {
        boundedLength(app.languagesWithVendors.length, 250, "Languages");
        for (i = 0; i < app.languagesWithVendors.length; i++) {
          if (String(app.languagesWithVendors[i].name).toLowerCase() === String(languageName).toLowerCase()) language = app.languagesWithVendors[i];
        }
        if (!language) throw new Error("InDesign language is not installed: " + languageName);
      }
      for (i = start; i < finish; i++) {
        s = styles[i];
        var currentPath = stylePath(s), currentLanguage = "", basedOn = "";
        try { currentLanguage = s.appliedLanguage.name; } catch (_) {}
        if (action === "language") {
          if (!/^\[.*\]$/.test(currentPath) && currentLanguage !== language.name) {
            s.appliedLanguage = language;
            rows.push("LANGUAGE|path=" + enc(currentPath) + "|before=" + enc(currentLanguage) + "|after=" + enc(language.name));
          }
        } else {
          try { if (s.basedOn && s.basedOn.isValid) basedOn = stylePath(s.basedOn); } catch (_) {}
          rows.push("STYLE|id=" + enc(s.id) + "|name=" + enc(s.name) + "|path=" + enc(currentPath) +
            "|basedOn=" + enc(basedOn) + "|pointSize=" + enc(s.pointSize) + "|leading=" + enc(s.leading) +
            "|language=" + enc(currentLanguage) + "|fontStyle=" + enc(s.fontStyle));
        }
      }
      return rows.length ? rows.join("\n") : "UNCHANGED";
    }
    if (action === "apply") {
      boundedLength(requested.length, 100, "Requested style settings");
      if (count > 5) throw new Error("At most five style settings may be applied per call.");
      styles = doc.allParagraphStyles;
      boundedLength(styles.length, 1000, "Styles");
      var byPath = {};
      for (i = 0; i < styles.length; i++) byPath[stylePath(styles[i])] = styles[i];
      finish = Math.min(requested.length, start + count);
      // Validate every target in this batch before changing any style.
      for (i = start; i < finish; i++) {
        if (!byPath[requested[i].path] || !byPath[requested[i].path].isValid) throw new Error("Paragraph style not found: " + requested[i].path);
      }
      for (i = start; i < finish; i++) {
        var request = requested[i]; s = byPath[request.path];
        var beforeSize = s.pointSize, beforeLeading = s.leading;
        if (request.pointSize !== undefined && request.pointSize !== null) s.pointSize = Number(request.pointSize);
        if (request.leading !== undefined && request.leading !== null) s.leading = Number(request.leading);
        rows.push("STYLE|path=" + enc(request.path) + "|beforePointSize=" + enc(beforeSize) + "|afterPointSize=" + enc(s.pointSize) +
          "|beforeLeading=" + enc(beforeLeading) + "|afterLeading=" + enc(s.leading) + "|basis=" + enc(request.basis || ""));
      }
      return rows.length ? rows.join("\n") : "UNCHANGED";
    }
    if (action === "recompose") { doc.recompose(); return "RECOMPOSED"; }
    if (action === "links") {
      boundedLength(doc.links.length, 10000, "Links");
      finish = Math.min(doc.links.length, start + count);
      var missing = 0, outdated = 0, embedded = 0;
      for (i = start; i < finish; i++) {
        var link = doc.links[i], status = link.status, problem = false;
        if (status === LinkStatus.LINK_MISSING) { missing++; problem = true; }
        else if (status === LinkStatus.LINK_OUT_OF_DATE) { outdated++; problem = true; }
        else if (status === LinkStatus.LINK_EMBEDDED) embedded++;
        if (problem) rows.push("LINK|index=" + enc(i) + "|name=" + enc(link.name) + "|path=" + enc(link.filePath) + "|status=" + enc(status));
      }
      rows.push("LINKS|missing=" + missing + "|outdated=" + outdated + "|embedded=" + embedded + "|total=" + (finish - start));
      return rows.join("\n");
    }
    if (action === "stories") {
      boundedLength(doc.stories.length, 5000, "Stories");
      finish = Math.min(doc.stories.length, start + count);
      for (i = start; i < finish; i++) {
        s = doc.stories[i];
        var over = Boolean(s.overflows), linkName = "", linkPath = "", pages = [], names = [];
        if (s.itemLink && s.itemLink.isValid) { linkName = s.itemLink.name; linkPath = s.itemLink.filePath; }
        if (over) {
          var containers = s.textContainers, paragraphs = s.paragraphs;
          boundedLength(containers.length, 50, "Story text containers");
          boundedLength(paragraphs.length, 10000, "Story paragraphs");
          for (var t = 0; t < containers.length; t++) {
            var page = containers[t].parentPage;
            if (page && page.isValid && !contains(pages, String(page.name))) pages.push(String(page.name));
          }
          for (var p = 0; p < paragraphs.length; p++) {
            var name = stylePath(paragraphs[p].appliedParagraphStyle);
            if (!contains(names, name)) names.push(name);
          }
        }
        rows.push("STORY|index=" + i + "|id=" + enc(s.id) + "|overflows=" + over + "|tableCount=" + boundedLength(s.tables.length, 100, "Story tables") + "|linkName=" + enc(linkName) +
          "|linkPath=" + enc(linkPath) + "|pages=" + enc(pages.join(",")) + "|styles=" + enc(names.join(";")));
      }
      return rows.length ? rows.join("\n") : "UNCHANGED";
    }
    if (action === "tables" || action === "cells") {
      if (requested.length !== 1) throw new Error("Expected one explicit table audit scope.");
      var scope = requested[0];
      s = doc.stories.itemByID(Number(scope.storyId));
      if (!s || !s.isValid) throw new Error("Table audit story not found.");
      var tables = s.tables;
      boundedLength(tables.length, 100, "Story tables");
      if (action === "tables") {
        finish = Math.min(tables.length, start + count);
        for (i = start; i < finish; i++) {
          rows.push("TABLE|storyId=" + enc(s.id) + "|index=" + i + "|id=" + enc(tables[i].id) +
            "|cellCount=" + boundedLength(tables[i].cells.length, 10000, "Table cells"));
        }
      } else {
        if (count > 50) throw new Error("At most fifty table cells may be audited per call.");
        var table = tables.itemByID(Number(scope.tableId));
        if (!table || !table.isValid) throw new Error("Table audit target not found.");
        var cells = table.cells;
        boundedLength(cells.length, 10000, "Table cells");
        finish = Math.min(cells.length, start + count);
        for (i = start; i < finish; i++) {
          var cell = cells[i];
          if (cell.tables.length) throw new Error("Nested tables require a separately scoped audit; no passing report may be published.");
          rows.push("CELL|storyId=" + enc(s.id) + "|tableId=" + enc(table.id) + "|index=" + i +
            "|name=" + enc(cell.name) + "|overflows=" + Boolean(cell.overflows));
        }
      }
      return rows.length ? rows.join("\n") : "UNCHANGED";
    }
    throw new Error("Unsupported typography action: " + action);
  } catch (error) {
    // Never close, save, discard, or touch another document after an uncertain result.
    return "ERROR|" + String(error).replace(/[\r\n]+/g, " ");
  } finally {
    app.scriptPreferences.userInteractionLevel = interaction;
  }
}());
