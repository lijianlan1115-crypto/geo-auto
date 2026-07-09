const DEFAULT_PLATFORM_URLS = {
  doubao: "https://www.doubao.com/chat/",
  qianwen: "https://tongyi.aliyun.com/qianwen/",
  deepseek: "https://chat.deepseek.com/",
  yuanbao: "https://yuanbao.tencent.com/chat/",
  wenxin: "https://chat.baidu.com/?enter_type=yiyan_site",
};

const PLATFORM_LABELS = {
  doubao: "豆包",
  qianwen: "千问",
  deepseek: "DeepSeek",
  yuanbao: "元宝",
  wenxin: "文心一言",
};

const serverUrlInput = document.getElementById("serverUrl");
const concurrencyInput = document.getElementById("concurrency");
const keywordInput = document.getElementById("keyword");
const aiJudgeEnabledInput = document.getElementById("aiJudgeEnabled");
const aiJudgeApiUrlInput = document.getElementById("aiJudgeApiUrl");
const aiJudgeModelInput = document.getElementById("aiJudgeModel");
const aiJudgeApiKeyInput = document.getElementById("aiJudgeApiKey");
const platformsEl = document.getElementById("platforms");
const logEl = document.getElementById("log");

function log(message) {
  logEl.textContent = typeof message === "string" ? message : JSON.stringify(message, null, 2);
}

async function send(action, payload = {}) {
  return chrome.runtime.sendMessage({ action, ...payload });
}

async function postServerJson(serverUrl, path, payload) {
  const response = await fetch(`${serverUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    data = { ok: false, error: text || response.statusText };
  }
  if (!response.ok) return { ok: false, error: data.error || `HTTP ${response.status}`, raw: data };
  return data;
}

function splitKeywords(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  return String(value || "")
    .split(/[\n,，、;；|/]+|\s+or\s+|\s+OR\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function defaultPlatforms(urlOverride = null) {
  return Object.entries(DEFAULT_PLATFORM_URLS).map(([key, url]) => ({
    key,
    name: PLATFORM_LABELS[key] || key,
    url: urlOverride || url,
  }));
}

function platformKeyFromName(name, index) {
  const known = Object.entries(PLATFORM_LABELS).find(([, label]) => label === name);
  if (known) return known[0];
  return `custom_${index + 1}_${String(name || "platform").replace(/\W+/g, "_").slice(0, 24)}`;
}

function renderPlatforms(platforms) {
  platformsEl.innerHTML = "";
  const list = platforms && platforms.length ? platforms : defaultPlatforms();
  list.forEach((platform, index) => {
    const row = document.createElement("div");
    row.className = "platform-row";
    row.dataset.platformKey = platform.key || platformKeyFromName(platform.name, index);
    row.innerHTML = `
      <input data-platform-name value="${platform.name || platform.key || `平台${index + 1}`}">
      <input data-platform-url value="${platform.url || ""}">
      <button class="icon" data-remove-platform title="删除平台">×</button>
    `;
    platformsEl.appendChild(row);
  });
}

function readForm() {
  const serverUrl = serverUrlInput.value.replace(/\/$/, "");
  const concurrency = Number(concurrencyInput.value || 3);
  const keyword = keywordInput.value.trim();
  const platforms = [];
  const platformUrls = {};
  platformsEl.querySelectorAll(".platform-row").forEach((row, index) => {
    const name = row.querySelector("[data-platform-name]").value.trim() || `平台${index + 1}`;
    const url = row.querySelector("[data-platform-url]").value.trim();
    if (!url) return;
    const key = row.dataset.platformKey || platformKeyFromName(name, index);
    platforms.push({ key, name, url });
    platformUrls[key] = url;
  });
  const aiJudge = {
    enabled: aiJudgeEnabledInput.checked,
    api_url: aiJudgeApiUrlInput.value.trim(),
    model: aiJudgeModelInput.value.trim(),
    api_key: aiJudgeApiKeyInput.value.trim(),
  };
  return { serverUrl, concurrency, keyword, platforms, platformUrls, aiJudge };
}

async function saveSettings() {
  const form = readForm();
  const result = await send("SAVE_SETTINGS", form);
  return { ...result, platforms: form.platforms, aiJudge: { ...form.aiJudge, api_key: form.aiJudge.api_key ? "***" : "" } };
}

document.getElementById("health").addEventListener("click", async () => {
  const form = readForm();
  log(await send("HEALTH", { serverUrl: form.serverUrl }));
});

document.getElementById("save").addEventListener("click", async () => {
  log(await saveSettings());
});

document.getElementById("testFollowup").addEventListener("click", async () => {
  const form = readForm();
  const saved = await saveSettings();
  if (!saved || !saved.ok) {
    log(saved || { ok: false, error: "保存配置失败，不能测试AI追问" });
    return;
  }

  const keywords = splitKeywords(form.keyword);
  if (!keywords.length) {
    log({ ok: false, error: "请先填写目标关键词，再测试AI追问。测试追问会自动禁止出现该关键词。" });
    return;
  }

  const sampleQuestion = "贵州有哪些适合企业合作的软件服务公司？";
  const sampleAnswer = "如果你想选择贵州本地的软件服务公司，可以从产品成熟度、客户案例、交付能力、售后响应速度和行业经验几个角度来比较。也可以优先看是否有本地化团队、实际项目落地经验、报价透明度以及后续维护能力。";
  const result = await postServerJson(form.serverUrl, "/generate-followup", {
    keywords,
    platform: "本地AI追问测试",
    followup_count: 0,
    answer_text: sampleAnswer,
    question: {
      question: sampleQuestion,
      answer: sampleAnswer,
      platform: "本地AI追问测试",
      conversation: [
        { role: "user", content: sampleQuestion },
        { role: "assistant", content: sampleAnswer },
      ],
    },
  });

  log({
    title: "AI追问测试结果",
    ok: Boolean(result && result.ok),
    source: result && result.source,
    prompt: result && result.prompt,
    reason: result && result.reason,
    intent: result && result.intent,
    api_mode: result && result.api_mode,
    real_answer_valid: result && result.real_answer_valid,
    used_structured_context: result && result.used_structured_context,
    conversation_turns: result && result.conversation_turns,
    raw: result,
  });
});

document.getElementById("testShot").addEventListener("click", async () => {
  const form = readForm();
  const saved = await saveSettings();
  if (!saved || !saved.ok) {
    log(saved || { ok: false, error: "保存配置失败" });
    return;
  }
  log(await send("TEST_SCREENSHOT", { serverUrl: form.serverUrl, keyword: form.keyword }));
});

document.getElementById("mockUrls").addEventListener("click", async () => {
  const serverUrl = serverUrlInput.value.replace(/\/$/, "");
  renderPlatforms(defaultPlatforms(`${serverUrl}/mock-platform`));
  log(await saveSettings());
});

document.getElementById("realUrls").addEventListener("click", async () => {
  renderPlatforms(defaultPlatforms());
  log(await saveSettings());
});

document.getElementById("addPlatform").addEventListener("click", () => {
  const current = readForm().platforms;
  current.push({ key: `custom_${Date.now()}`, name: `平台${current.length + 1}`, url: "" });
  renderPlatforms(current);
});

platformsEl.addEventListener("click", (event) => {
  if (!event.target.matches("[data-remove-platform]")) return;
  event.target.closest(".platform-row").remove();
});

document.getElementById("reloadPage").addEventListener("click", async () => log(await send("RELOAD_ACTIVE_TAB")));
document.getElementById("reloadExtension").addEventListener("click", async () => log(await send("RELOAD_EXTENSION")));
document.getElementById("resetFailed").addEventListener("click", async () => log(await send("RESET_FAILED_TASKS")));
document.getElementById("resetAll").addEventListener("click", async () => {
  const saved = await saveSettings();
  if (!saved || !saved.ok) {
    log(saved || { ok: false, error: "保存配置失败" });
    return;
  }
  log(await send("RESET_ALL_TASKS"));
});

document.getElementById("start").addEventListener("click", async () => {
  const form = readForm();
  const saved = await saveSettings();
  if (!saved || !saved.ok) {
    log(saved || { ok: false, error: "保存配置失败" });
    return;
  }
  log(await send("START", {
    serverUrl: form.serverUrl,
    concurrency: form.concurrency,
    platforms: form.platforms,
    aiJudge: form.aiJudge,
  }));
});

document.getElementById("openLoginTabs").addEventListener("click", async () => {
  const saved = await saveSettings();
  if (!saved || !saved.ok) {
    log(saved || { ok: false, error: "保存配置失败" });
    return;
  }
  log(await send("OPEN_LOGIN_TABS"));
});

document.getElementById("stop").addEventListener("click", async () => log(await send("STOP")));

send("GET_SETTINGS").then((data) => {
  if (!data || !data.ok) return;
  if (data.serverUrl) serverUrlInput.value = data.serverUrl;
  if (data.concurrency) concurrencyInput.value = data.concurrency;
  if (data.keyword) keywordInput.value = data.keyword;
  const aiJudge = data.aiJudge || {};
  aiJudgeEnabledInput.checked = Boolean(aiJudge.enabled);
  aiJudgeApiUrlInput.value = aiJudge.api_url || "";
  aiJudgeModelInput.value = aiJudge.model || "";
  aiJudgeApiKeyInput.value = aiJudge.api_key || "";
  aiJudgeApiKeyInput.placeholder = aiJudge.has_api_key
    ? `已保存 ${aiJudge.api_key_preview || ""}，不修改可留空`
    : "只保存在本机 Chrome 配置和本地服务";
  if (data.platforms && data.platforms.length) {
    renderPlatforms(data.platforms);
  } else if (data.platformUrls && Object.keys(data.platformUrls).length) {
    renderPlatforms(Object.entries(data.platformUrls).map(([key, url]) => ({ key, name: PLATFORM_LABELS[key] || key, url })));
  } else {
    renderPlatforms(defaultPlatforms());
  }
}).catch(() => {
  chrome.storage.local.get(["serverUrl", "concurrency", "keyword", "platforms", "platformUrls", "aiJudge"], (data) => {
    if (data.serverUrl) serverUrlInput.value = data.serverUrl;
    if (data.concurrency) concurrencyInput.value = data.concurrency;
    if (data.keyword) keywordInput.value = data.keyword;
    const aiJudge = data.aiJudge || {};
    aiJudgeEnabledInput.checked = Boolean(aiJudge.enabled);
    aiJudgeApiUrlInput.value = aiJudge.api_url || "";
    aiJudgeModelInput.value = aiJudge.model || "";
    aiJudgeApiKeyInput.value = aiJudge.api_key || "";
    if (data.platforms && data.platforms.length) {
      renderPlatforms(data.platforms);
    } else if (data.platformUrls && Object.keys(data.platformUrls).length) {
      renderPlatforms(Object.entries(data.platformUrls).map(([key, url]) => ({ key, name: PLATFORM_LABELS[key] || key, url })));
    } else {
      renderPlatforms(defaultPlatforms());
    }
  });
});