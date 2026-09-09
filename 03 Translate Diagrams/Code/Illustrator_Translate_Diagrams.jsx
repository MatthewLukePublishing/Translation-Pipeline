#target illustrator

if (typeof JSON === "undefined") {
  JSON = {};

  JSON.stringify = function (value) {
    function escapeString(str) {
      return String(str)
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\r/g, "\\r")
        .replace(/\n/g, "\\n")
        .replace(/\t/g, "\\t")
        .replace(/\f/g, "\\f");
    }

    function stringify(v) {
      var i, key, parts;

      if (v === null) return "null";

      switch (typeof v) {
        case "string":
          return '"' + escapeString(v) + '"';
        case "number":
          return isFinite(v) ? String(v) : "null";
        case "boolean":
          return v ? "true" : "false";
        case "object":
          if (v instanceof Array) {
            parts = [];
            for (i = 0; i < v.length; i++) {
              parts.push(stringify(v[i]));
            }
            return "[" + parts.join(",") + "]";
          }

          parts = [];
          for (key in v) {
            if (v.hasOwnProperty(key)) {
              parts.push(stringify(String(key)) + ":" + stringify(v[key]));
            }
          }
          return "{" + parts.join(",") + "}";
        default:
          return "null";
      }
    }

    return stringify(value);
  };

  JSON.parse = function (text) {
    return eval("(" + text + ")");
  };
}

(function () {
  function getenv(name, fallback) {
    try {
      var v = $.getenv(name);
      if (v === undefined || v === null || v === "") return fallback;
      return v;
    } catch (e) {
      return fallback;
    }
  }

  function writeTextFile(filePath, text) {
    var f = new File(filePath);
    f.encoding = "UTF-8";
    if (!f.open("w")) throw new Error("Could not open file for writing: " + filePath);
    f.write(text);
    f.close();
  }

  function readTextFile(filePath) {
    var f = new File(filePath);
    f.encoding = "UTF-8";
    if (!f.exists) throw new Error("File not found: " + filePath);
    if (!f.open("r")) throw new Error("Could not open file for reading: " + filePath);
    var text = f.read();
    f.close();
    return text;
  }

  function fileExists(filePath) {
    try {
      return new File(filePath).exists;
    } catch (e) {
      return false;
    }
  }

  function sleepMs(ms) {
    $.sleep(ms);
  }

  function waitForFile(filePath, timeoutMs, pollMs, errorJsonPath) {
    var started = new Date().getTime();

    while (true) {
      if (fileExists(filePath)) return;

      if (errorJsonPath && fileExists(errorJsonPath)) {
        throw new Error("Detected JSX error signal while waiting for file: " + filePath);
      }

      if ((new Date().getTime() - started) > timeoutMs) {
        throw new Error("Timed out waiting for file: " + filePath);
      }
      sleepMs(pollMs);
    }
  }

  function normalizeString(v) {
    return String(v == null ? "" : v);
  }

  function trimString(v) {
    return normalizeString(v).replace(/^\s+|\s+$/g, "");
  }

  function normalizeKey(v) {
    return trimString(v);
  }

  function normalizeLookupKey(v) {
    return trimString(v).toLowerCase();
  }

  function normalizeFontToken(s) {
    return normalizeString(s)
      .toLowerCase()
      .replace(/[\s\-_]+/g, "");
  }

  function normalizeIllustratorLineBreaks(text) {
    return normalizeString(text).replace(/\r\n/g, "\r").replace(/\n/g, "\r");
  }

  function hasVisibleText(text) {
    return /\S/.test(normalizeString(text));
  }

  function splitMatchTerms(raw) {
    var parts = normalizeString(raw).split("|");
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var t = trimString(parts[i]);
      if (t) out.push(t);
    }
    return out;
  }

  function fontMatchesAny(fontObj, matchTerms) {
    try {
      if (!fontObj) return false;

      var parts = [];
      try { parts.push(String(fontObj.name || "")); } catch (_) {}
      try { parts.push(String(fontObj.family || "")); } catch (_) {}
      try { parts.push(String(fontObj.style || "")); } catch (_) {}
      try { parts.push(String(fontObj.typename || "")); } catch (_) {}

      var rawHay = parts.join(" ");
      var normHay = normalizeFontToken(rawHay);

      for (var i = 0; i < matchTerms.length; i++) {
        var rawNeedle = normalizeString(matchTerms[i]);
        var normNeedle = normalizeFontToken(rawNeedle);
        if (!normNeedle) continue;
        if (normHay.indexOf(normNeedle) !== -1) return true;
      }
    } catch (e) {}

    return false;
  }

  function getRunTypeForFont(fontObj, openSansTerms, sourceCodeTerms) {
    if (fontMatchesAny(fontObj, sourceCodeTerms)) return "sourceCode";
    if (fontMatchesAny(fontObj, openSansTerms)) return "openSans";
    return "";
  }

  function sortDescendingByStart(items) {
    items.sort(function (a, b) {
      if (a.frameIndex !== b.frameIndex) return a.frameIndex - b.frameIndex;
      return b.start - a.start;
    });
    return items;
  }

  function objectKeys(obj) {
    var keys = [];
    for (var k in obj) {
      if (obj.hasOwnProperty(k)) keys.push(k);
    }
    return keys;
  }

  function escapeRegExp(text) {
    return normalizeString(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function buildBoundaryRegex(term) {
    return new RegExp("(^|[^A-Za-z0-9_])(" + escapeRegExp(term) + ")(?=$|[^A-Za-z0-9_])", "gi");
  }

  function replaceWholeTermCaseInsensitive(text, sourceTerm, targetTerm) {
    var rx = buildBoundaryRegex(sourceTerm);
    return normalizeString(text).replace(rx, function (match, before) {
      return before + targetTerm;
    });
  }

  function buildCaseInsensitiveMap(exactMap) {
    var out = {};
    for (var k in exactMap) {
      if (exactMap.hasOwnProperty(k)) {
        out[normalizeLookupKey(k)] = exactMap[k];
      }
    }
    return out;
  }

  function isLanguageKey(key) {
    key = normalizeString(key);
    if (!key) return false;
    if (key.charAt(0) === "_") return false;
    if (/ Definition$/i.test(key)) return false;
    return true;
  }

  function buildLanguageLookupFromJson(jsonPath, buildValue) {
    if (!jsonPath) return {};

    var f = new File(jsonPath);
    if (!f.exists) throw new Error("JSON file not found: " + jsonPath);

    var raw = JSON.parse(readTextFile(jsonPath));
    var result = {};
    var englishKey, entry, lang, langMap, translated;

    for (englishKey in raw) {
      if (!raw.hasOwnProperty(englishKey)) continue;

      entry = raw[englishKey];
      if (!entry || typeof entry !== "object") continue;

      langMap = {};

      for (lang in entry) {
        if (!entry.hasOwnProperty(lang)) continue;
        if (!isLanguageKey(lang)) continue;

        translated = normalizeKey(entry[lang]);
        if (translated) {
          langMap[normalizeKey(lang)] = buildValue(entry, lang, translated);
        }
      }

      result[normalizeKey(englishKey)] = langMap;
    }

    return result;
  }

  function buildExactLookupFromJson(jsonPath) {
    return buildLanguageLookupFromJson(jsonPath, function (entry, lang, translated) {
      return translated;
    });
  }

  function getLanguageOrdinal(entry, languageName) {
    var count = 0;
    var key;

    for (key in entry) {
      if (!entry.hasOwnProperty(key)) continue;
      if (!isLanguageKey(key)) continue;

      count++;
      if (normalizeKey(key) === normalizeKey(languageName)) {
        return count;
      }
    }

    return 0;
  }

  function getDefinitionForLanguage(entry, languageName) {
    var explicitKey = normalizeKey(languageName) + " Definition";
    var explicitVal = entry[explicitKey];

    if (explicitVal !== undefined && explicitVal !== null) {
      explicitVal = normalizeKey(explicitVal);
      if (explicitVal) return explicitVal;
    }

    var ordinal = getLanguageOrdinal(entry, languageName);
    if (ordinal > 0) {
      var numberedKey = "_" + ordinal;
      var numberedVal = entry[numberedKey];
      if (numberedVal !== undefined && numberedVal !== null) {
        numberedVal = normalizeKey(numberedVal);
        if (numberedVal) return numberedVal;
      }
    }

    return "";
  }

  function buildGlossaryLookupFromJson(jsonPath) {
    return buildLanguageLookupFromJson(jsonPath, function (entry, lang, targetTerm) {
      return {
        term: targetTerm,
        context: getDefinitionForLanguage(entry, lang)
      };
    });
  }

  function getSessionCacheRoot() {
    if (!$.global.__aiDiagramTranslateCache) {
      $.global.__aiDiagramTranslateCache = {
        glossaryLookups: {},
        exactLookups: {},
        openSansGlossaries: {}
      };
    }
    return $.global.__aiDiagramTranslateCache;
  }

  function getFileCacheKey(jsonPath) {
    if (!jsonPath) return "";

    var f = new File(jsonPath);
    if (!f.exists) return normalizeKey(jsonPath);

    var modified = "";
    try {
      modified = f.modified ? String(f.modified.getTime()) : "";
    } catch (_) {
      modified = "";
    }

    return normalizeKey(f.fsName || jsonPath) + "|" + modified;
  }

  function loadCachedGlossaryLookupFromJson(jsonPath) {
    if (!jsonPath) return {};

    var cacheRoot = getSessionCacheRoot();
    var cacheKey = getFileCacheKey(jsonPath);
    var cached = cacheRoot.glossaryLookups[cacheKey];
    if (cached) return cached;

    var loaded = buildGlossaryLookupFromJson(jsonPath);
    cacheRoot.glossaryLookups[cacheKey] = loaded;
    return loaded;
  }

  function loadCachedExactLookupFromJson(jsonPath) {
    if (!jsonPath) {
      return {
        exact: {},
        ci: {}
      };
    }

    var cacheRoot = getSessionCacheRoot();
    var cacheKey = getFileCacheKey(jsonPath);
    var cached = cacheRoot.exactLookups[cacheKey];
    if (cached) return cached;

    var exactLookup = buildExactLookupFromJson(jsonPath);
    var payload = {
      exact: exactLookup,
      ci: buildCaseInsensitiveMap(exactLookup)
    };
    cacheRoot.exactLookups[cacheKey] = payload;
    return payload;
  }

  function loadCachedOpenSansGlossary(newWordsLookup, newAcronymsLookup, targetLanguage, wordsJsonPath, acronymsJsonPath) {
    if (!targetLanguage) return [];

    var cacheRoot = getSessionCacheRoot();
    var cacheKey = [
      normalizeKey(targetLanguage),
      getFileCacheKey(wordsJsonPath),
      getFileCacheKey(acronymsJsonPath)
    ].join("|");

    var cached = cacheRoot.openSansGlossaries[cacheKey];
    if (cached) return cached;

    var glossaryPairs = buildOpenSansGlossary(newWordsLookup, newAcronymsLookup, targetLanguage);
    cacheRoot.openSansGlossaries[cacheKey] = glossaryPairs;
    return glossaryPairs;
  }

  function buildOpenSansGlossary(newWordsLookup, newAcronymsLookup, targetLanguage) {
    var pairsMap = {};
    var english, row;
    var out = [];
    var keys, i;

    for (english in newWordsLookup) {
      if (!newWordsLookup.hasOwnProperty(english)) continue;
      row = (newWordsLookup[english] || {})[targetLanguage];
      if (row && row.term) {
        pairsMap[english] = {
          target: normalizeKey(row.term),
          context: normalizeKey(row.context || ""),
          kind: "word"
        };
      }
    }

    for (english in newAcronymsLookup) {
      if (!newAcronymsLookup.hasOwnProperty(english)) continue;
      row = (newAcronymsLookup[english] || {})[targetLanguage];
      if (row && row.term) {
        pairsMap[english] = {
          target: normalizeKey(row.term),
          context: normalizeKey(row.context || ""),
          kind: "acronym"
        };
      }
    }

    keys = objectKeys(pairsMap);
    for (i = 0; i < keys.length; i++) {
      out.push({
        source: keys[i],
        target: pairsMap[keys[i]].target,
        context: pairsMap[keys[i]].context,
        kind: pairsMap[keys[i]].kind
      });
    }

    out.sort(function (a, b) {
      return b.source.length - a.source.length;
    });

    return out;
  }

  function findGlossaryPairsInText(text, glossaryPairs) {
    var matched = [];
    var i, pair, rx;
    var sourceText = normalizeString(text);

    for (i = 0; i < glossaryPairs.length; i++) {
      pair = glossaryPairs[i];
      rx = buildBoundaryRegex(pair.source);
      if (rx.test(sourceText)) matched.push(pair);
    }

    return matched;
  }

  function addGlossaryUsage(acc, glossaryMatches) {
    var i, pair, dedupeKey;
    for (i = 0; i < glossaryMatches.length; i++) {
      pair = glossaryMatches[i];
      dedupeKey = normalizeLookupKey(pair.source) + "\n" + pair.target;
      if (!acc._seen[dedupeKey]) {
        acc._seen[dedupeKey] = true;
        acc.items.push({
          source: pair.source,
          target: pair.target,
          context: pair.context || "",
          kind: pair.kind || "word"
        });
      }
    }
  }

  function pushRun(runs, nextIdRef, frameIndex, runStart, runLength, runText, runType, glossaryPairs, glossaryUsageAcc) {
    if (!hasVisibleText(runText)) return;

    var runId = String(nextIdRef.value++);
    var payload = {
      id: runId,
      frameIndex: frameIndex,
      start: runStart,
      length: runLength,
      runType: runType
    };

    if (runType === "openSans") {
      payload.originalText = runText;

      if (glossaryPairs && glossaryPairs.length) {
        var matchedGlossaryPairs = findGlossaryPairsInText(runText, glossaryPairs);
        if (matchedGlossaryPairs.length) {
          payload.glossaryMatches = [];
          for (var i = 0; i < matchedGlossaryPairs.length; i++) {
            payload.glossaryMatches.push({
              source: matchedGlossaryPairs[i].source,
              target: matchedGlossaryPairs[i].target
            });
          }
          addGlossaryUsage(glossaryUsageAcc, matchedGlossaryPairs);
        }
      }
    } else {
      payload.text = runText;
    }

    runs.push(payload);
  }

  function collectRunsForFrame(tf, frameIndex, openSansTerms, sourceCodeTerms, nextIdRef, glossaryPairs, glossaryUsageAcc, openSansRuns, sourceCodeRuns) {
    var charCount = 0;

    try {
      charCount = tf.characters.length;
    } catch (e) {
      throw new Error("Could not read text frame characters at frame index " + frameIndex + ": " + e.message);
    }

    var inRun = false;
    var runStart = -1;
    var runText = "";
    var runType = "";
    var i, ch, currentType, fontObj;

    function flushRun(runLength) {
      if (runType === "openSans") {
        pushRun(openSansRuns, nextIdRef, frameIndex, runStart, runLength, runText, runType, glossaryPairs, glossaryUsageAcc);
      } else if (runType === "sourceCode") {
        pushRun(sourceCodeRuns, nextIdRef, frameIndex, runStart, runLength, runText, runType, null, glossaryUsageAcc);
      }
    }

    for (i = 0; i < charCount; i++) {
      ch = "";
      currentType = "";

      try {
        ch = tf.characters[i].contents;
      } catch (e1) {
        ch = "";
      }

      try {
        fontObj = tf.characters[i].characterAttributes.textFont;
        currentType = getRunTypeForFont(fontObj, openSansTerms, sourceCodeTerms);
      } catch (e2) {
        currentType = "";
      }

      if (currentType) {
        if (!inRun) {
          inRun = true;
          runStart = i;
          runText = "";
          runType = currentType;
        } else if (runType !== currentType) {
          flushRun(i - runStart);
          runStart = i;
          runText = "";
          runType = currentType;
        }

        runText += ch;
      } else {
        if (inRun) {
          flushRun(i - runStart);
          inRun = false;
          runStart = -1;
          runText = "";
          runType = "";
        }
      }
    }

    if (inRun) {
      flushRun(charCount - runStart);
    }
  }

  function scanDocument(doc, openSansTerms, sourceCodeTerms, glossaryPairs, targetLanguage) {
    var openSansRuns = [];
    var sourceCodeRuns = [];
    var nextIdRef = { value: 1 };
    var glossaryUsageAcc = { items: [], _seen: {} };
    var issues = [];

    for (var i = 0; i < doc.textFrames.length; i++) {
      try {
        collectRunsForFrame(
          doc.textFrames[i],
          i,
          openSansTerms,
          sourceCodeTerms,
          nextIdRef,
          glossaryPairs,
          glossaryUsageAcc,
          openSansRuns,
          sourceCodeRuns
        );
      } catch (e) {
        issues.push("Frame " + i + ": " + e.message);
      }
    }

    return {
      file: doc.fullName ? doc.fullName.fsName : doc.name,
      targetLanguage: targetLanguage,
      count: openSansRuns.length,
      runs: openSansRuns,
      sourceCodeCount: sourceCodeRuns.length,
      sourceCodeRuns: sourceCodeRuns,
      glossary: glossaryUsageAcc.items,
      issues: issues
    };
  }

  function makeRunMap(scanPayload) {
    var map = {};
    var i;
    var runs = (scanPayload && scanPayload.runs) ? scanPayload.runs : [];
    var sourceCodeRuns = (scanPayload && scanPayload.sourceCodeRuns) ? scanPayload.sourceCodeRuns : [];

    for (i = 0; i < runs.length; i++) {
      map[String(runs[i].id)] = runs[i];
    }
    for (i = 0; i < sourceCodeRuns.length; i++) {
      map[String(sourceCodeRuns[i].id)] = sourceCodeRuns[i];
    }

    return map;
  }

  function buildSourceCodeTranslationItems(scanPayload, acronymsSymbolsLookup, acronymsSymbolsLookupCI, targetLanguage) {
    var items = [];
    var sourceRuns = (scanPayload && scanPayload.sourceCodeRuns) ? scanPayload.sourceCodeRuns : [];
    var i, run, key, row, translated;

    for (i = 0; i < sourceRuns.length; i++) {
      run = sourceRuns[i];
      key = normalizeKey(run.text);
      row = acronymsSymbolsLookup[key];

      if (!row) {
        row = acronymsSymbolsLookupCI[normalizeLookupKey(key)];
      }

      translated = run.text;
      if (row) {
        var t = normalizeKey(row[targetLanguage]);
        if (t) translated = t;
      }

      items.push({
        id: run.id,
        frameIndex: run.frameIndex,
        start: run.start,
        length: run.length,
        translated: translated
      });
    }

    return items;
  }

  function enforceRunLevelGlossary(text, scanRun) {
    var out = normalizeString(text);
    var matches = (scanRun && scanRun.glossaryMatches) ? scanRun.glossaryMatches : [];
    var i, source, target;

    for (i = 0; i < matches.length; i++) {
      source = normalizeString(matches[i].source);
      target = normalizeString(matches[i].target);
      if (!source || !target) continue;
      out = replaceWholeTermCaseInsensitive(out, source, target);
    }

    return out;
  }

  function buildOpenSansTranslationItems(translationPayload, scanRunMap) {
    var srcItems = (translationPayload && translationPayload.translations) ? translationPayload.translations : [];
    var out = [];
    var i, item, scanRun, translated;

    for (i = 0; i < srcItems.length; i++) {
      item = srcItems[i];
      scanRun = scanRunMap[String(item.id)];

      if (!scanRun) {
        throw new Error("Translation payload referenced unknown run id: " + String(item.id));
      }

      translated = normalizeString(item.translated);
      translated = enforceRunLevelGlossary(translated, scanRun);

      out.push({
        id: item.id,
        frameIndex: scanRun.frameIndex,
        start: scanRun.start,
        length: scanRun.length,
        translated: translated
      });
    }

    return out;
  }

  function applyTextReplacement(tf, startIndex, length, newText) {
    var endIndex = startIndex + length;
    var contents = tf.contents;

    if (startIndex < 0 || length < 0 || endIndex > contents.length) {
      throw new Error(
        "Invalid replacement range. start=" + startIndex +
        ", length=" + length +
        ", contents.length=" + contents.length
      );
    }

    var before = contents.substring(0, startIndex);
    var after = contents.substring(endIndex);
    tf.contents = before + normalizeIllustratorLineBreaks(newText) + after;
  }

  function applyTranslations(doc, allItems) {
    var issues = [];
    sortDescendingByStart(allItems);

    for (var i = 0; i < allItems.length; i++) {
      var item = allItems[i];

      try {
        var tf = doc.textFrames[item.frameIndex];
        if (!tf) {
          issues.push("Missing text frame for item id " + item.id + " at frame index " + item.frameIndex);
          continue;
        }
        applyTextReplacement(tf, item.start, item.length, item.translated);
      } catch (e) {
        issues.push("Failed to apply item id " + item.id + ": " + e.message);
      }
    }

    return issues;
  }

  function closeDocumentWithoutSaving(doc) {
    try {
      if (doc) {
        doc.close(SaveOptions.DONOTSAVECHANGES);
      }
    } catch (e) {}
  }

  function makeIllustratorSaveOptions() {
    var opts = new IllustratorSaveOptions();
    try { opts.embedICCProfile = true; } catch (_) {}

    var versionGuess = null;
    try {
      var raw = String(app.version || "");
      var major = parseInt(raw.split(".")[0], 10);
      if (isFinite(major)) {
        var key = "ILLUSTRATOR" + major;
        if (Compatibility[key] !== undefined) {
          versionGuess = Compatibility[key];
        }
      }
    } catch (_) {}

    if (versionGuess !== null) {
      try { opts.compatibility = versionGuess; } catch (_) {}
    }

    return opts;
  }

  function saveDocumentToPath(doc, filePath) {
    var target = new File(filePath);
    var saveOpts = makeIllustratorSaveOptions();
    var lastErr = null;

    // Always use saveAs with the explicit path. Plain `doc.save()` throws
    // "You must provide a file path for documents which have not yet been
    // saved" if Illustrator lost the document's bound path (which can happen
    // when the source lives on a cloud-sync placeholder filesystem like
    // odrive). We already know the target path, so use it explicitly.
    try {
      doc.saveAs(target, saveOpts);
      return;
    } catch (e1) {
      lastErr = e1;
    }

    try {
      doc.saveAs(target);
      return;
    } catch (e2) {
      lastErr = e2;
    }

    var msg = lastErr && lastErr.message ? lastErr.message : String(lastErr);
    throw new Error("Failed to save document to '" + filePath + "': " + msg);
  }

  function writeErrorFile(errorJsonPath, payload) {
    if (!errorJsonPath) return;

    try {
      writeTextFile(errorJsonPath, JSON.stringify(payload, null, 2));
    } catch (_) {}
  }

  var mode = getenv("AI_MODE", "process");
  var filePath = getenv("AI_BATCH_FILE", "");
  var outputPath = getenv("AI_OUTPUT_FILE", "");
  var scanJsonPath = getenv("AI_SCAN_JSON", "");
  var translationJsonPath = getenv("AI_TRANSLATION_JSON", "");
  var startupJsonPath = getenv("AI_STARTUP_JSON", "");
  var errorJsonPath = getenv("AI_ERROR_JSON", "");

  var openSansTerms = splitMatchTerms(getenv("AI_OPEN_SANS_MATCHES", "open sans|opensans|open-sans"));
  var sourceCodeTerms = splitMatchTerms(getenv("AI_SOURCE_CODE_MATCHES", "source code pro|sourcecodepro|source-code-pro|source code|sourcecode|source-code"));

  var targetLanguage = getenv("AI_TARGET_LANGUAGE", "");
  var glossaryTermKey = getenv("AI_GLOSSARY_TERM_KEY", targetLanguage);
  var symbolLanguage = getenv("AI_SYMBOL_LANGUAGE", targetLanguage);
  var waitTimeoutMs = Number(getenv("AI_WAIT_TIMEOUT_MS", "600000"));
  var waitPollMs = Number(getenv("AI_WAIT_POLL_MS", "500"));

  var newWordsJson = getenv("AI_NEW_WORDS_JSON", "");
  var newAcronymsJson = getenv("AI_NEW_ACRONYMS_JSON", "");
  var newAcronymsSymbolsJson = getenv("AI_NEW_ACRONYMS_SYMBOLS_JSON", "");

  var newWordsLookup = {};
  var newAcronymsLookup = {};
  var newAcronymsSymbolsLookup = {};
  var newAcronymsSymbolsLookupCI = {};
  var glossaryPairs = [];
  var doc = null;

  var originalInteraction = app.userInteractionLevel;

  try {
    if (!filePath) throw new Error("AI_BATCH_FILE is missing.");
    if (!outputPath || new File(outputPath).fsName.toLowerCase() === new File(filePath).fsName.toLowerCase()) throw new Error("A separate AI_OUTPUT_FILE is required; original diagrams are never saved in place by the worker.");
    if (new File(outputPath).exists) throw new Error("Staged diagram output already exists.");
    if (app.documents.length) throw new Error("Close existing Illustrator documents before starting an isolated diagram batch.");
    app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;
    if (!scanJsonPath) throw new Error("AI_SCAN_JSON is missing.");
    if (!translationJsonPath) throw new Error("AI_TRANSLATION_JSON is missing.");

    if (startupJsonPath) {
      writeTextFile(startupJsonPath, JSON.stringify({
        status: "started",
        file: filePath,
        timestamp: new Date().toUTCString()
      }, null, 2));
    }

    if (errorJsonPath && fileExists(errorJsonPath)) {
      try {
        var existingErrFile = new File(errorJsonPath);
        existingErrFile.remove();
      } catch (_) {}
    }

    if (newWordsJson && new File(newWordsJson).exists) {
      newWordsLookup = loadCachedGlossaryLookupFromJson(newWordsJson);
    }

    if (newAcronymsJson && new File(newAcronymsJson).exists) {
      newAcronymsLookup = loadCachedGlossaryLookupFromJson(newAcronymsJson);
    }

    if (newAcronymsSymbolsJson && new File(newAcronymsSymbolsJson).exists) {
      var cachedSymbolsLookup = loadCachedExactLookupFromJson(newAcronymsSymbolsJson);
      newAcronymsSymbolsLookup = cachedSymbolsLookup.exact;
      newAcronymsSymbolsLookupCI = cachedSymbolsLookup.ci;
    }

    if (glossaryTermKey && (objectKeys(newWordsLookup).length || objectKeys(newAcronymsLookup).length)) {
      glossaryPairs = loadCachedOpenSansGlossary(
        newWordsLookup,
        newAcronymsLookup,
        glossaryTermKey,
        newWordsJson,
        newAcronymsJson
      );
    }

    var f = new File(filePath);
    if (!f.exists) throw new Error("Target file does not exist: " + filePath);

    doc = app.open(f);

    if (mode !== "process") {
      throw new Error("Unknown AI_MODE: " + mode);
    }

    var scanPayload = scanDocument(doc, openSansTerms, sourceCodeTerms, glossaryPairs, targetLanguage);
    writeTextFile(scanJsonPath, JSON.stringify(scanPayload));

    waitForFile(translationJsonPath, waitTimeoutMs, waitPollMs, errorJsonPath);

    var scanRunMap = makeRunMap(scanPayload);
    var translationPayload = JSON.parse(readTextFile(translationJsonPath));

    var openSansItems = buildOpenSansTranslationItems(translationPayload, scanRunMap);
    var sourceCodeItems = buildSourceCodeTranslationItems(
      scanPayload,
      newAcronymsSymbolsLookup,
      newAcronymsSymbolsLookupCI,
      symbolLanguage
    );

    var allItems = openSansItems.concat(sourceCodeItems);
    var applyIssues = applyTranslations(doc, allItems);

    if (applyIssues.length) {
      writeErrorFile(errorJsonPath, {
        stage: "applyTranslations",
        message: "One or more translations could not be applied cleanly.",
        file: filePath,
        issues: applyIssues
      });
      throw new Error("One or more translations could not be applied cleanly.");
    }

    saveDocumentToPath(doc, outputPath);
    doc.close(SaveOptions.DONOTSAVECHANGES);
    doc = null;
  } catch (err) {
    try {
      $.writeln("ERROR: " + err.message);
    } catch (_) {}

    writeErrorFile(errorJsonPath, {
      stage: "jsxWorker",
      message: err.message,
      file: filePath,
      line: err.line || null
    });

    closeDocumentWithoutSaving(doc);
    throw err;
  } finally {
    app.userInteractionLevel = originalInteraction;
  }
})();
