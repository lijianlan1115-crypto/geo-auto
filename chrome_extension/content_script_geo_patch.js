// 通用 GEO 追问补丁：
// 1. 去掉固定学校模板。
// 2. 追问必须由本地 AI 根据真实回复生成。
// 3. 每轮把 {question, answer, platform, conversation} 传给 Python。
// 4. 每轮 debug 记录是否拿到真实回答、是否生成追问。
(function () {
  const normalizeText = (text) => String(text || "").replace(/\s+/g, "").replace(/[，。！？、,.!?；;：:（）()【】\[\]《》<>-]+/g, "");
  const rectNearViewportCenter = (rect, band = 0.24) => {
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const centerY = Number(rect.y !== undefined ? rect.y : rect.top) + rect.height / 2;
    return Math.abs(centerY - window.innerHeight / 2) <= window.innerHeight * band;
  };

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

  const withPlatformResponseLanguage = (prompt, platform) => {
    const text = String(prompt || "").trim();
    if (String(platform || "").toLowerCase() !== "yuanbao" || /使用中文|中文回答|用中文/.test(text)) {
      return text;
    }
    const suffix = "请全程使用中文回答，品牌和门店名称保留中文原名，不要使用英文或拼音替代。";
    const maxBaseLength = Math.max(20, 158 - suffix.length - 1);
    const base = text.slice(0, maxBaseLength).replace(/[，。！？?；;：:\s]+$/g, "");
    return `${base}；${suffix}`;
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

  const buildSafeContextFallback = (originalQuestion, answerText, followupCount, platform, keywords) => {
    const context = `${originalQuestion || ""} ${answerText || ""}`;
    const traits = [];
    const traitRules = [
      [/干香|香而不燥|香大于辣/, "干香口味"],
      [/贵州|贵阳|本地/, "贵州本地"],
      [/真空|包装|保存|囤/, "真空包装和保存"],
      [/顺丰|快递|邮寄|寄到|外地/, "顺丰发货和异地邮寄"],
      [/下饭|拌饭|带饭/, "下饭和带饭"],
      [/送礼|礼盒|伴手礼/, "送礼和伴手礼"],
      [/加热|复热/, "加热后的口感"],
      [/一家人|分量/, "家庭分量"],
    ];
    for (const [pattern, label] of traitRules) {
      if (pattern.test(context) && !traits.includes(label)) traits.push(label);
      if (traits.length >= 3) break;
    }
    const conditions = traits.length ? traits.join("、") : "原问题中的口味、用途和购买条件";
    const isFood = /辣子鸡|食品|下饭|真空|口味|送礼|伴手礼/.test(context);
    const entity = isFood ? "具体品牌或店铺名称" : "具体候选名称";
    const round = Math.max(0, Number(followupCount || 0));
    const prompts = [
      `按${conditions}这些条件，还有哪些尚未提到的${entity}？请逐个说明为什么符合。`,
      `如果进一步比较${conditions}，能否补充或重新比较几个${entity}，并指出各自最匹配的条件？`,
      `最后请只补充前面遗漏、但同时符合${conditions}的${entity}，不要重复已经列出的选择。`,
    ];
    const candidate = prompts[Math.min(round, prompts.length - 1)];
    return sanitizeFollowupPrompt(candidate, keywords);
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
    buildSmartFollowupPrompt = async function buildSmartFollowupPrompt(
      followupCount,
      keywords,
      originalQuestion,
      previousQuestion,
      answerText,
      platform,
      conversation,
      taskId
    ) {
      const cleanKeywords = splitKeywordList(keywords);
      if (!cleanKeywords.length) {
        return { prompt: "", source: "error", reason: "缺少目标关键词，已停止追问", real_answer_valid: false };
      }

      const answerInfo = realAnswerInfo(answerText);
      if (!answerInfo.real_answer_valid) {
        return { prompt: "", source: "error", reason: "没有获取到上一轮AI真实回复，已停止追问", ...answerInfo };
      }

      const structuredContext = {
        task_id: String(taskId || ""),
        original_question: originalQuestion || previousQuestion || "",
        latest_question: previousQuestion || "",
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
        task_id: String(taskId || ""),
      });

      if (!response || !response.ok || !response.prompt) {
        return {
          prompt: "",
          source: "error",
          reason: response && (response.reason || response.error)
            ? (response.reason || response.error)
            : "服务端未能根据当前窗口真实回答生成追问，已停止以避免发送跨场景固定模板",
          ...answerInfo,
          conversation_turns: structuredContext.conversation.length,
          used_structured_context: true,
        };
      }
      if (taskId && String(response.task_id || "") !== String(taskId)) {
        return {
          prompt: "",
          source: "error",
          reason: `追问任务标识不匹配：期望${String(taskId)},实际${String(response.task_id || "缺失")}`,
          ...answerInfo,
          conversation_turns: structuredContext.conversation.length,
          used_structured_context: true,
        };
      }

      let prompt = sanitizeFollowupPrompt(response.prompt, cleanKeywords);
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

      // 千问食品类追问必须自然邀请它列出具体品牌/店铺；若AI只生成了泛泛
      // 的说明型问题，改用仍基于本题和本窗口真实回答的安全问题。
      const qianwenFoodContext = `${originalQuestion || ""} ${answerText || ""}`;
      if (
        String(platform || "").toLowerCase() === "qianwen" &&
        /辣子鸡|食品|下饭|真空|口味|送礼|伴手礼/.test(qianwenFoodContext) &&
        !/具体.*(?:品牌|店铺|门店)|(?:品牌|店铺|门店).*名称/.test(prompt)
      ) {
        const enforcedPrompt = buildSafeContextFallback(
          originalQuestion,
          answerText,
          followupCount,
          platform,
          cleanKeywords
        );
        if (enforcedPrompt) prompt = enforcedPrompt;
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
        task_id: response.task_id || String(taskId || ""),
        answer_focus: response.answer_focus || "",
      };
    };
  } catch (e) {}

  async function judgeAndPrepareFollowup(answerText, keywords, task, lastPrompt, followupCount, conversation) {
    const liveHit = liveAnswerKeywordHit(task, keywords, answerText);
    if (liveHit.matched) {
      return {
        judgeResult: { ok: true, has_answer: true, ...liveHit },
        nextFollowupPromise: Promise.resolve({
          prompt: "",
          source: "cancelled_after_live_keyword_hit",
          reason: "当前页面回答已出现目标词，无需生成追问",
        }),
      };
    }

    const nextFollowupPromise = buildSmartFollowupPrompt(
      followupCount,
      keywords,
      task.question,
      lastPrompt,
      answerText,
      task.platform,
      conversation,
      task.task_id
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

    let judgeResult = await judgePromise;
    // 千问必须以“当前回答正文实际包含配置关键词”为命中硬条件。
    // AI 语义判断不能把品牌相关推荐、侧栏历史或相近描述判成命中。
    if (task.platform === "qianwen" && judgeResult && judgeResult.matched && !containsTargetKeyword(answerText, keywords)) {
      judgeResult = {
        ...judgeResult,
        matched: false,
        matched_text: "",
        evidence: "",
        source: "qianwen_current_answer_exact_guard",
        reason: "千问当前回答正文未出现配置关键词，已阻止语义误命中",
      };
    }
    return { judgeResult, nextFollowupPromise };
  }

  function liveAnswerKeywordHit(task, keywords, fallbackAnswerText) {
    const texts = [String(fallbackAnswerText || ""), String(getAnswerText(task.platform) || "")];
    try {
      for (const node of getAnswerCandidates(task.platform).slice(0, 24)) {
        const text = textFromNode(node);
        if (text) texts.push(text);
      }
    } catch (e) {}

    const aliases = keywordAliasesForPrompt(keywords);
    for (const text of texts) {
      const normalized = normalizeText(text);
      for (const alias of aliases) {
        const normalizedAlias = normalizeText(alias);
        if (normalizedAlias && normalized.includes(normalizedAlias)) {
          return {
            matched: true,
            keyword: splitKeywordList(keywords)[0] || alias,
            matched_text: alias,
            evidence: text.slice(Math.max(0, text.indexOf(alias) - 80), text.indexOf(alias) + alias.length + 160),
            answer_text: text,
            source: "live_page_pre_send_check",
            reason: "发送追问前在当前页面回答中发现目标词",
          };
        }
      }
    }
    return { matched: false };
  }

  function qianwenTryWindowFindAndGetRect(terms) {
    const sel = window.getSelection && window.getSelection();
    if (!sel || typeof window.find !== "function") return null;

    // 回答正文元素，匹配必须在其内部
    const answerEl = GEO_LAST_ANSWER_ELEMENT && document.body.contains(GEO_LAST_ANSWER_ELEMENT)
      ? GEO_LAST_ANSWER_ELEMENT : null;

    // 生成完整词 + 短词列表
    const validTerms = uniqueList(terms || []).filter(t => String(t || "").trim().length >= 2);
    const shortTerms = splitShortTerms(validTerms);
    const allTerms = [...validTerms, ...shortTerms.filter(st => !validTerms.includes(st))];

    for (const term of allTerms) {
      const termStr = String(term || "").trim();
      if (termStr.length < 2) continue;

      // 第一次清除选区从头搜索；后续不清除选区，让 window.find 找下一个匹配
      sel.removeAllRanges();
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          const found = window.find(termStr, false, false, true, false, true, false);
          if (!found || sel.rangeCount === 0) break;

          const range = sel.getRangeAt(0);
          const container = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
            ? range.commonAncestorContainer.parentElement
            : range.commonAncestorContainer;
          if (!container) { continue; }

          // 过滤侧边栏/导航等
          if (typeof isIgnoredQianwenKeywordNode === "function" && isIgnoredQianwenKeywordNode(container)) continue;
          // 过滤用户提问/消息气泡
          const cn = String(container.className || "");
          if (/send-msg|send-bubble|user-message|human-message|question|query|user-msg/i.test(cn)
              && !/answer|assistant|agent|markdown|response/i.test(cn)) continue;

          // 必须在回答正文元素内部
          if (answerEl && !answerEl.contains(container)) continue;

          const rect = bestRangeRect(range);
          if (rect && rect.width > 0 && rect.height > 0
              && rect.bottom > 0 && rect.top < window.innerHeight
              && rect.right > 0 && rect.left < window.innerWidth) {
            // 位置过滤：跳过左侧边栏区域
            if (window.innerWidth > 900 && rect.right < window.innerWidth * 0.22) continue;
            // 尺寸过滤：跳过超大 rect（占视口 60% 以上的）
            if (rect.width > window.innerWidth * 0.6 || rect.height > window.innerHeight * 0.5) continue;
            sel.removeAllRanges();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, range: range.cloneRange() };
          }
        } catch (e) { break; }
      }
    }
    sel.removeAllRanges();
    return null;
  }

  // ========= 千问滚动容器定位 =========
  // 千问不是 window 滚动，而是内部 div（.chat-list 或类似）滚动
  // scrollIntoView 会滚错容器，必须手动找到 overflow:auto 的父级并设 scrollTop

  function findQianwenScrollContainer(el) {
    let node = el && el.parentElement;
    while (node && node !== document.body) {
      try {
        const style = getComputedStyle(node);
        const overflowY = style.overflowY;
        if ((overflowY === "auto" || overflowY === "scroll")
            && node.scrollHeight > node.clientHeight + 2) {
          return node;
        }
      } catch (e) {}
      node = node.parentElement;
    }
    // 最终回退到 documentElement
    if (document.documentElement.scrollHeight > document.documentElement.clientHeight + 2) {
      return document.documentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  // 把目标元素滚到其滚动容器的视口中央
  function scrollQianwenToCenter(el) {
    if (!el) return null;
    const container = findQianwenScrollContainer(el);
    const elRect = el.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    // 元素相对于容器内容顶部的偏移
    const offsetTop = elRect.top - containerRect.top + container.scrollTop;
    // 目标 scrollTop：让元素在容器视口中央
    const targetScrollTop = offsetTop - container.clientHeight / 2 + elRect.height / 2;
    const clamped = Math.max(0, Math.min(targetScrollTop, container.scrollHeight - container.clientHeight));

    if (container === document.documentElement || container === document.scrollingElement) {
      window.scrollTo({ top: clamped, behavior: "instant" });
    } else {
      container.scrollTop = clamped;
    }
    return container;
  }

  // ========= 关键词搜索：拆短关键词 + 文本节点遍历 =========
  // 千问把一段文字切到多个 <span class="qk-md-text complete"> 里
  // 完整关键词可能跨 span，所以拆成 2-3 字的子串再搜

  function splitShortTerms(terms) {
    // 不再把品牌词拆成 2-3 字片段。片段（例如“老街”“杨家”）会在
    // 普通回答或历史标题中大量出现，既会误命中，也无法表示目标关键词。
    return [];
  }

  // ========= 精准定位千问回答区域 =========
  // 不依赖 GEO_LAST_ANSWER_ELEMENT，直接用具体选择器找到真正的回答正文容器
  // 关键：必须排除 sidebar（含对话历史，关键词会在那里出现）
  function findQianwenAnswerAreas() {
    const results = [];
    const seen = new Set();

    // 1) 千问最常见的选择器（按优先级）
    const directSelectors = [
      ".chat-answers-card-wrap",
      ".answer-common-card",
      "#qk-markdown-react",
      ".markdown-react",
      "[class*='answer-card']",
      "[class*='AnswerCard']",
      "[class*='answerCard']",
      "[class*='chatAnswer']",
      "[class*='chat-answer']",
      "[class*='ChatAnswer']",
      "[class*='message-assistant']",
      "[class*='assistant-message']",
      "[class*='assistantMessage']",
      "[class*='assistant_message']",
    ];

    for (const selector of directSelectors) {
      try {
        const nodes = document.querySelectorAll(selector);
        for (const node of nodes) {
          if (!node || seen.has(node)) continue;
          if (node.closest("aside, nav, header, [role='navigation'], [class*='history'], [class*='History']")) continue;
          if (node.querySelector("aside, nav, [role='navigation'], textarea, input, [contenteditable='true']")) continue;
          const rect = node.getBoundingClientRect();
          // 必须有可见尺寸，且不在左侧 sidebar
          if (rect.width < 100 || rect.height < 50) continue;
          if (window.innerWidth > 900 && rect.right < window.innerWidth * 0.22) continue;
          // 必须包含正文文本
          const text = (node.textContent || "").trim();
          if (text.length < 30) continue;
          seen.add(node);
          results.push(node);
        }
      } catch (e) {}
    }

    if (results.length) return results;

    // 2) Fallback：找右侧带 markdown 内容的元素
    try {
      const markdownCandidates = Array.from(document.querySelectorAll(
        "[class*='markdown'], [class*='Markdown'], .ant-typography, .markdown-body, [class*='message-content'], [class*='MessageContent']"
      ));
      for (const node of markdownCandidates) {
        if (!node || seen.has(node)) continue;
        if (node.closest("aside, nav, header, [role='navigation'], [class*='history'], [class*='History']")) continue;
        if (node.querySelector("aside, nav, [role='navigation'], textarea, input, [contenteditable='true']")) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width < 200 || rect.height < 80) continue;
        if (window.innerWidth > 900 && rect.right < window.innerWidth * 0.22) continue;
        if (rect.left < window.innerWidth * 0.22) continue;  // 起始位置也不能在 sidebar
        const text = (node.textContent || "").trim();
        if (text.length < 80) continue;
        // 排除对话历史项（短文本列表）
        const cn = String(node.className || "");
        if (/history|History|sidebar|Sidebar|nav-list|menu-list|conversation-list/i.test(cn)) continue;
        seen.add(node);
        results.push(node);
      }
    } catch (e) {}

    return results;
  }

  // 新策略：用 TreeWalker 找包含关键词的文本节点，用 range.getBoundingClientRect() 获取精确位置
  // 这是最精确的方法——直接框选文本节点中关键词所在的那一段
  // 关键修复：优先使用 findQianwenAnswerAreas() 找到的真正回答区域，而不是 GEO_LAST_ANSWER_ELEMENT
  function findQianwenTextNodeRect(root, terms) {
    try {
      if (!root || !document.createTreeWalker) return null;
      const validTerms = uniqueList(terms || []).filter(t => String(t || "").trim().length >= 2);
      if (!validTerms.length) return null;

      // 拆短关键词（跨 span 场景）
      const shortTerms = splitShortTerms(validTerms);
      const allTerms = [...validTerms, ...shortTerms.filter(st => !validTerms.includes(st))];

      // 优先用具体的回答区域选择器；fallback 才用 root
      const answerAreas = findQianwenAnswerAreas();
      const searchRoots = answerAreas.length ? answerAreas : [root];

      let bestResult = null;
      let bestScore = -Infinity;

      for (const filteredRoot of searchRoots) {
        if (!filteredRoot || !document.body.contains(filteredRoot)) continue;

      const walker = document.createTreeWalker(filteredRoot, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
          if (!node.nodeValue || !node.parentElement) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          // 过滤掉非正文元素
          if (parent.closest && parent.closest("#geo-auto-root, .geo-matched-badge, .geo-keyword-mark, script, style, noscript, textarea, input, button, [data-geo-overlay='1'], nav, aside, [role='navigation'], [class*='sidebar'], [class*='Sidebar'], [class*='history'], [class*='History'], [class*='composer'], [class*='toolbar'], [class*='footer'], [class*='suggest'], [class*='recommend']")) return NodeFilter.FILTER_REJECT;
          if (typeof isIgnoredQianwenKeywordNode === "function" && isIgnoredQianwenKeywordNode(parent)) return NodeFilter.FILTER_REJECT;
          // 位置过滤：跳过左侧边栏
          const rect = parent.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && window.innerWidth > 900
              && rect.right < window.innerWidth * 0.22) return NodeFilter.FILTER_REJECT;
          // 必须包含某个关键词
          return allTerms.some(t => node.nodeValue.includes(t)) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      });

      let n;
      while ((n = walker.nextNode())) {
        const text = n.nodeValue;
        let found = null;
        let foundIsFull = false;
        for (const t of allTerms) {
          if (text.includes(t)) {
            if (!found || t.length > found.length) {
              found = t;
              foundIsFull = validTerms.includes(t);
            }
          }
        }
        if (!found) continue;

        const idx = text.indexOf(found);
        try {
          const range = document.createRange();
          range.setStart(n, idx);
          range.setEnd(n, idx + found.length);
          const rect = range.getBoundingClientRect();
          if (!rect || rect.width <= 0 || rect.height <= 0) continue;

          // 位置过滤：跳过左侧边栏区域
          if (window.innerWidth > 900 && rect.right < window.innerWidth * 0.22) continue;
          // 尺寸过滤：跳过超大 rect（占视口 60% 以上的）
          if (rect.width > window.innerWidth * 0.6 || rect.height > window.innerHeight * 0.5) continue;

          // 评分：完整词优先，词长优先，rect 越小越好（精确）
          // 加分：如果当前 answerArea 在视口下方，说明我们需要先滚动；优先选在视口内的
          const isInViewport = rect.bottom > 0 && rect.top < window.innerHeight;
          const viewportBonus = isInViewport ? 500 : 0;
          const score = viewportBonus + (foundIsFull ? 1000 : 100) + found.length * 10 - rect.width - rect.height * 2;
          if (score > bestScore) {
            bestScore = score;
            bestResult = {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              _range: range.cloneRange(),
              _text: text.slice(Math.max(0, idx - 10), idx + found.length + 10),
              _matchedTerm: found,
              _isFullTerm: foundIsFull,
            };
          }
        } catch (e) {}
      }
      } // 结束 for (const filteredRoot of searchRoots)

      return bestResult;
    } catch (e) {
      try { console.log("[QIANWEN-DBG] findQianwenTextNodeRect ERROR:", e.message); } catch (_) {}
      return null;
    }
  }

  // L4 兜底：在指定 root 内找到包含关键词的最近"段级"祖先
  // 千问的 DOM 把每段文本切到很多 span 里，但段落（<p> 或块级 div）有稳定的 bounding rect
  // 关键：强制选最小元素 + 尺寸过滤 + 排除 body/html
  function findQianwenBlockRect(root, terms) {
    try {
      if (!root || !root.querySelectorAll) return null;
      const validTerms = uniqueList(terms || []).filter(t => String(t || "").trim().length >= 2);
      if (!validTerms.length) return null;

      // 千问把文本拆到多个 span 里，完整关键词可能跨 span
      const shortTerms = splitShortTerms(validTerms);
      const allTerms = [...validTerms, ...shortTerms.filter(st => !validTerms.includes(st))];

      // 扫所有元素（不限标签）
      let candidates;
      try { candidates = root.querySelectorAll("*"); } catch (e) { return null; }

      const matchingCandidates = [];

      for (const el of candidates) {
        try {
          if (!el || el.nodeType !== 1) continue;
          // 排除 body/html 等顶级容器
          if (el === document.body || el === document.documentElement || el === document.head) continue;
          // 排除过大的容器（占视口 70% 以上）
          const elRect0 = el.getBoundingClientRect();
          if (elRect0.width > 0 && elRect0.height > 0) {
            if (elRect0.width > window.innerWidth * 0.7 || elRect0.height > window.innerHeight * 0.5) continue;
          }

          if (el.id === "geo-auto-root" || (el.classList && (el.classList.contains("geo-matched-badge") || el.classList.contains("geo-keyword-mark")))) continue;
          if (el.closest && el.closest("#geo-auto-root, .geo-matched-badge, .geo-keyword-mark, script, style, noscript, textarea, input, button, [data-geo-overlay='1']")) continue;

          // 过滤侧边栏、导航、用户提问区域等非回答正文元素
          if (typeof isIgnoredQianwenKeywordNode === "function" && isIgnoredQianwenKeywordNode(el)) continue;
          // 过滤用户提问/消息气泡（className 含 send-msg/user-message/question 等）
          const cn = String(el.className || "");
          if (/send-msg|send-bubble|user-message|human-message|question|query|user-msg/i.test(cn)
              && !/answer|assistant|agent|markdown|response/i.test(cn)) continue;

          const text = (el.textContent || "").trim();
          if (!text || text.length < 2 || text.length > 500) continue;

          // 位置过滤：跳过左侧边栏区域（屏幕左 22% 以内）
          const elRect = el.getBoundingClientRect();
          if (elRect.width > 0 && elRect.height > 0 && window.innerWidth > 900
              && elRect.right < window.innerWidth * 0.22) continue;
          // 尺寸过滤
          if (elRect.width > window.innerWidth * 0.7 || elRect.height > window.innerHeight * 0.5) continue;

          let contains = null;
          for (const t of allTerms) {
            if (text.includes(t)) {
              if (!contains || t.length > contains.length) contains = t;
            }
          }
          if (!contains) continue;

          matchingCandidates.push({
            el,
            text,
            contains,
            isFullTerm: validTerms.includes(contains),
            textLen: text.length,
            width: elRect.width,
            height: elRect.height,
          });
        } catch (e) { continue; }
      }

      if (!matchingCandidates.length) return null;

      // 评分排序：完整词优先 → 词长优先 → text.length 越小越好（精确）
      matchingCandidates.sort((a, b) => {
        if (a.isFullTerm !== b.isFullTerm) return a.isFullTerm ? -1 : 1;
        if (a.contains.length !== b.contains.length) return b.contains.length - a.contains.length;
        // 优先选面积小的元素
        const areaA = a.width * a.height;
        const areaB = b.width * b.height;
        return areaA - areaB;
      });

      const best = matchingCandidates[0];
      const rect = best.el.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        return {
          x: 0, y: 0, width: 0, height: 0,
          _el: best.el,
          _text: best.text.slice(0, 80),
          _matchedTerm: best.contains,
          _isFullTerm: best.isFullTerm,
          _outlineOnly: true,
        };
      }
      return {
        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        _el: best.el,
        _text: best.text.slice(0, 80),
        _matchedTerm: best.contains,
        _isFullTerm: best.isFullTerm,
      };
    } catch (e) {
      try { console.log("[QIANWEN-DBG] findQianwenBlockRect ERROR:", e.message); } catch (_) {}
      return null;
    }
  }

  async function qianwenScrollAndFind(terms) {
    const answerEl = GEO_LAST_ANSWER_ELEMENT && document.body.contains(GEO_LAST_ANSWER_ELEMENT)
      ? GEO_LAST_ANSWER_ELEMENT : null;
    if (!answerEl) return null;

    // 用 scrollQianwenToCenter 而非 scrollIntoView，避免千问内部滚动容器问题
    scrollQianwenToCenter(answerEl);
    await waitForScrollStable(1500);

    const scrollContainer = (typeof nearestScrollableContainer === "function"
      ? nearestScrollableContainer(answerEl) : null) || document.documentElement;
    const getMaxScroll = () => scrollContainer === document.documentElement
      ? scrollContainer.scrollHeight - window.innerHeight
      : scrollContainer.scrollHeight - scrollContainer.clientHeight;

    let maxScroll = getMaxScroll();
    const stepSize = Math.max(150, Math.floor(window.innerHeight * 0.35));

    for (let pos = 0; pos <= maxScroll + stepSize; pos += stepSize) {
      const clampedPos = Math.min(pos, Math.max(0, maxScroll));
      if (scrollContainer === document.documentElement) {
        window.scrollTo({ top: clampedPos, behavior: "instant" });
      } else {
        scrollContainer.scrollTop = clampedPos;
      }
      await new Promise(r => requestAnimationFrame(r));
      await sleep(200);

      const result = qianwenTryWindowFindAndGetRect(terms);
      if (result) return result;

      maxScroll = getMaxScroll();
    }
    return null;
  }

  function qianwenResolveExactRectNow(terms, preferredRoot = null) {
    const validTerms = uniqueList(terms).filter((term) => String(term || "").trim().length >= 2);
    if (!validTerms.length) return null;

    try {
      const matches = findQianwenKeywordMatches(validTerms);
      if (matches && matches.length && matches[0].range) {
        const rect = targetRectForKeywordMatch(matches[0]) || bestRangeRect(matches[0].range);
        if (rect && rect.width > 0 && rect.height > 0) {
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }
      }
    } catch (e) {}

    try {
      const textRect = findQianwenTextNodeRect(preferredRoot || document.body, validTerms);
      if (textRect && textRect._range && textRect.width > 0 && textRect.height > 0) {
        return { x: textRect.x, y: textRect.y, width: textRect.width, height: textRect.height };
      }
    } catch (e) {}

    const nativeRect = qianwenTryWindowFindAndGetRect(validTerms);
    return nativeRect && nativeRect.width > 0 && nativeRect.height > 0
      ? { x: nativeRect.x, y: nativeRect.y, width: nativeRect.width, height: nativeRect.height }
      : null;
  }

  async function captureQianwenScreenshotGuaranteed(task, matched, matchedKeywords, answerText, judgeResult, existingDomLocation) {
    const _dbg = (msg, data) => {
      try { console.log("[QIANWEN-DBG]", msg, data || ""); } catch (e) {}
    };
    _dbg("=== captureQianwenScreenshotGuaranteed START ===", {
      matched, matchedKeywords,
      keywords: task && task.keywords,
      answerTextLen: answerText && answerText.length,
    });

    let screenshotDataUrl = null;
    let keywordRect = null;
    let matchType = "qianwen_no_match";
    let validTerms = [];
    let answerEl = null;

    // 快速复用和完整定位两条路径都必须先绘制右上角命中词条。
    // 之前快速路径在 drawMatchedBadge 前提前返回，导致后续千问截图缺少词条。
    if (matched) drawMatchedBadge(matchedKeywords);

    // 命中判断阶段已经完成精确拉框时直接复用，避免截图阶段再次执行
    // 千问的 L1-L6 全套滚动定位。这是正常命中路径的主要提速点。
    if (matched && existingDomLocation && existingDomLocation.matched
        && visibleKeywordMarkExists() && keywordMarkFullyInViewport()) {
      const mark = Array.from(document.querySelectorAll(".geo-keyword-mark"))
        .map((node) => node.getBoundingClientRect())
        .find((rect) => rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight);
      if (mark) {
        keywordRect = { x: mark.x, y: mark.y, width: mark.width, height: mark.height };
        await prepareForScreenshot();
        screenshotDataUrl = await captureVisibleScreenshot();
        cleanupAfterScreenshot();
        if (screenshotDataUrl) {
          screenshotDataUrl = await annotateScreenshotDataUrl(screenshotDataUrl, keywordRect);
        }
        clearKeywordMarks();
        return {
          screenshotDataUrl,
          domLocation: {
            ...existingDomLocation,
            first_rect: keywordRect,
            needs_image_annotation: false,
            match_type: `${existingDomLocation.match_type || "qianwen_precise_keyword"}_reused`,
            screenshot_viewport: {
              width: window.innerWidth,
              height: window.innerHeight,
              device_pixel_ratio: window.devicePixelRatio || 1,
            },
          },
        };
      }
    }

    if (matched) {
      clearKeywordMarks();

      const terms = keywordSearchTerms(matchedKeywords, judgeResult, task.keywords);
      validTerms = uniqueList(terms).filter(t => String(t || "").trim().length >= 2);
      _dbg("search terms", { terms, validTerms });

      answerEl = GEO_LAST_ANSWER_ELEMENT && document.body.contains(GEO_LAST_ANSWER_ELEMENT)
        ? GEO_LAST_ANSWER_ELEMENT : null;
      _dbg("answer element", {
        hasAnswerEl: !!answerEl,
        tagName: answerEl && answerEl.tagName,
        className: answerEl && (answerEl.className || "").toString().slice(0, 200),
        scrollHeight: answerEl && answerEl.scrollHeight,
        innerTextLen: answerEl && answerEl.innerText && answerEl.innerText.length,
      });
      if (answerEl) {
        // 用 scrollQianwenToCenter 而非 scrollIntoView，避免千问内部滚动容器问题
        scrollQianwenToCenter(answerEl);
        await waitForScrollStable(1200);
      }

      keywordRect = qianwenTryWindowFindAndGetRect(validTerms);
      _dbg("after qianwenTryWindowFindAndGetRect #1", { keywordRect: keywordRect ? { x: keywordRect.x, y: keywordRect.y, w: keywordRect.width, h: keywordRect.height } : null });
      if (keywordRect) {
        matchType = "qianwen_native_find_instant";
      } else {
        keywordRect = await qianwenScrollAndFind(validTerms);
        _dbg("after qianwenScrollAndFind", { keywordRect: keywordRect ? { x: keywordRect.x, y: keywordRect.y, w: keywordRect.width, h: keywordRect.height } : null });
        if (keywordRect) matchType = "qianwen_scroll_find_instant";
      }

      if (!keywordRect) {
        const scrollMatches = await findQianwenKeywordMatchesByScroll(validTerms);
        _dbg("after findQianwenKeywordMatchesByScroll", { count: scrollMatches && scrollMatches.length });
        if (scrollMatches && scrollMatches.length) {
          const match = scrollMatches[0];
          const range = match.range;
          if (range) {
            scrollKeywordToCenter(range);
            await waitForScrollStable(800, nearestScrollableContainer(range.startContainer));
            const rect = bestRangeRect(range);
            _dbg("after DOM scroll fallback bestRangeRect", { rect: rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : null });
            if (rect && rect.width > 0 && rect.height > 0
                && rect.bottom > 0 && rect.top < window.innerHeight) {
              keywordRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
              matchType = "qianwen_dom_scroll_fallback";
            }
          }
        }
      }

      // L4 兜底：段级 rect —— 扫所有元素（含 span 等），不依赖标签
      // 优先用 TreeWalker 文本节点精确搜索（精确到关键词所在的那段文字）
      if (!keywordRect && answerEl) {
        // 找到千问真正的滚动容器
        const qianwenScrollContainer = findQianwenScrollContainer(answerEl);
        _dbg("L4 qianwen scroll container", {
          tag: qianwenScrollContainer && qianwenScrollContainer.tagName,
          className: qianwenScrollContainer && (qianwenScrollContainer.className || "").toString().slice(0, 100),
          scrollHeight: qianwenScrollContainer && qianwenScrollContainer.scrollHeight,
          clientHeight: qianwenScrollContainer && qianwenScrollContainer.clientHeight,
        });

        // 优先尝试：TreeWalker 文本节点精确搜索
        const textNodeRect = findQianwenTextNodeRect(answerEl, validTerms);
        _dbg("L4 after findQianwenTextNodeRect", {
          textNodeRect: textNodeRect ? { x: textNodeRect.x, y: textNodeRect.y, w: textNodeRect.width, h: textNodeRect.height, text: textNodeRect._text, matchedTerm: textNodeRect._matchedTerm } : null
        });

        let blockRect = null;
        if (textNodeRect && textNodeRect._range) {
          // 用 range 滚动到中央
          const rangeEl = textNodeRect._range.startContainer.parentElement;
          if (rangeEl) {
            try {
              blockRect = { _el: rangeEl, _text: textNodeRect._text, _matchedTerm: textNodeRect._matchedTerm, _isFullTerm: textNodeRect._isFullTerm, x: textNodeRect.x, y: textNodeRect.y, width: textNodeRect.width, height: textNodeRect.height };
            } catch (e) {}
          }
          keywordRect = { x: textNodeRect.x, y: textNodeRect.y, width: textNodeRect.width, height: textNodeRect.height };
          matchType = "qianwen_text_node_fallback";
          // 先滚动到中央确保框在视口里
          if (rangeEl) scrollQianwenToCenter(rangeEl);
          await waitForScrollStable(800);
          await new Promise(r => requestAnimationFrame(r));
        }

        if (!blockRect) {
          // fallback：段级 rect
          blockRect = findQianwenBlockRect(answerEl, validTerms);
          _dbg("L4 after findQianwenBlockRect", {
            blockRect: blockRect ? { x: blockRect.x, y: blockRect.y, w: blockRect.width, h: blockRect.height, text: blockRect._text, tag: blockRect._el && blockRect._el.tagName, outlineOnly: !!blockRect._outlineOnly } : null
          });
        }

        if (blockRect && blockRect._el && document.body.contains(blockRect._el)) {
          // 给元素加 outline 红框（截图时浏览器直接渲染）
          try {
            blockRect._el.style.outline = "3px solid #ff1744";
            blockRect._el.style.outlineOffset = "2px";
            blockRect._el.style.backgroundColor = "rgba(255, 23, 68, 0.08)";
            blockRect._el.setAttribute("data-geo-qianwen-outline", "1");
          } catch (e) {}

          // 用 scrollTop 直接设滚动位置（不依赖 scrollIntoView）
          const container = scrollQianwenToCenter(blockRect._el);
          await waitForScrollStable(800);
          await new Promise(r => requestAnimationFrame(r));

          if (document.body.contains(blockRect._el)) {
            const newR = blockRect._el.getBoundingClientRect();
            _dbg("after L4 scrollQianwenToCenter newR", {
              newR: newR ? { x: newR.x, y: newR.y, w: newR.width, h: newR.height } : null,
              inViewport: newR && newR.bottom > 0 && newR.top < window.innerHeight,
              container: container && (container.tagName + "." + (container.className || "").toString().slice(0, 50)),
            });
            if (newR && newR.width > 0 && newR.height > 0
                && newR.bottom > 0 && newR.top < window.innerHeight
                && !(newR.width > window.innerWidth * 0.6 || newR.height > window.innerHeight * 0.5)) {
              keywordRect = { x: newR.x, y: newR.y, width: newR.width, height: newR.height };
              matchType = "qianwen_block_fallback";
            } else {
              // 视口检查仍失败——用 scrollIntoView 再试一次
              try {
                blockRect._el.scrollIntoView({ block: "center", behavior: "instant" });
              } catch (e) {}
              await waitForScrollStable(600);
              if (document.body.contains(blockRect._el)) {
                const r2 = blockRect._el.getBoundingClientRect();
                if (r2 && r2.width > 0 && r2.height > 0
                    && r2.bottom > 0 && r2.top < window.innerHeight
                    && !(r2.width > window.innerWidth * 0.6 || r2.height > window.innerHeight * 0.5)) {
                  keywordRect = { x: r2.x, y: r2.y, width: r2.width, height: r2.height };
                  matchType = "qianwen_block_fallback_v2";
                } else {
                  // 最终兜底：使用精确文本节点 rect（来自 TreeWalker）
                  if (textNodeRect) {
                    keywordRect = { x: textNodeRect.x, y: textNodeRect.y, width: textNodeRect.width, height: textNodeRect.height };
                    matchType = "qianwen_block_outline_only";
                  } else if (blockRect._outlineOnly) {
                    keywordRect = { x: newR.x, y: newR.y, width: newR.width || 100, height: newR.height || 30 };
                    matchType = "qianwen_block_outline_only";
                  } else {
                    keywordRect = { x: blockRect.x, y: blockRect.y, width: blockRect.width, height: blockRect.height };
                    matchType = "qianwen_block_fallback_outline";
                  }
                }
              }
            }
          }
        }
      }

      // L5 兜底：边滚动边用 L4 搜索 —— 用真正的滚动容器逐步滚动
      if (!keywordRect && answerEl) {
        _dbg("L5 start: scroll-and-block-search");
        const scrollContainer = findQianwenScrollContainer(answerEl);
        _dbg("L5 scroll container found", {
          tag: scrollContainer && scrollContainer.tagName,
          className: scrollContainer && (scrollContainer.className || "").toString().slice(0, 100),
          scrollHeight: scrollContainer && scrollContainer.scrollHeight,
          clientHeight: scrollContainer && scrollContainer.clientHeight,
        });
        if (scrollContainer) {
          // 滚到顶部
          if (scrollContainer === document.documentElement || scrollContainer === document.scrollingElement) {
            window.scrollTo({ top: 0, behavior: "instant" });
          } else {
            scrollContainer.scrollTop = 0;
          }
          await waitForScrollStable(800);

          const getMaxScroll = () => scrollContainer === document.documentElement || scrollContainer === document.scrollingElement
            ? document.documentElement.scrollHeight - window.innerHeight
            : scrollContainer.scrollHeight - scrollContainer.clientHeight;
          const stepSize = Math.max(150, Math.floor(window.innerHeight * 0.35));
          let maxScroll = getMaxScroll();
          _dbg("L5 scroll config", { maxScroll, stepSize });

          for (let pos = 0; pos <= maxScroll + stepSize; pos += stepSize) {
            const clampedPos = Math.min(pos, Math.max(0, maxScroll));
            if (scrollContainer === document.documentElement || scrollContainer === document.scrollingElement) {
              window.scrollTo({ top: clampedPos, behavior: "instant" });
            } else {
              scrollContainer.scrollTop = clampedPos;
            }
            await new Promise(r => requestAnimationFrame(r));
            await sleep(600);
            await new Promise(r => requestAnimationFrame(r));
            maxScroll = getMaxScroll();

            // 优先用 TreeWalker 文本节点精确搜索
            const textNodeRect = findQianwenTextNodeRect(answerEl, validTerms);
            if (textNodeRect && textNodeRect._range) {
              const rangeEl = textNodeRect._range.startContainer.parentElement;
              if (rangeEl) {
                _dbg("L5 found text node", { pos, text: textNodeRect._text, matchedTerm: textNodeRect._matchedTerm });
                // 给元素加 outline
                try {
                  rangeEl.style.outline = "3px solid #ff1744";
                  rangeEl.style.outlineOffset = "2px";
                  rangeEl.style.backgroundColor = "rgba(255, 23, 68, 0.08)";
                  rangeEl.setAttribute("data-geo-qianwen-outline", "1");
                } catch (e) {}
                // 用 scrollQianwenToCenter 滚到中央
                scrollQianwenToCenter(rangeEl);
                await waitForScrollStable(800);
                await new Promise(r => requestAnimationFrame(r));
                keywordRect = { x: textNodeRect.x, y: textNodeRect.y, width: textNodeRect.width, height: textNodeRect.height };
                matchType = "qianwen_scroll_text_node_fallback";
                break;
              }
            }

            // 在当前滚动位置再跑 L4（限定在回答正文区域内搜索）
            const blockRect = findQianwenBlockRect(answerEl, validTerms);
            if (blockRect && blockRect._el && document.body.contains(blockRect._el)) {
              _dbg("L5 found block", { pos, text: blockRect._text, tag: blockRect._el.tagName });
              // 给元素加 outline
              try {
                blockRect._el.style.outline = "3px solid #ff1744";
                blockRect._el.style.outlineOffset = "2px";
                blockRect._el.style.backgroundColor = "rgba(255, 23, 68, 0.08)";
                blockRect._el.setAttribute("data-geo-qianwen-outline", "1");
              } catch (e) {}
              // 用 scrollQianwenToCenter 滚到中央
              scrollQianwenToCenter(blockRect._el);
              await waitForScrollStable(800);
              await new Promise(r => requestAnimationFrame(r));
              if (!document.body.contains(blockRect._el)) {
                _dbg("L5 element removed, continuing");
                continue;
              }
              const newR = blockRect._el.getBoundingClientRect();
              if (newR && newR.width > 0 && newR.height > 0
                  && newR.bottom > 0 && newR.top < window.innerHeight
                  && !(newR.width > window.innerWidth * 0.6 || newR.height > window.innerHeight * 0.5)) {
                keywordRect = { x: newR.x, y: newR.y, width: newR.width, height: newR.height };
                matchType = "qianwen_scroll_block_fallback";
                break;
              } else {
                // 用初始 rect 兜底
                keywordRect = { x: blockRect.x, y: blockRect.y, width: blockRect.width, height: blockRect.height };
                matchType = "qianwen_scroll_block_fallback_outline";
                break;
              }
            }
          }
        }
      }
    } else {
      clearKeywordMarks();
      if (GEO_LAST_ANSWER_ELEMENT && document.body.contains(GEO_LAST_ANSWER_ELEMENT)) {
        scrollQianwenToCenter(GEO_LAST_ANSWER_ELEMENT);
        await waitForScrollStable();
      }
    }

    if (matched && !keywordRect) {
      // 找不到关键词精确位置时不再回退到整个回答区域大框
      matchType = "qianwen_no_keyword_rect";
    }

    if (keywordRect) {
      // 千问的滚动容器不是 window，window.scrollBy 无效
      // L4/L5/L6 已用 scrollQianwenToCenter 处理滚动，这里只对 L1/L2/L3 的结果做视口检查
      const isFromBlock = matchType.includes("block") || matchType.includes("l6");
      if (!isFromBlock) {
        const targetY = keywordRect.y + keywordRect.height / 2 - window.innerHeight / 2;
        if (Math.abs(targetY) > 80) {
          // 找到关键词元素并滚到中央
          const answerEl2 = GEO_LAST_ANSWER_ELEMENT && document.body.contains(GEO_LAST_ANSWER_ELEMENT)
            ? GEO_LAST_ANSWER_ELEMENT : null;
          if (answerEl2) {
            const container = findQianwenScrollContainer(answerEl2);
            const containerRect = container.getBoundingClientRect();
            const targetScrollTop = keywordRect.y - containerRect.top + container.scrollTop
              - container.clientHeight / 2 + keywordRect.height / 2;
            if (container === document.documentElement || container === document.scrollingElement) {
              window.scrollTo({ top: Math.max(0, targetScrollTop), behavior: "instant" });
            } else {
              container.scrollTop = Math.max(0, targetScrollTop);
            }
            await waitForScrollStable(800);
          }
        }
      }
    }

    _dbg("=== FINAL keywordRect ===", {
      keywordRect: keywordRect ? { x: keywordRect.x, y: keywordRect.y, w: keywordRect.width, h: keywordRect.height } : null,
      matchType,
    });

    if (keywordRect && matched) {
      clearKeywordMarks();
      drawBoxFromRect(keywordRect, 10);
      await new Promise(r => requestAnimationFrame(r));
      await sleep(300);
    }

    // L6 终极兜底：截图前再次扫一次 L4
    if (matched && !keywordRect) {
      _dbg("L6 final fallback before screenshot");
      const l6AnswerEl = GEO_LAST_ANSWER_ELEMENT && document.body.contains(GEO_LAST_ANSWER_ELEMENT)
        ? GEO_LAST_ANSWER_ELEMENT : document.body;

      // 优先用 TreeWalker 文本节点精确搜索
      const textNodeRect = findQianwenTextNodeRect(l6AnswerEl, validTerms);
      if (textNodeRect && textNodeRect._range) {
        const rangeEl = textNodeRect._range.startContainer.parentElement;
        if (rangeEl) {
          try {
            rangeEl.style.outline = "3px solid #ff1744";
            rangeEl.style.outlineOffset = "2px";
            rangeEl.style.backgroundColor = "rgba(255, 23, 68, 0.08)";
            rangeEl.setAttribute("data-geo-qianwen-outline", "1");
          } catch (e) {}
          scrollQianwenToCenter(rangeEl);
          await waitForScrollStable(800);
          await new Promise(r => requestAnimationFrame(r));
          keywordRect = { x: textNodeRect.x, y: textNodeRect.y, width: textNodeRect.width, height: textNodeRect.height };
          matchType = "qianwen_l6_text_node";
          _dbg("L6 text node found", { rect: keywordRect, text: textNodeRect._text, matchedTerm: textNodeRect._matchedTerm });
        }
      }

      if (!keywordRect) {
        const finalBlockRect = findQianwenBlockRect(l6AnswerEl, validTerms);
        if (finalBlockRect && finalBlockRect._el) {
          // 给元素加 outline 红框（不依赖 rect 视口检查）
          try {
            finalBlockRect._el.style.outline = "3px solid #ff1744";
            finalBlockRect._el.style.outlineOffset = "2px";
            finalBlockRect._el.style.backgroundColor = "rgba(255, 23, 68, 0.08)";
            finalBlockRect._el.setAttribute("data-geo-qianwen-outline", "1");
          } catch (e) {}
          // 用 scrollQianwenToCenter 滚到中央
          scrollQianwenToCenter(finalBlockRect._el);
          await waitForScrollStable(800);
          await new Promise(r => requestAnimationFrame(r));
          if (document.body.contains(finalBlockRect._el)) {
            const newR = finalBlockRect._el.getBoundingClientRect();
            if (newR && newR.width > 0 && newR.height > 0
                && newR.bottom > 0 && newR.top < window.innerHeight
                && !(newR.width > window.innerWidth * 0.6 || newR.height > window.innerHeight * 0.5)) {
              keywordRect = { x: newR.x, y: newR.y, width: newR.width, height: newR.height };
              matchType = "qianwen_l6_final";
              _dbg("L6 found block", { rect: keywordRect, text: finalBlockRect._text });
            } else {
              // 即使不在视口内也设置——outline 已经画好了
              keywordRect = { x: newR.x || finalBlockRect.x, y: newR.y || finalBlockRect.y, width: newR.width || 200, height: newR.height || 30 };
              matchType = "qianwen_l6_final_outline";
              _dbg("L6 viewport check failed, using rect with outline", { rect: keywordRect, text: finalBlockRect._text });
            }
          }
        }
      }
    }

    // 截图前必须按当前滚动位置重新计算关键词坐标。此前保存的 rect 可能在
    // scrollTop 改变后已经失效，直接使用会把框画到侧边栏或视口外。
    if (matched && validTerms.length) {
      const refreshedRect = qianwenResolveExactRectNow(validTerms, answerEl || document.body);
      if (refreshedRect && refreshedRect.width > 0 && refreshedRect.height > 0) {
        keywordRect = {
          x: refreshedRect.x,
          y: refreshedRect.y,
          width: refreshedRect.width,
          height: refreshedRect.height,
        };
        matchType = `${matchType}_refreshed`;
      } else {
        keywordRect = null;
        matchType = "qianwen_exact_keyword_not_found";
      }
    }

    // 精确文字定位失败就不画框。整块回答区域不是“目标关键词”，不能
    // 为了保证有框而生成误导性标注。
    if (matched && !keywordRect) {
      matchType = "qianwen_exact_keyword_not_found";
    }

    // DOM 层先画一次便于浏览器原生截图；截图完成后仍会执行 Canvas 补框，
    // 双保险确保最终写入 Excel 的图片一定带有标注。
    if (matched && keywordRect) {
      clearKeywordMarks();
      drawBoxFromRect(keywordRect, 10);
      await new Promise(r => requestAnimationFrame(r));
      await sleep(300);
    }

    await prepareForScreenshot();
    if (matched && validTerms.length) {
      const captureRect = qianwenResolveExactRectNow(validTerms, answerEl || document.body);
      const captureRectVisible = Boolean(
        captureRect && captureRect.width > 0 && captureRect.height > 0 &&
        captureRect.x >= 0 && captureRect.y >= 0 &&
        captureRect.x + captureRect.width <= window.innerWidth &&
        captureRect.y + captureRect.height <= window.innerHeight
      );
      if (!captureRectVisible) {
        cleanupAfterScreenshot();
        throw new Error("千问截图瞬间未取得正文目标关键词的精确坐标；拒绝保存错框截图，请重跑该任务");
      }
      keywordRect = captureRect;
      matchType = `${matchType}_capture_refreshed`;
      clearKeywordMarks();
      drawBoxFromRect(keywordRect, 4);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
    screenshotDataUrl = await captureVisibleScreenshot();
    cleanupAfterScreenshot();

    // 清理千问的 outline 标记
    try {
      document.querySelectorAll("[data-geo-qianwen-outline='1']").forEach((el) => {
        el.style.outline = "";
        el.style.outlineOffset = "";
        el.style.backgroundColor = "";
        el.removeAttribute("data-geo-qianwen-outline");
      });
    } catch (e) {}

    if (matched && keywordRect && screenshotDataUrl) {
      screenshotDataUrl = await annotateScreenshotDataUrl(screenshotDataUrl, keywordRect);
    }

    clearKeywordMarks();
    const sel = window.getSelection && window.getSelection();
    if (sel) sel.removeAllRanges();

    _dbg("=== captureQianwenScreenshotGuaranteed END ===", {
      hasScreenshot: !!screenshotDataUrl,
      domLocationMatched: !!(keywordRect),
    });

    return {
      screenshotDataUrl,
      domLocation: keywordRect
        ? {
            matched: true,
            matched_keywords: matchedKeywords,
            first_rect: keywordRect,
            needs_image_annotation: false,
            match_type: matchType,
            screenshot_viewport: {
              width: window.innerWidth,
              height: window.innerHeight,
              device_pixel_ratio: window.devicePixelRatio || 1,
            },
          }
        : { matched: false }
    };
  }

  async function captureTaskScreenshot(task, matched, matchedKeywords, answerText, judgeResult, domLocation) {
    if (task.platform === "qianwen") {
      return await captureQianwenScreenshotGuaranteed(task, matched, matchedKeywords, answerText, judgeResult, domLocation);
    }

    let screenshotDataUrl = null;
    const isQianwen = task.platform === "qianwen";

    if (matched) {
      drawMatchedBadge(matchedKeywords);

      for (let attempt = 0; attempt < 2; attempt++) {
        if (domLocation && domLocation.matched && visibleKeywordMarkExists() && keywordMarkFullyInViewport()) break;

        clearKeywordMarks();
        if (GEO_LAST_ANSWER_ELEMENT && document.body.contains(GEO_LAST_ANSWER_ELEMENT)) {
          GEO_LAST_ANSWER_ELEMENT.scrollIntoView({ block: "center", behavior: "instant" });
          await waitForScrollStable(2000);
        }

        clearKeywordMarks();
        domLocation = await locateAndMarkKeywordForScreenshot(task.platform, answerText, matchedKeywords, judgeResult, task.keywords);

        if (!domLocation || !domLocation.matched || !visibleKeywordMarkExists() || !keywordMarkFullyInViewport()) {
          clearKeywordMarks();
          let scrollMatches = [];

          if (isQianwen) {
            scrollMatches = await findQianwenKeywordWithNativeFind(
              keywordSearchTerms(matchedKeywords, judgeResult, task.keywords)
            );
          }

          if (!scrollMatches.length) {
            if (isQianwen) {
              scrollMatches = await findQianwenKeywordMatchesByScroll(
                keywordSearchTerms(matchedKeywords, judgeResult, task.keywords)
              );
            } else {
              const answerRoot = GEO_LAST_ANSWER_ELEMENT && document.body.contains(GEO_LAST_ANSWER_ELEMENT)
                ? GEO_LAST_ANSWER_ELEMENT
                : null;
              const exactTerms = keywordSearchTerms(matchedKeywords, judgeResult, task.keywords)
                .sort((left, right) => normalizeKeywordText(right).length - normalizeKeywordText(left).length);
              scrollMatches = await findKeywordMatchesByScroll(exactTerms, answerRoot);
            }
          }

          if (scrollMatches.length) {
            if (isQianwen) {
              applyQianwenSelectionHighlight();
              const match = scrollMatches[0];
              const sel = window.getSelection && window.getSelection();
              if (sel && sel.rangeCount > 0) {
                try {
                  sel.removeAllRanges();
                  sel.addRange(match.range.cloneRange());
                } catch (e) {}
              }
            }

            const rects = isQianwen
              ? await drawKeywordAndEnsureViewportSmooth(scrollMatches[0])
              : await drawKeywordAndEnsureViewport(scrollMatches[0]);
            const firstRect = isQianwen
              ? targetRectForKeywordMatch(scrollMatches[0])
              : bestRangeRect(scrollMatches[0].range);

            if (isQianwen && (!firstRect || firstRect.width <= 0 || firstRect.height <= 0)) {
              const sel = window.getSelection && window.getSelection();
              if (sel && sel.rangeCount > 0) {
                const selRange = sel.getRangeAt(0);
                const selRect = bestRangeRect(selRange);
                if (selRect.width > 0 && selRect.height > 0) {
                  const overlayRects = drawBoxFromRect(selRect, 8);
                  if (overlayRects.length) {
                    const r = overlayRects[0];
                    domLocation = {
                      matched: true,
                      matched_keywords: [scrollMatches[0].keyword],
                      rects: overlayRects.map((rr) => ({ x: rr.x, y: rr.y, width: rr.width, height: rr.height })),
                      first_rect: { x: r.x, y: r.y, width: r.width, height: r.height },
                      needs_image_annotation: false,
                      match_type: "qianwen_native_find_selection",
                    };
                    continue;
                  }
                }
              }
            }

            if (firstRect && firstRect.width > 0 && firstRect.height > 0) {
              domLocation = {
                matched: true,
                matched_keywords: [scrollMatches[0].keyword],
                rects: rects.map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })),
                first_rect: { x: firstRect.x, y: firstRect.y, width: firstRect.width, height: firstRect.height },
                needs_image_annotation: false,
                match_type: isQianwen ? "qianwen_native_find" : "scroll_fallback",
              };
            } else if (isQianwen) {
              const sel = window.getSelection && window.getSelection();
              if (sel && sel.rangeCount > 0) {
                const selRect = bestRangeRect(sel.getRangeAt(0));
                if (selRect.width > 0 && selRect.height > 0) {
                  domLocation = {
                    matched: true,
                    matched_keywords: [scrollMatches[0].keyword],
                    rects: [{ x: selRect.x, y: selRect.y, width: selRect.width, height: selRect.height }],
                    first_rect: { x: selRect.x, y: selRect.y, width: selRect.width, height: selRect.height },
                    needs_image_annotation: false,
                    match_type: "qianwen_native_find_selection_only",
                  };
                }
              }
            }
          }
        }
      }

      await new Promise((resolve) => requestAnimationFrame(resolve));
      await sleep(isQianwen ? 900 : 500);

      // 非千问平台只允许用精确关键词 Range 的坐标补框。禁止再用整块回答区域
      // 兜底，否则“有框”反而会变成错误标注。
      const imageFallbackRect = domLocation && domLocation.matched && domLocation.first_rect
        ? domLocation.first_rect
        : null;
      if (!visibleKeywordMarkExists() || !keywordMarkFullyInViewport()) {
        if (isQianwen) {
          const sel = window.getSelection && window.getSelection();
          if (sel && sel.rangeCount > 0) {
            const selRect = bestRangeRect(sel.getRangeAt(0));
            if (selRect.width > 0 && selRect.height > 0 && selRect.bottom > 0 && selRect.top < window.innerHeight) {
              if (!domLocation || !domLocation.matched) {
                domLocation = {
                  matched: true,
                  matched_keywords: matchedKeywords,
                  first_rect: { x: selRect.x, y: selRect.y, width: selRect.width, height: selRect.height },
                  needs_image_annotation: false,
                  match_type: "qianwen_selection_visible",
                };
              }
            } else {
              clearKeywordMarks();
              if (imageFallbackRect) {
                domLocation = {
                  ...(domLocation || {}),
                  matched: true,
                  matched_keywords: matchedKeywords,
                  first_rect: imageFallbackRect,
                  needs_image_annotation: true,
                  match_type: (domLocation && domLocation.match_type) || "answer_area_fallback",
                };
              }
            }
          } else {
            clearKeywordMarks();
            if (imageFallbackRect) {
              domLocation = {
                ...(domLocation || {}),
                matched: true,
                matched_keywords: matchedKeywords,
                first_rect: imageFallbackRect,
                needs_image_annotation: true,
                match_type: (domLocation && domLocation.match_type) || "answer_area_fallback",
              };
            }
          }
        } else {
          clearKeywordMarks();
          if (imageFallbackRect) {
            domLocation = {
              ...(domLocation || {}),
              matched: true,
              matched_keywords: matchedKeywords,
              first_rect: imageFallbackRect,
              needs_image_annotation: true,
              match_type: (domLocation && domLocation.match_type) || "exact_keyword_canvas_fallback",
            };
          } else {
            domLocation = {
              matched: false,
              matched_keywords: matchedKeywords,
              first_rect: null,
              needs_image_annotation: false,
              match_type: "exact_keyword_not_found_no_box",
            };
          }
        }
      }
    } else {
      clearKeywordMarks();
      if (isQianwen) removeQianwenSelectionHighlight();
      if (GEO_LAST_ANSWER_ELEMENT && document.body.contains(GEO_LAST_ANSWER_ELEMENT)) {
        GEO_LAST_ANSWER_ELEMENT.scrollIntoView({ block: "center", behavior: "smooth" });
        await waitForScrollStable();
      }
    }

    // 元宝、豆包、DeepSeek、文心在最终截图前重新从“当前回答正文”解析一次
    // 精确文字 Range。随后清除网页覆盖层，最终只按 Range 坐标写入PNG，
    // 避免滚动、商品卡布局或覆盖层 padding 导致框偏移。
    if (matched && !isQianwen) {
      clearKeywordMarks();
      const finalExactLocation = await locateAndMarkKeywordForScreenshot(
        task.platform,
        answerText,
        matchedKeywords,
        judgeResult,
        task.keywords
      );
      const finalRect = finalExactLocation && finalExactLocation.first_rect;
      const finalRectVisible = Boolean(
        finalRect && finalRect.width > 0 && finalRect.height > 0 &&
        finalRect.y >= 0 && finalRect.x >= 0 &&
        finalRect.y + finalRect.height <= window.innerHeight &&
        finalRect.x + finalRect.width <= window.innerWidth
      );
      const finalRectCentered = finalRectVisible && rectNearViewportCenter(finalRect);
      clearKeywordMarks();
      if (finalExactLocation && finalExactLocation.matched && finalRectVisible && finalRectCentered) {
        domLocation = {
          ...finalExactLocation,
          needs_image_annotation: true,
          match_type: `${finalExactLocation.match_type || "exact_keyword_range"}_final_canvas`,
        };
      } else {
        const reason = finalRectVisible
          ? "目标关键词精确坐标未能移动到截图中部"
          : "回答已命中目标关键词，但截图前未取得正文精确坐标";
        throw new Error(`${reason}；拒绝保存不准确截图，请让该任务重跑`);
      }
    }

    let shouldAnnotateImage = matched && domLocation && domLocation.first_rect && (
      domLocation.needs_image_annotation ||
      (!visibleKeywordMarkExists() && !(isQianwen && (window.getSelection && window.getSelection()).rangeCount > 0)) ||
      !keywordMarkFullyInViewport()
    );
    let annotationRect = shouldAnnotateImage
      ? ((domLocation.rects && domLocation.rects.length) ? domLocation.rects : domLocation.first_rect)
      : null;

    if (isQianwen && matched && domLocation && domLocation.matched) {
      const sel = window.getSelection && window.getSelection();
      if (sel) {
        const terms = keywordSearchTerms(matchedKeywords, judgeResult, task.keywords);
        let reselected = false;
        for (const term of uniqueList(terms)) {
          if (String(term).trim().length < 2) continue;
          sel.removeAllRanges();
          const found = window.find(String(term), false, false, true, false, true, false);
          if (found && sel.rangeCount > 0) {
            const range = sel.getRangeAt(0);
            const container = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
              ? range.commonAncestorContainer.parentElement
              : range.commonAncestorContainer;
            if (container && !isIgnoredQianwenKeywordNode(container)) {
              reselected = true;
              break;
            }
          }
        }
        if (!reselected) sel.removeAllRanges();
      }
    }

    await prepareForScreenshot();
    if (matched && !isQianwen) {
      clearKeywordMarks();
      const captureExactLocation = await locateAndMarkKeywordForScreenshot(
        task.platform,
        answerText,
        matchedKeywords,
        judgeResult,
        task.keywords
      );
      const captureRect = captureExactLocation && captureExactLocation.first_rect;
      const captureRectValid = Boolean(
        captureExactLocation && captureExactLocation.matched &&
        captureRect && captureRect.width > 0 && captureRect.height > 0 &&
        captureRect.x >= 0 && captureRect.y >= 0 &&
        captureRect.x + captureRect.width <= window.innerWidth &&
        captureRect.y + captureRect.height <= window.innerHeight &&
        rectNearViewportCenter(captureRect)
      );
      clearKeywordMarks();
      if (!captureRectValid) {
        cleanupAfterScreenshot();
        throw new Error("截图瞬间未取得正文目标关键词的精确居中坐标；拒绝保存错框截图，请重跑该任务");
      }
      domLocation = {
        ...captureExactLocation,
        first_rect: { ...captureRect },
        needs_image_annotation: true,
        match_type: `${captureExactLocation.match_type || "exact_keyword_range"}_capture_refreshed`,
      };
      shouldAnnotateImage = true;
      annotationRect = (domLocation.rects && domLocation.rects.length)
        ? domLocation.rects
        : domLocation.first_rect;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
    screenshotDataUrl = await captureVisibleScreenshot();
    cleanupAfterScreenshot();
    if (shouldAnnotateImage && screenshotDataUrl) {
      screenshotDataUrl = await annotateScreenshotDataUrl(screenshotDataUrl, annotationRect);
    }
    if (isQianwen) {
      removeQianwenSelectionHighlight();
    }

    if (matched && domLocation && domLocation.matched) {
      domLocation.screenshot_viewport = {
        width: window.innerWidth,
        height: window.innerHeight,
        device_pixel_ratio: window.devicePixelRatio || 1,
      };
    }

    return { screenshotDataUrl, domLocation };
  }

  // 手动诊断 API —— 在 DevTools console 调用 window.geoQianwenDiagnose(keyword)
  // 返回页面里所有包含该关键词的段落级 rect（在当前视口里能找到的）
  window.geoQianwenDiagnose = function geoQianwenDiagnose(keyword) {
    const out = { keyword, results: [], errors: [] };
    try {
      const term = String(keyword || "").trim();
      if (!term) { out.errors.push("empty keyword"); return out; }
      out.viewport = { w: window.innerWidth, h: window.innerHeight };
      out.scroll = { x: window.scrollX, y: window.scrollY, docH: document.documentElement.scrollHeight };

      // 0) 找 answer areas
      try {
        const areas = findQianwenAnswerAreas();
        out.answerAreas = areas.map((el) => {
          const r = el.getBoundingClientRect();
          return {
            tag: el.tagName,
            className: String(el.className || "").slice(0, 100),
            rect: { x: r.x, y: r.y, w: r.width, h: r.height },
            textPreview: (el.textContent || "").trim().slice(0, 100),
          };
        });
      } catch (e) { out.errors.push("answerAreas: " + e.message); }

      // 0.5) GEO_LAST_ANSWER_ELEMENT 信息
      try {
        const lastEl = GEO_LAST_ANSWER_ELEMENT;
        if (lastEl && document.body.contains(lastEl)) {
          const r = lastEl.getBoundingClientRect();
          out.GEO_LAST_ANSWER_ELEMENT = {
            tag: lastEl.tagName,
            className: String(lastEl.className || "").slice(0, 100),
            rect: { x: r.x, y: r.y, w: r.width, h: r.height },
          };
        }
      } catch (e) {}

      // 1) window.find 试一次
      const sel = window.getSelection();
      if (sel && typeof window.find === "function") {
        sel.removeAllRanges();
        try {
          const found = window.find(term, false, false, true, false, true, false);
          if (found && sel.rangeCount > 0) {
            const range = sel.getRangeAt(0);
            const rect = range.getBoundingClientRect();
            out.results.push({ source: "window.find", rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height }, text: range.toString().slice(0, 80) });
          } else {
            out.results.push({ source: "window.find", found: false });
          }
        } catch (e) { out.errors.push("window.find: " + e.message); }
      }

      // 2) 段级 rect（L4）
      const blockRect = findQianwenBlockRect(document.body, [term]);
      if (blockRect) {
        out.results.push({
          source: "findQianwenBlockRect",
          rect: { x: blockRect.x, y: blockRect.y, w: blockRect.width, h: blockRect.height },
          text: blockRect._text,
          tagName: blockRect._el && blockRect._el.tagName,
          className: blockRect._el && (blockRect._el.className || "").toString().slice(0, 100),
        });
      } else {
        out.results.push({ source: "findQianwenBlockRect", found: false });
      }

      // 3) TreeWalker 全文搜索
      try {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
          acceptNode: (node) => {
            if (!node.nodeValue || !node.parentElement) return NodeFilter.FILTER_REJECT;
            if (node.parentElement.closest && (
              node.parentElement.closest("script,style,noscript,textarea,input,nav,aside,[role='navigation']")
            )) return NodeFilter.FILTER_REJECT;
            return node.nodeValue.includes(term) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
          }
        });
        const textNodes = [];
        let n;
        while ((n = walker.nextNode())) textNodes.push(n);
        out.textNodeMatches = textNodes.length;
        if (textNodes.length) {
          const range = document.createRange();
          range.setStart(textNodes[0], 0);
          range.setEnd(textNodes[0], Math.min(textNodes[0].nodeValue.length, term.length * 2));
          const r = range.getBoundingClientRect();
          out.results.push({
            source: "TreeWalker",
            rect: { x: r.x, y: r.y, w: r.width, h: r.height },
            sampleText: textNodes[0].nodeValue.slice(0, 100),
            textCount: textNodes.length,
          });
        }
      } catch (e) { out.errors.push("TreeWalker: " + e.message); }
      // 4) 滚动容器诊断 —— 遍历所有 scrollHeight > clientHeight 的元素
      try {
        const scrollables = [];
        document.querySelectorAll("*").forEach((el) => {
          if (scrollables.length >= 20) return;
          try {
            const style = getComputedStyle(el);
            if (style.overflowY !== "auto" && style.overflowY !== "scroll") return;
            if (el.scrollHeight <= el.clientHeight + 2) return;
            scrollables.push({
              tag: el.tagName,
              className: (el.className || "").toString().slice(0, 80),
              id: el.id,
              scrollHeight: el.scrollHeight,
              clientHeight: el.clientHeight,
              scrollTop: el.scrollTop,
              maxScroll: el.scrollHeight - el.clientHeight,
            });
          } catch (e) {}
        });
        out.scrollContainers = scrollables;
      } catch (e) { out.errors.push("scrollContainers: " + e.message); }

      // 5) 用拆短的关键词再搜一次（千问文本拆到多个 span，完整词可能跨 span）
      try {
        const shortTerms = splitShortTerms([term]);
        out.shortTerms = shortTerms;
        const shortBlockRect = findQianwenBlockRect(document.body, shortTerms);
        if (shortBlockRect) {
          out.results.push({
            source: "findQianwenBlockRect (short terms)",
            rect: { x: shortBlockRect.x, y: shortBlockRect.y, w: shortBlockRect.width, h: shortBlockRect.height },
            text: shortBlockRect._text,
            tagName: shortBlockRect._el && shortBlockRect._el.tagName,
            className: shortBlockRect._el && (shortBlockRect._el.className || "").toString().slice(0, 100),
          });
        } else {
          out.results.push({ source: "findQianwenBlockRect (short terms)", found: false });
        }
      } catch (e) { out.errors.push("shortTerms: " + e.message); }

    } catch (e) { out.errors.push("outer: " + e.message); }
    console.log("[QIANWEN-DIAGNOSE]", out);
    return out;
  };

  try {
    window.geoAutomationRun = async function geoAutomationRunWithStructuredConversation(task) {
      const taskId = String(task && task.task_id ? task.task_id : `${task.platform || "unknown"}:${task.question || ""}`);
      const runToken = `${taskId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      window.__geoActiveRunToken = runToken;
      const assertActiveRun = () => {
        if (window.__geoActiveRunToken !== runToken) {
          throw new Error(`当前窗口任务已被新的执行替换，停止旧任务以防串线：${taskId}`);
        }
      };
      try {
        assertActiveRun();
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
        assertActiveRun();
        await sendPrompt(task.platform, task.question);
        conversation.push({ role: "user", content: task.question });
        answerText = await waitAnswerStable(task, previousText);
        assertActiveRun();
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
          let followup = await nextFollowupPromise;
          if (!followup || !followup.prompt) {
            const safePrompt = buildSafeContextFallback(
              task.question,
              answerText,
              followupCount,
              task.platform,
              keywords
            );
            if (safePrompt) {
              followup = {
                prompt: safePrompt,
                source: "current_answer_safe_fallback",
                intent: "切换未使用角度并补充具体名称",
                reason: followup && followup.reason
                  ? `AI追问不可用，已改用当前Excel问题和当前真实回答兜底：${followup.reason}`
                  : "AI追问不可用，已改用当前Excel问题和当前真实回答兜底",
                real_answer_valid: true,
                used_structured_context: true,
              };
              runDebug.push({
                round: followupCount + 1,
                type: "safe_followup_recovered",
                prompt: safePrompt,
                source: followup.source,
                reason: followup.reason,
              });
            }
          }
          if (!followup || !followup.prompt) {
            const failureReason = followup && followup.reason ? followup.reason : "AI没有生成可用追问";
            runDebug.push({
              round: followupCount + 1,
              type: "ai_followup_failed_captured_as_unmatched",
              prompt_source: followup && followup.source ? followup.source : "error",
              prompt_reason: failureReason,
              real_answer_valid: followup && followup.real_answer_valid,
              conversation_turns: conversation.length,
              used_structured_context: followup && followup.used_structured_context,
            });
            judgeResult = {
              ok: true,
              has_answer: Boolean(answerText && normalizeText(answerText).length >= 20),
              matched: false,
              keyword: "",
              matched_text: "",
              evidence: "",
              source: "ai_followup_failed_no_fallback",
              reason: `AI追问生成失败，未发送规则模板，按未命中截图：${failureReason}`,
              ai_followup_failed: true,
            };
            matched = false;
            matchedKeywords = [];
            break;
          }

          assertActiveRun();
          const liveHit = liveAnswerKeywordHit(task, keywords, answerText);
          if (liveHit.matched) {
            matched = true;
            judgeResult = { ok: true, has_answer: true, ...liveHit };
            matchedKeywords = uniqueList([liveHit.matched_text, liveHit.keyword, keywords[0]]);
            answerText = liveHit.answer_text || answerText;
            runDebug.push({
              round: followupCount,
              type: "pre_send_keyword_hit",
              cancelled_followup: followup.prompt,
              matched_text: liveHit.matched_text,
              source: liveHit.source,
            });
            domLocation = await locateAndMarkKeywordForScreenshot(
              task.platform,
              answerText,
              matchedKeywords,
              judgeResult,
              keywords
            );
            break;
          }

          const prompt = withPlatformResponseLanguage(followup.prompt, task.platform);
          followupCount += 1;
          previousText = getAnswerText(task.platform);
          assertActiveRun();
          await sendPrompt(task.platform, prompt);
          conversation.push({ role: "user", content: prompt });
          lastPrompt = prompt;
          answerText = await waitAnswerStable(task, previousText);
          assertActiveRun();
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

        assertActiveRun();
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

  try {
    window.geoAutomationCollectTargetContext = async function geoAutomationCollectTargetContext(payload) {
      const platform = String(payload && payload.platform ? payload.platform : "");
      const keywords = Array.isArray(payload && payload.keywords)
        ? payload.keywords.map((item) => String(item || "").trim()).filter(Boolean)
        : [];
      if (!platform || !keywords.length) {
        return { ok: false, answer_text: "", error: "目标预搜索缺少平台或关键词" };
      }

      const primaryTarget = keywords[0];
      const researchPrompt = [
        `请客观介绍“${primaryTarget}”。`,
        "重点说明所在地、所属品类、核心特色、口味或能力、历史传承、适用场景和购买或使用方式。",
        "如果信息不确定请明确说明，不要虚构。",
      ].join("");
      const researchTask = {
        platform,
        keywords: [],
        keyword: "",
        answer_poll_interval: Number(payload.answer_poll_interval || 0.8),
        answer_stable_seconds: Number(payload.answer_stable_seconds || 3),
        answer_keyword_stable_seconds: 3,
        answer_final_settle_seconds: Number(payload.answer_final_settle_seconds || 5),
        answer_min_chars: 30,
        answer_timeout_seconds: Number(payload.answer_timeout_seconds || 70),
      };

      try {
        clearKeywordMarks();
        clearMatchedBadges();
        const previousText = getAnswerText(platform);
        await sendPrompt(platform, researchPrompt);
        const answerText = await waitAnswerStable(researchTask, previousText);
        return {
          ok: normalizeText(answerText).length >= 20,
          answer_text: answerText,
          prompt: researchPrompt,
          answer_debug: GEO_LAST_ANSWER_DEBUG,
        };
      } catch (error) {
        return {
          ok: false,
          answer_text: getAnswerText(platform),
          prompt: researchPrompt,
          error: String(error && error.message ? error.message : error),
        };
      }
    };
  } catch (e) {}
})();
