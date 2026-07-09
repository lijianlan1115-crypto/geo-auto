// 平台识别 + 千问截图兜底补丁：
// 1. 即使用户手动新增平台，名称/URL 像五个平台，也自动归一到内置平台 key。
// 2. 千问命中关键词后，强制滚动到目标关键词所在位置，再拉红框并重新截图。
(function () {
  const sleepLocal = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function canonicalPlatformKey(value, name, url) {
    const text = `${value || ""} ${name || ""} ${url || ""}`.toLowerCase();

    if (/doubao|豆包|www\.doubao\.com|doubao\.com/.test(text)) return "doubao";
    if (/qianwen|千问|通义|tongyi\.aliyun\.com|aliyun\.com\/qianwen/.test(text)) return "qianwen";
    if (/deepseek|深度求索|chat\.deepseek\.com/.test(text)) return "deepseek";
    if (/yuanbao|元宝|腾讯元宝|yuanbao\.tencent\.com/.test(text)) return "yuanbao";
    if (/wenxin|文心|一言|yiyan|chat\.baidu\.com|baidu\.com/.test(text)) return "wenxin";

    return value || "doubao";
  }

  function normalizeTaskPlatform(task) {
    if (!task || typeof task !== "object") return task;

    const originalPlatform = task.platform || "";
    const canonical = canonicalPlatformKey(
      task.platform,
      task.platform_name,
      task.platform_url || task.url
    );

    if (canonical && canonical !== originalPlatform) {
      task.original_platform = originalPlatform;
      task.platform = canonical;
      task.platform_normalized = true;
    }

    return task;
  }

  function normalizePlatformRows() {
    const root = document.getElementById("geo-auto-root");
    const shadow = root && root.shadowRoot;
    if (!shadow) return;

    shadow.querySelectorAll(".platform-row").forEach((row, index) => {
      const nameInput = row.querySelector("[data-platform-name]");
      const urlInput = row.querySelector("[data-platform-url]");
      const name = nameInput ? nameInput.value : "";
      const url = urlInput ? urlInput.value : "";
      const current = row.dataset.platformKey || `custom_${index + 1}`;
      const canonical = canonicalPlatformKey(current, name, url);

      if (canonical && canonical !== current) {
        row.dataset.originalPlatformKey = current;
        row.dataset.platformKey = canonical;
      }
    });
  }

  function installPanelNormalizer() {
    const root = document.getElementById("geo-auto-root");
    const shadow = root && root.shadowRoot;
    if (!shadow || shadow.__geoPlatformRowsNormalized) return;
    shadow.__geoPlatformRowsNormalized = true;

    normalizePlatformRows();
    shadow.addEventListener("input", normalizePlatformRows, true);
    shadow.addEventListener("change", normalizePlatformRows, true);
    shadow.addEventListener("click", () => setTimeout(normalizePlatformRows, 0), true);

    const platformsBox = shadow.querySelector("[data-platforms]");
    if (platformsBox && window.MutationObserver) {
      const observer = new MutationObserver(() => normalizePlatformRows());
      observer.observe(platformsBox, { childList: true, subtree: true, attributes: true });
    }
  }

  function rectToPlain(rect) {
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }

  function rectInViewport(rect, margin = 10) {
    return Boolean(rect && rect.width > 0 && rect.height > 0 &&
      rect.top >= margin && rect.left >= margin &&
      rect.bottom <= window.innerHeight - margin &&
      rect.right <= window.innerWidth - margin);
  }

  function visibleMarkRect() {
    const marks = Array.from(document.querySelectorAll(".geo-keyword-mark"));
    for (const mark of marks) {
      const rects = Array.from(mark.getClientRects ? mark.getClientRects() : []);
      for (const rect of rects) {
        if (rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth) {
          return rect;
        }
      }
    }
    return null;
  }

  function localKeywordTerms(task, result) {
    const terms = [];
    if (result && Array.isArray(result.matched_keywords)) terms.push(...result.matched_keywords);
    if (task && Array.isArray(task.keywords)) terms.push(...task.keywords);
    if (task && task.keyword) terms.push(task.keyword);
    return [...new Set(terms.map((item) => String(item || "").trim()).filter((item) => item.length >= 2))];
  }

  async function forceQianwenKeywordVisible(task, result) {
    const matchedKeywords = result && Array.isArray(result.matched_keywords) ? result.matched_keywords : [];
    const keywords = task && Array.isArray(task.keywords) ? task.keywords : localKeywordTerms(task, result);
    const judgeResult = {
      matched_text: matchedKeywords[0] || keywords[0] || "",
      keyword: matchedKeywords[0] || keywords[0] || "",
    };

    const searchTerms = typeof keywordSearchTerms === "function"
      ? keywordSearchTerms(matchedKeywords, judgeResult, keywords)
      : localKeywordTerms(task, result);

    if (!searchTerms.length) return { ok: false, reason: "没有可用于定位的关键词" };
    if (typeof clearKeywordMarks === "function") clearKeywordMarks();

    let matches = [];
    if (typeof findQianwenKeywordMatchesByScroll === "function") {
      matches = await findQianwenKeywordMatchesByScroll(searchTerms);
    }
    if (!matches.length && typeof findKeywordWithNativeFind === "function") {
      matches = await findKeywordWithNativeFind(searchTerms, null);
    }
    if (!matches.length && typeof findKeywordMatchesByScroll === "function") {
      matches = await findKeywordMatchesByScroll(searchTerms, null);
    }
    if (!matches.length) {
      return { ok: false, reason: "DOM 内没有定位到目标关键词", search_terms: searchTerms.slice(0, 8) };
    }

    const match = matches[0];

    for (let attempt = 0; attempt < 3; attempt++) {
      if (typeof clearKeywordMarks === "function") clearKeywordMarks();

      if (typeof forceCenterQianwenMatch === "function") {
        await forceCenterQianwenMatch(match, 1800);
      } else if (match.range && match.range.startContainer) {
        const start = match.range.startContainer;
        const el = start.nodeType === Node.TEXT_NODE ? start.parentElement : start;
        if (el && el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      }

      if (typeof smoothScrollKeywordToCenter === "function" && match.range) {
        await smoothScrollKeywordToCenter(match.range, 2600);
      }

      if (typeof waitForScrollStable === "function") await waitForScrollStable(1800);
      else await sleepLocal(800);

      let rects = [];
      if (typeof drawKeywordAndEnsureViewportSmooth === "function") {
        rects = await drawKeywordAndEnsureViewportSmooth(match);
      } else if (typeof drawDOMKeywordBoxes === "function") {
        rects = drawDOMKeywordBoxes([match]);
      }

      await new Promise((resolve) => requestAnimationFrame(resolve));
      await sleepLocal(300);

      let firstRect = visibleMarkRect();
      if (!firstRect && typeof targetRectForKeywordMatch === "function") firstRect = targetRectForKeywordMatch(match);
      if (!firstRect && typeof bestRangeRect === "function" && match.range) firstRect = bestRangeRect(match.range);

      if (rectInViewport(firstRect) || attempt === 2) {
        return {
          ok: Boolean(firstRect && firstRect.width > 0 && firstRect.height > 0),
          match,
          rects,
          first_rect: rectToPlain(firstRect),
          keyword: match.keyword,
          context: match.context || "",
          search_terms: searchTerms.slice(0, 8),
        };
      }
    }

    return { ok: false, reason: "滚动后关键词仍不在截图视口内" };
  }

  async function recaptureQianwenScreenshot(task, result) {
    if (!task || !result || !result.matched) return result;
    if (task.platform !== "qianwen") return result;

    const located = await forceQianwenKeywordVisible(task, result);
    const runDebug = Array.isArray(result.run_debug) ? [...result.run_debug] : [];

    if (!located.ok || !located.first_rect) {
      runDebug.push({
        type: "qianwen_screenshot_recapture",
        ok: false,
        reason: located.reason || "未能定位关键词",
        search_terms: located.search_terms || [],
      });
      return { ...result, run_debug: runDebug };
    }

    let screenshotDataUrl = null;
    if (typeof prepareForScreenshot === "function") await prepareForScreenshot();
    if (typeof captureVisibleScreenshot === "function") screenshotDataUrl = await captureVisibleScreenshot();
    if (typeof cleanupAfterScreenshot === "function") cleanupAfterScreenshot();

    if (screenshotDataUrl && typeof annotateScreenshotDataUrl === "function") {
      screenshotDataUrl = await annotateScreenshotDataUrl(screenshotDataUrl, located.first_rect);
    }

    const domLocation = {
      ...(result.dom_location || {}),
      matched: true,
      matched_keywords: [located.keyword || (result.matched_keywords && result.matched_keywords[0])].filter(Boolean),
      rects: (located.rects || []).map((r) => rectToPlain(r)).filter(Boolean),
      first_rect: located.first_rect,
      context: located.context || "",
      needs_image_annotation: true,
      match_type: "qianwen_forced_keyword_visible_recapture",
    };

    runDebug.push({
      type: "qianwen_screenshot_recapture",
      ok: Boolean(screenshotDataUrl),
      keyword: located.keyword,
      first_rect: located.first_rect,
      search_terms: located.search_terms || [],
    });

    return {
      ...result,
      screenshot_data_url: screenshotDataUrl || result.screenshot_data_url,
      dom_location: domLocation,
      run_debug: runDebug,
    };
  }

  function wrapRunner() {
    if (!window.geoAutomationRun || window.__geoPlatformPatchWrapped) return;
    const originalRun = window.geoAutomationRun;
    window.geoAutomationRun = async function geoAutomationRunWithPlatformNormalize(task) {
      const normalizedTask = normalizeTaskPlatform(task);
      const result = await originalRun(normalizedTask);
      try {
        return await recaptureQianwenScreenshot(normalizedTask, result);
      } catch (error) {
        const runDebug = Array.isArray(result && result.run_debug) ? [...result.run_debug] : [];
        runDebug.push({
          type: "qianwen_screenshot_recapture",
          ok: false,
          reason: String(error && error.message ? error.message : error),
        });
        return result ? { ...result, run_debug: runDebug } : result;
      }
    };
    window.__geoPlatformPatchWrapped = true;
  }

  function installAll() {
    wrapRunner();
    installPanelNormalizer();
    normalizePlatformRows();
  }

  installAll();
  setTimeout(installAll, 0);
  setTimeout(installAll, 500);
  setInterval(installAll, 2000);
})();
