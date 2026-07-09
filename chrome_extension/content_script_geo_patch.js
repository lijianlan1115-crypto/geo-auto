// 通用 GEO 追问补丁：
// 1. 去掉固定学校模板。
// 2. 追问必须由本地 AI 根据真实回复生成。
// 3. 每轮拿到真实回复后，同时进行关键词判断/定位和 AI 追问预生成。
// 4. 如果命中关键词，丢弃预生成追问并停止；如果未命中，直接发送预生成追问。
(function () {
  const normalizeText = (text) => String(text || "").replace(/\s+/g, "").replace(/[，。！？、,.!?；;：:（）()【】\[\]《》<>-]+/g, "");

  const splitKeywordList = (value) => {
    if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
    return String(value || "")
      .split(/[\n,，、;；|/]+|\s+or\s+|\s+OR\s+/)
      .map((item) => item.trim())
      .filter(Boolean);
  };

  const aliasesFor = (keywords) => {
    const aliases = new Set();
    for (const keyword of splitKeywordList(keywords)) {
      aliases.add(keyword);
      aliases.add(normalizeText(keyword));
      // 只保留非常通用的地域写法互换，不再写死学校、商学院等场景别名。
      if (keyword.startsWith("贵阳")) aliases.add(`贵州${keyword.slice(2)}`);
      if (keyword.startsWith("贵州")) aliases.add(`贵阳${keyword.slice(2)}`);
    }
    return [...aliases].filter(Boolean).sort((a, b) => b.length - a.length);
  };

  const containsTargetKeyword = (text, keywords) => {
    const normalized = normalizeText(text);
    return aliasesFor(keywords).some((alias) => {
      const term = normalizeText(alias);
      return term && normalized.includes(term);
    });
  };

  const hasMetaText = (text) => /原问题摘要|上一轮回答摘要|return_schema|forbidden_terms|target_keywords|系统提示|测试目标|不要输出|JSON/i.test(String(text || ""));

  const sanitizeFollowupPrompt = (prompt, keywords) => {
    let text = String(prompt || "").replace(/\r/g, "\n").trim();
    text = text.replace(/^```(?:json)?\s*|\s*```$/gi, "").trim();
    text = text.replace(/^["“”'「」]+|["“”'「」]+$/g, "").trim();
    const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    if (lines.length > 1) return "";
    if (!text || text.length < 8 || text.length > 160) return "";
    if (hasMetaText(text)) return "";
    if (containsTargetKeyword(text, keywords)) return "";
    return text;
  };

  try {
    // 禁用原来的固定追问模板。
    buildFollowupPrompt = function buildFollowupPrompt() {
      return "";
    };
  } catch (e) {}

  try {
    normalizeFollowupPrompt = function normalizeFollowupPrompt(prompt, followupCount, keywords) {
      return sanitizeFollowupPrompt(prompt, keywords);
    };
  } catch (e) {}

  try {
    buildSmartFollowupPrompt = async function buildSmartFollowupPrompt(followupCount, keywords, previousQuestion, answerText, platform) {
      const cleanKeywords = splitKeywordList(keywords);
      if (!cleanKeywords.length) {
        return {
          prompt: "",
          source: "error",
          reason: "缺少目标关键词，已停止追问",
        };
      }

      if (!String(answerText || "").trim()) {
        return {
          prompt: "",
          source: "error",
          reason: "没有获取到上一轮AI真实回复，已停止追问",
        };
      }

      const response = await runtimeMessage({
        action: "GENERATE_FOLLOWUP",
        answer_text: answerText || "",
        keywords: cleanKeywords,
        question: previousQuestion || "",
        platform: platform || "",
        followup_count: followupCount,
      });

      if (!response || !response.ok || !response.prompt) {
        return {
          prompt: "",
          source: "error",
          reason: response && (response.reason || response.error) ? (response.reason || response.error) : "AI未生成有效追问，已停止追问",
        };
      }

      const prompt = sanitizeFollowupPrompt(response.prompt, cleanKeywords);
      if (!prompt) {
        return {
          prompt: "",
          source: "error",
          reason: "AI追问为空、包含目标关键词/元信息，或格式不合规，已停止追问",
        };
      }

      return {
        prompt,
        source: response.source || "ai",
        intent: response.intent || "",
        reason: response.reason || "",
        api_mode: response.api_mode || "",
      };
    };
  } catch (e) {}

  async function judgeAndPrepareFollowup(answerText, keywords, task, lastPrompt, followupCount) {
    const nextFollowupPromise = buildSmartFollowupPrompt(
      followupCount,
      keywords,
      lastPrompt,
      answerText,
      task.platform
    ).catch((error) => ({
      prompt: "",
      source: "error",
      reason: String(error && error.message ? error.message : error),
    }));

    const judgePromise = judgeAnswer(answerText, keywords, task).catch((error) => ({
      ok: false,
      has_answer: Boolean(answerText && normalizeText(answerText).length >= 20),
      matched: false,
      reason: String(error && error.message ? error.message : error),
      source: "error",
    }));

    const judgeResult = await judgePromise;
    return { judgeResult, nextFollowupPromise };
  }

  async function captureTaskScreenshot(task, matched, matchedKeywords, answerText, judgeResult, domLocation) {
    let screenshotDataUrl = null;

    if (matched) {
      drawMatchedBadge(matchedKeywords);

      for (let attempt = 0; attempt < 2; attempt++) {
        if (domLocation && domLocation.matched && visibleKeywordMarkExists() && keywordMarkFullyInViewport()) break;

        clearKeywordMarks();
        if (task.platform !== "qianwen" && GEO_LAST_ANSWER_ELEMENT && document.body.contains(GEO_LAST_ANSWER_ELEMENT)) {
          GEO_LAST_ANSWER_ELEMENT.scrollIntoView({ block: "center", behavior: "instant" });
          await waitForScrollStable(2000);
        }

        clearKeywordMarks();
        domLocation = await locateAndMarkKeywordForScreenshot(task.platform, answerText, matchedKeywords, judgeResult, task.keywords);

        if (!domLocation || !domLocation.matched || !visibleKeywordMarkExists() || !keywordMarkFullyInViewport()) {
          clearKeywordMarks();
          let scrollMatches = [];
          if (task.platform === "qianwen") {
            scrollMatches = await findQianwenKeywordMatchesByScroll(keywordSearchTerms(matchedKeywords, judgeResult, task.keywords));
          } else {
            scrollMatches = await findKeywordWithNativeFind(matchedKeywords.slice(0, 1), null);
            if (!scrollMatches.length) {
              scrollMatches = await findKeywordMatchesByScroll(matchedKeywords.slice(0, 1), null);
            }
          }
          if (scrollMatches.length) {
            const rects = task.platform === "qianwen"
              ? await drawKeywordAndEnsureViewportSmooth(scrollMatches[0])
              : await drawKeywordAndEnsureViewport(scrollMatches[0]);
            const firstRect = task.platform === "qianwen"
              ? targetRectForKeywordMatch(scrollMatches[0])
              : document.querySelector(".geo-keyword-mark")?.getBoundingClientRect();
            if (firstRect && firstRect.width > 0 && firstRect.height > 0) {
              domLocation = {
                matched: true,
                matched_keywords: [scrollMatches[0].keyword],
                rects: rects.map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })),
                first_rect: { x: firstRect.x, y: firstRect.y, width: firstRect.width, height: firstRect.height },
                needs_image_annotation: task.platform === "qianwen",
                match_type: task.platform === "qianwen" ? "qianwen_precise_keyword_scroll" : "scroll_fallback",
              };
            }
          }
        }
      }

      await new Promise((resolve) => requestAnimationFrame(resolve));
      await sleep(task.platform === "qianwen" ? 900 : 500);

      const imageFallbackRect = domLocation && domLocation.first_rect
        ? domLocation.first_rect
        : (task.platform === "qianwen" ? null : fallbackAnswerRect());
      if (!visibleKeywordMarkExists() || !keywordMarkFullyInViewport()) {
        clearKeywordMarks();
        if (imageFallbackRect) {
          domLocation = {
            ...(domLocation || {}),
            matched: true,
            matched_keywords: matchedKeywords,
            first_rect: imageFallbackRect,
            needs_image_annotation: true,
            match_type: domLocation && domLocation.match_type ? domLocation.match_type : "answer_area_fallback",
          };
        }
      }
    } else {
      clearKeywordMarks();
      if (GEO_LAST_ANSWER_ELEMENT && document.body.contains(GEO_LAST_ANSWER_ELEMENT)) {
        GEO_LAST_ANSWER_ELEMENT.scrollIntoView({ block: "center", behavior: "smooth" });
        await waitForScrollStable();
      }
    }

    const shouldAnnotateImage = matched && domLocation && domLocation.first_rect && (
      task.platform === "qianwen" ||
      domLocation.needs_image_annotation ||
      !visibleKeywordMarkExists() ||
      !keywordMarkFullyInViewport()
    );
    const annotationRect = shouldAnnotateImage ? domLocation.first_rect : null;

    await prepareForScreenshot();
    screenshotDataUrl = await captureVisibleScreenshot();
    cleanupAfterScreenshot();
    if (shouldAnnotateImage && screenshotDataUrl) {
      screenshotDataUrl = await annotateScreenshotDataUrl(screenshotDataUrl, annotationRect);
    }

    return { screenshotDataUrl, domLocation };
  }

  try {
    window.geoAutomationRun = async function geoAutomationRunWithPrebuiltFollowup(task) {
      try {
        clearKeywordMarks();
        clearMatchedBadges();

        let answerText = "";
        let matched = false;
        let matchedKeywords = [];
        let judgeResult = null;
        let followupCount = 0;
        let domLocation = null;
        let lastPrompt = task.question;
        const runDebug = [];
        const keywords = task.keywords && task.keywords.length ? task.keywords : [task.keyword || ""].filter(Boolean);
        task.keywords = keywords;

        let previousText = getAnswerText(task.platform);
        await sendPrompt(task.platform, task.question);
        answerText = await waitAnswerStable(task, previousText);

        let { judgeResult: initialJudge, nextFollowupPromise } = await judgeAndPrepareFollowup(answerText, keywords, task, lastPrompt, followupCount);
        judgeResult = initialJudge;
        matched = Boolean(judgeResult.matched);
        matchedKeywords = matched ? uniqueList([judgeResult.matched_text, judgeResult.keyword, keywords[0]]) : [];

        runDebug.push({
          round: 0,
          type: "initial",
          prompt: task.question,
          followup_generation: "started_parallel_with_keyword_judge",
          answer_length: String(answerText || "").length,
          answer_preview: String(answerText || "").replace(/\s+/g, " ").slice(0, 800),
          judge_result: judgeResult,
          answer_debug: GEO_LAST_ANSWER_DEBUG,
        });

        if (matched) {
          domLocation = await locateAndMarkKeywordForScreenshot(task.platform, answerText, matchedKeywords, judgeResult, keywords);
        }

        while (!matched && followupCount < Number(task.max_followups || 3)) {
          const followup = await nextFollowupPromise;
          if (!followup || !followup.prompt) {
            runDebug.push({
              round: followupCount + 1,
              type: "followup_skipped",
              prompt_source: followup && followup.source ? followup.source : "error",
              prompt_reason: followup && followup.reason ? followup.reason : "AI没有生成可用追问，停止继续追问",
            });
            break;
          }

          const prompt = followup.prompt;
          followupCount += 1;
          previousText = getAnswerText(task.platform);
          await sendPrompt(task.platform, prompt);
          lastPrompt = prompt;
          answerText = await waitAnswerStable(task, previousText);

          const prepared = await judgeAndPrepareFollowup(answerText, keywords, task, lastPrompt, followupCount);
          judgeResult = prepared.judgeResult;
          nextFollowupPromise = prepared.nextFollowupPromise;

          matched = Boolean(judgeResult.matched);
          matchedKeywords = matched ? uniqueList([judgeResult.matched_text, judgeResult.keyword, keywords[0]]) : [];

          runDebug.push({
            round: followupCount,
            type: "followup",
            prompt,
            prompt_source: followup.source,
            prompt_intent: followup.intent || "",
            prompt_reason: followup.reason || "",
            prompt_api_mode: followup.api_mode || "",
            followup_generation: "next_round_started_parallel_with_keyword_judge",
            previous_length: String(previousText || "").length,
            answer_length: String(answerText || "").length,
            answer_preview: String(answerText || "").replace(/\s+/g, " ").slice(0, 800),
            judge_result: judgeResult,
            answer_debug: GEO_LAST_ANSWER_DEBUG,
          });

          if (matched) {
            domLocation = await locateAndMarkKeywordForScreenshot(task.platform, answerText, matchedKeywords, judgeResult, keywords);
          }
        }

        const captured = await captureTaskScreenshot(task, matched, matchedKeywords, answerText, judgeResult, domLocation);

        return {
          matched,
          matched_keywords: matchedKeywords,
          judge_result: judgeResult,
          followup_count: followupCount,
          answer_text: answerText,
          screenshot_data_url: captured.screenshotDataUrl,
          dom_location: captured.domLocation,
          keywords,
          answer_debug: GEO_LAST_ANSWER_DEBUG,
          run_debug: runDebug,
        };
      } catch (error) {
        return {
          matched: false,
          followup_count: 0,
          answer_text: getAnswerText(task.platform),
          answer_debug: collectAnswerDebug(task.platform, "", GEO_LAST_ANSWER_ELEMENT, "error"),
          run_debug: [],
          error: String(error && error.message ? error.message : error),
        };
      }
    };
  } catch (e) {}
})();
