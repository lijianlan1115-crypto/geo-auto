// 通用 GEO 追问补丁：去掉固定学校模板，追问必须由本地 AI 根据真实回复生成。
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
})();
