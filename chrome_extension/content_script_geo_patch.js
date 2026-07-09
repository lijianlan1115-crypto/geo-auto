// 通用 GEO 追问补丁：
// 1. 去掉固定学校模板。
// 2. 追问必须由本地 AI 根据真实回复生成。
// 3. 每轮把 {question, answer, platform, conversation} 传给 Python。
// 4. 每轮 debug 记录是否拿到真实回答、是否生成追问。
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

  const compactDebugText = (text, limit = 800) => String(text || "").replace(/\s+/g, " ").slice(0, limit);

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

  const cleanConversation = (conversation) => {
    return (conversation || [])
      .filter((item) => item && (item.role === "user" || item.role === "assistant") && String(item.content || "").trim())
      .slice(-8)
      .map((item) => ({
        role: item.role,
        content: String(item.content || "").slice(0, 4000),
      }));
  };

  const realAnswerInfo = (answerText) => {
    const length = String(answerText || "").length;
    const normalizedLength = normalizeText(answerText).length;
    return {
      real_answer_valid: normalizedLength >= 20,
      answer_length: length,
      normalized_answer_length: normalizedLength,
      answer_preview: compactDebugText(answerText, 800),
    };
  };

  try {
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
    buildSmartFollowupPrompt = async function buildSmartFollowupPrompt(followupCount, keywords, previousQuestion, answerText, platform, conversation) {
      const cleanKeywords = splitKeywordList(keywords);
      if (!cleanKeywords.length) {
        return { prompt: "", source: "error", reason: "缺少目标关键词，已停止追问", real_answer_valid: false };
      }

      const answerInfo = realAnswerInfo(answerText);
      if (!answerInfo.real_answer_valid) {
        return { prompt: "", source: "error", reason: "没有获取到上一轮AI真实回复，已停止追问", ...answerInfo };
      }

      const structuredContext = {
        question: previousQuestion || "",
        answer: answerText || "",
        platform: platform || "",
        conversation: cleanConversation(conversation),
      };

      const response = await runtimeMessage({
        action: "GENERATE_FOLLOWUP",
        answer_text: answerText || "",
        keywords: cleanKeywords,
        // 兼容现有 background/server 接口：把结构化对象放进 question 字段。
        question: structuredContext,
        platform: platform || "",
        followup_count: followupCount,
      });

      if (!response || !response.ok || !response.prompt) {
        return {
          prompt: "",
          source: "error",
          reason: response && (response.reason || response.error) ? (response.reason || response.error) : "AI未生成有效追问，已停止追问",
          ...answerInfo,
          conversation_turns: structuredContext.conversation.length,
          used_structured_context: true,
        };
      }

      const prompt = sanitizeFollowupPrompt(response.prompt, cleanKeywords);
      if (!prompt) {
        return {
          prompt: "",
          source: "error",
          reason: "AI追问为空、包含目标关键词/元信息，或格式不合规，已停止追问",
          ...answerInfo,
          conversation_turns: structuredContext.conversation.length,
          used_structured_context: true,
          raw_prompt: response.prompt,
        };
      }

      return {
        prompt,
        source: response.source || "ai",
        intent: response.intent || "",
        reason: response.reason || "",
        api_mode: response.api_mode || "",
        real_answer_valid: response.real_answer_valid !== undefined ? response.real_answer_valid : answerInfo.real_answer_valid,
        conversation_turns: response.conversation_turns !== undefined ? response.conversation_turns : structuredContext.conversation.length,
        used_structured_context: response.used_structured_context !== undefined ? response.used_structured_context : true,
        answer_length: answerInfo.answer_length,
        normalized_answer_length: answerInfo.normalized_answer_length,
        answer_preview: answerInfo.answer_preview,
      };
    };
  } catch (e) {}

  async function judgeAndPrepareFollowup(answerText, keywords, task, lastPrompt, followupCount, conversation) {
    const nextFollowupPromise = buildSmartFollowupPrompt(
      followupCount,
      keywords,
      lastPrompt,
      answerText,
      task.platform,
      conversation
    ).catch((error) => ({
      prompt: "",
      source: "error",
      reason: String(error && error.message ? error.message : error),
      ...realAnswerInfo(answerText),
      conversation_turns: cleanConversation(conversation).length,
      used_structured_context: true,
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
    window.geoAutomationRun = async function geoAutomationRunWithStructuredConversation(task) {
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
        const conversation = [];
        const keywords = task.keywords && task.keywords.length ? task.keywords : [task.keyword || ""].filter(Boolean);
        task.keywords = keywords;

        let previousText = getAnswerText(task.platform);
        await sendPrompt(task.platform, task.question);
        conversation.push({ role: "user", content: task.question });
        answerText = await waitAnswerStable(task, previousText);
        conversation.push({ role: "assistant", content: answerText });

        let { judgeResult: initialJudge, nextFollowupPromise } = await judgeAndPrepareFollowup(answerText, keywords, task, lastPrompt, followupCount, conversation);
        judgeResult = initialJudge;
        matched = Boolean(judgeResult.matched);
        matchedKeywords = matched ? uniqueList([judgeResult.matched_text, judgeResult.keyword, keywords[0]]) : [];

        const initialFollowupPreview = await Promise.race([
          nextFollowupPromise.then((item) => item),
          sleep(10).then(() => ({ pending: true })),
        ]);

        runDebug.push({
          round: 0,
          type: "initial",
          prompt: task.question,
          followup_generation: "started_parallel_with_keyword_judge",
          real_answer_check: realAnswerInfo(answerText),
          conversation_turns: conversation.length,
          generated_followup_preview: initialFollowupPreview && !initialFollowupPreview.pending ? {
            ok: Boolean(initialFollowupPreview.prompt),
            prompt: initialFollowupPreview.prompt || "",
            source: initialFollowupPreview.source || "",
            reason: initialFollowupPreview.reason || "",
            real_answer_valid: initialFollowupPreview.real_answer_valid,
            used_structured_context: initialFollowupPreview.used_structured_context,
          } : { pending: true },
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
              real_answer_valid: followup && followup.real_answer_valid,
              conversation_turns: conversation.length,
              used_structured_context: followup && followup.used_structured_context,
            });
            break;
          }

          const prompt = followup.prompt;
          followupCount += 1;
          previousText = getAnswerText(task.platform);
          await sendPrompt(task.platform, prompt);
          conversation.push({ role: "user", content: prompt });
          lastPrompt = prompt;
          answerText = await waitAnswerStable(task, previousText);
          conversation.push({ role: "assistant", content: answerText });

          const prepared = await judgeAndPrepareFollowup(answerText, keywords, task, lastPrompt, followupCount, conversation);
          judgeResult = prepared.judgeResult;
          nextFollowupPromise = prepared.nextFollowupPromise;

          matched = Boolean(judgeResult.matched);
          matchedKeywords = matched ? uniqueList([judgeResult.matched_text, judgeResult.keyword, keywords[0]]) : [];

          const nextFollowupPreview = await Promise.race([
            nextFollowupPromise.then((item) => item),
            sleep(10).then(() => ({ pending: true })),
          ]);

          runDebug.push({
            round: followupCount,
            type: "followup",
            prompt,
            prompt_source: followup.source,
            prompt_intent: followup.intent || "",
            prompt_reason: followup.reason || "",
            prompt_api_mode: followup.api_mode || "",
            sent_followup_was_ai_generated: followup.source === "ai",
            sent_followup_real_answer_valid: followup.real_answer_valid,
            followup_generation: "next_round_started_parallel_with_keyword_judge",
            real_answer_check: realAnswerInfo(answerText),
            conversation_turns: conversation.length,
            generated_next_followup_preview: nextFollowupPreview && !nextFollowupPreview.pending ? {
              ok: Boolean(nextFollowupPreview.prompt),
              prompt: nextFollowupPreview.prompt || "",
              source: nextFollowupPreview.source || "",
              reason: nextFollowupPreview.reason || "",
              real_answer_valid: nextFollowupPreview.real_answer_valid,
              used_structured_context: nextFollowupPreview.used_structured_context,
            } : { pending: true },
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
          conversation,
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
