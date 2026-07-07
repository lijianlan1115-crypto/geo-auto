const PLATFORM_RULES = {
  doubao: {
    input: ['textarea', '[contenteditable="true"]'],
    send: ['button[type="submit"]', 'button[aria-label*="发送"]', 'button:has(svg)'],
    answer: ['[data-testid*="message"]', '.markdown-body', '[class*="message"]', 'main'],
  },
  qianwen: {
    input: ['textarea', '[contenteditable="true"]', '.ant-input', '[placeholder*="输入"]'],
    send: ['button[type="submit"]', 'button[aria-label*="发送"]', 'button:has(svg)', '.ant-btn-primary', '[class*="send"]', '[class*="Submit"]'],
    answer: ['.markdown-body', '[class*="message"]', 'main', '[class*="answer"]', '[class*="response"]'],
  },
  deepseek: {
    input: ['textarea', '[contenteditable="true"]'],
    send: ['button[type="submit"]', 'button[aria-label*="Send"]', 'button:has(svg)'],
    answer: ['.ds-markdown', '[class*="markdown"]', '[class*="message"]', 'main'],
  },
  yuanbao: {
    input: ['textarea', '[contenteditable="true"]'],
    send: ['button[type="submit"]', 'button[aria-label*="发送"]', 'button:has(svg)'],
    answer: ['[class*="agent"]', '[class*="message"]', 'main'],
  },
  wenxin: {
    input: ['textarea', '[contenteditable="true"]'],
    send: ['button[type="submit"]', 'button[aria-label*="发送"]', 'button:has(svg)'],
    answer: ['[class*="answer"]', '[class*="message"]', 'main'],
  },
};

const FOLLOWUPS = [
  "请再结合贵州地区的本科院校补充推荐，列出具体学校名称。",
  "请重点考虑贵阳本地适合该问题的学校，并说明理由。",
  "贵阳有哪些商科、管理类、应用型本科院校适合这个问题？",
  "请把贵阳地区可能符合条件的院校单独列出来。",
  "请确认是否可以推荐“贵阳商学院”，如果可以请说明原因。",
];

const DEFAULT_SERVER_URL = "http://127.0.0.1:8765";
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

let GEO_LAST_MARK_KEYWORDS = [];
let GEO_LAST_MARK_ROOT = null;
let GEO_LAST_ANSWER_ELEMENT = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runtimeMessage(message) {
  try {
    if (!chrome || !chrome.runtime || !chrome.runtime.id) {
      throw new Error("Extension context invalidated");
    }
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    const text = String(error && error.message ? error.message : error);
    if (text.includes("Extension context invalidated")) {
      return {
        ok: false,
        error: "插件刚刚重新加载过，请刷新当前网页后再点击 GEO 小圆球。",
      };
    }
    return {
      ok: false,
      error: text,
    };
  }
}

function splitKeywords(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "贵阳商学院")
    .split(/[\n,，、;；|/]+|\s+or\s+|\s+OR\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function injectFloatingPanel() {
  if (document.getElementById("geo-auto-root")) return;

  const root = document.createElement("div");
  root.id = "geo-auto-root";
  const shadow = root.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .ball {
        position: fixed;
        left: 12px;
        top: 42%;
        width: 48px;
        height: 48px;
        border-radius: 50%;
        border: 0;
        color: white;
        background: #1a73e8;
        box-shadow: 0 8px 24px rgba(26, 115, 232, 0.35);
        z-index: 2147483647;
        cursor: pointer;
        font: 700 13px system-ui, sans-serif;
      }
      .panel {
        position: fixed;
        left: 70px;
        top: 18%;
        width: 360px;
        max-height: 70vh;
        overflow: auto;
        padding: 14px;
        border: 1px solid #dadce0;
        border-radius: 10px;
        background: white;
        color: #202124;
        box-shadow: 0 18px 45px rgba(60, 64, 67, 0.25);
        z-index: 2147483647;
        font: 13px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .panel[hidden] { display: none; }
      h2 { margin: 0 0 10px; font-size: 16px; }
      label { display: block; color: #5f6368; margin: 10px 0 4px; font-size: 12px; }
      input {
        box-sizing: border-box;
        width: 100%;
        padding: 7px 8px;
        border: 1px solid #dadce0;
        border-radius: 6px;
        color: #202124;
        background: #fff;
        font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      .row { display: flex; gap: 8px; margin-top: 12px; }
      button.action {
        flex: 1;
        border: 0;
        border-radius: 6px;
        padding: 8px 10px;
        cursor: pointer;
        color: white;
        background: #1a73e8;
        font: 13px system-ui, sans-serif;
      }
      button.secondary { color: #1a73e8; background: #e8f0fe; }
      button.danger { background: #d93025; }
      .status {
        margin-top: 10px;
        white-space: pre-wrap;
        color: #3c4043;
        background: #f8fafd;
        border: 1px solid #e8eaed;
        border-radius: 6px;
        padding: 8px;
        max-height: 110px;
        overflow: auto;
      }
    </style>
    <button class="ball" title="GEO反馈自动化">GEO</button>
    <section class="panel" hidden>
      <h2>GEO反馈自动化</h2>
      <label>Python服务地址</label>
      <input data-key="serverUrl" value="${DEFAULT_SERVER_URL}">
      <label>并发数</label>
      <input data-key="concurrency" type="number" min="1" max="5" value="3">
      <label>目标关键词（多个用逗号/顿号/or分隔）</label>
      <input data-key="keyword" value="贵阳商学院">
      <div data-platforms></div>
      <div class="row">
        <button class="action secondary" data-action="mockUrls">使用本地模拟平台</button>
        <button class="action secondary" data-action="realUrls">使用真实AI平台</button>
      </div>
      <div class="row">
        <button class="action" data-action="save">保存配置</button>
        <button class="action secondary" data-action="health">检查服务</button>
      </div>
      <div class="row">
        <button class="action" data-action="start">开始</button>
        <button class="action secondary" data-action="openLoginTabs">打开平台登录</button>
        <button class="action secondary" data-action="testShot">测试截图</button>
        <button class="action danger" data-action="stop">停止</button>
      </div>
      <div class="row">
        <button class="action secondary" data-action="reloadPage">刷新当前页</button>
        <button class="action secondary" data-action="reloadExtension">重载插件</button>
      </div>
      <div class="row">
        <button class="action secondary" data-action="resetFailed">重置失败任务</button>
      </div>
      <div class="status">点击“检查服务”确认 Python 已启动。</div>
    </section>
  `;

  document.documentElement.appendChild(root);

  const panel = shadow.querySelector(".panel");
  const status = shadow.querySelector(".status");
  const platformsBox = shadow.querySelector("[data-platforms]");

  for (const [key, label] of Object.entries(PLATFORM_LABELS)) {
    const item = document.createElement("div");
    item.innerHTML = `
      <label>${label} URL</label>
      <input data-platform="${key}" value="${DEFAULT_PLATFORM_URLS[key]}">
    `;
    platformsBox.appendChild(item);
  }

  const setStatus = (value) => {
    status.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  };

  const readForm = () => {
    const serverUrl = shadow.querySelector('[data-key="serverUrl"]').value.replace(/\/$/, "");
    const concurrency = Number(shadow.querySelector('[data-key="concurrency"]').value || 3);
    const keyword = shadow.querySelector('[data-key="keyword"]').value.trim() || "贵阳商学院";
    const platformUrls = {};
    shadow.querySelectorAll("[data-platform]").forEach((input) => {
      platformUrls[input.dataset.platform] = input.value.trim();
    });
    return { serverUrl, concurrency, keyword, platformUrls };
  };

  const loadSettings = async () => {
    const settings = await runtimeMessage({ action: "GET_SETTINGS" });
    if (!settings || !settings.ok) return;
    shadow.querySelector('[data-key="serverUrl"]').value = settings.serverUrl || DEFAULT_SERVER_URL;
    shadow.querySelector('[data-key="concurrency"]').value = settings.concurrency || 3;
    shadow.querySelector('[data-key="keyword"]').value = settings.keyword || "贵阳商学院";
    const urls = { ...DEFAULT_PLATFORM_URLS, ...(settings.platformUrls || {}) };
    shadow.querySelectorAll("[data-platform]").forEach((input) => {
      input.value = urls[input.dataset.platform] || "";
    });
  };

  shadow.querySelector(".ball").addEventListener("click", async () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) await loadSettings();
  });

  shadow.addEventListener("click", async (event) => {
    const action = event.target && event.target.dataset && event.target.dataset.action;
    if (!action) return;

    const form = readForm();
    if (action === "save") {
      setStatus(await runtimeMessage({ action: "SAVE_SETTINGS", ...form }));
    }
    if (action === "mockUrls") {
      shadow.querySelectorAll("[data-platform]").forEach((input) => {
        input.value = "http://127.0.0.1:8765/mock-platform";
      });
      const mockForm = readForm();
      setStatus(await runtimeMessage({ action: "SAVE_SETTINGS", ...mockForm }));
    }
    if (action === "realUrls") {
      shadow.querySelectorAll("[data-platform]").forEach((input) => {
        input.value = DEFAULT_PLATFORM_URLS[input.dataset.platform] || "";
      });
      const realForm = readForm();
      setStatus(await runtimeMessage({ action: "SAVE_SETTINGS", ...realForm }));
    }
    if (action === "health") {
      await runtimeMessage({ action: "SAVE_SETTINGS", ...form });
      setStatus(await runtimeMessage({ action: "HEALTH", serverUrl: form.serverUrl }));
    }
    if (action === "start") {
      await runtimeMessage({ action: "SAVE_SETTINGS", ...form });
      setStatus(await runtimeMessage({ action: "START", serverUrl: form.serverUrl, concurrency: form.concurrency }));
    }
    if (action === "openLoginTabs") {
      await runtimeMessage({ action: "SAVE_SETTINGS", ...form });
      setStatus(await runtimeMessage({ action: "OPEN_LOGIN_TABS" }));
    }
    if (action === "testShot") {
      await runtimeMessage({ action: "SAVE_SETTINGS", ...form });
      setStatus(await runtimeMessage({ action: "TEST_SCREENSHOT", serverUrl: form.serverUrl, keyword: form.keyword }));
    }
    if (action === "stop") {
      setStatus(await runtimeMessage({ action: "STOP" }));
    }
    if (action === "reloadPage") {
      setStatus(await runtimeMessage({ action: "RELOAD_ACTIVE_TAB" }));
    }
    if (action === "reloadExtension") {
      setStatus(await runtimeMessage({ action: "RELOAD_EXTENSION" }));
    }
    if (action === "resetFailed") {
      setStatus(await runtimeMessage({ action: "RESET_FAILED_TASKS" }));
    }
  });
}

function firstVisible(selectors) {
  for (const selector of selectors) {
    const nodes = Array.from(document.querySelectorAll(selector));
    const node = nodes.find((item) => {
      const rect = item.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (node) return node;
  }
  return null;
}

function visibleElements(selectors) {
  const elements = [];
  for (const selector of selectors) {
    for (const node of document.querySelectorAll(selector)) {
      const rect = node.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        elements.push(node);
      }
    }
  }
  return elements;
}

function getInputText(input) {
  return (input.isContentEditable ? input.textContent : input.value || "").trim();
}

function setInputValue(input, text) {
  input.focus();
  if (input.isContentEditable) {
    input.textContent = text;
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  } else {
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function pressEnter(input) {
  input.focus();
  input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 }));
  input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 }));
}

function findSendButton(input, platform) {
  const inputRect = input.getBoundingClientRect();
  const allButtons = visibleElements([
    'button[type="submit"]',
    'button[aria-label*="发送"]',
    'button[aria-label*="Send"]',
    'button[class*="send"]',
    'button[class*="Send"]',
    'button',
    '[role="button"]',
  ]);

  const inputCenterX = (inputRect.left + inputRect.right) / 2;
  const inputCenterY = (inputRect.top + inputRect.bottom) / 2;

  const candidates = allButtons
    .filter((button) => {
      if (button.disabled || button.getAttribute("aria-disabled") === "true") return false;
      const rect = button.getBoundingClientRect();
      const text = `${button.innerText || ""} ${button.getAttribute("aria-label") || ""} ${button.title || ""}`;
      const classList = button.className || "";
      
      if (/Tool|Deep Thinking|更多|快速|PPT|图片|视频|录音|编程|\+|清空|重置/.test(text.trim())) return false;
      
      const nearInput =
        Math.abs(rect.left - inputRect.right) < 150 ||
        Math.abs(rect.right - inputRect.left) < 150 ||
        (rect.left >= inputRect.left - 100 && rect.right <= inputRect.right + 150);
      
      const isSubmit = /发送|Send|send|提交/.test(text);
      const isPrimary = /primary|ant-btn-primary/.test(classList);
      const hasIcon = button.querySelector("svg") || button.querySelector("i");
      
      return nearInput && (isSubmit || isPrimary || hasIcon || rect.width > 0 && rect.height > 0);
    })
    .map((button) => {
      const rect = button.getBoundingClientRect();
      const text = `${button.innerText || ""} ${button.getAttribute("aria-label") || ""} ${button.title || ""}`;
      const classList = button.className || "";
      let score = 0;
      
      if (/发送|Send|send|提交/.test(text)) score += 200;
      if (/primary|ant-btn-primary/.test(classList)) score += 150;
      if (button.querySelector("svg")) score += 100;
      if (rect.left > inputRect.left + inputRect.width * 0.8) score += 80;
      if (Math.abs(rect.top - inputRect.top) < 40) score += 50;
      
      score -= Math.abs(rect.right - inputRect.right) / 10;
      score -= Math.abs(rect.top - inputRect.top) / 20;
      score -= Math.abs((rect.left + rect.right) / 2 - inputCenterX) / 30;
      
      return { button, score };
    })
    .sort((a, b) => b.score - a.score);

  if (candidates.length) {
    return candidates[0].button;
  }
  
  const fallbackButtons = visibleElements(['.ant-btn-primary', '[class*="send"]', '[class*="Submit"]']);
  for (const btn of fallbackButtons) {
    if (!btn.disabled && btn.getBoundingClientRect().width > 0) {
      return btn;
    }
  }
  
  return null;
}

async function clickSendButton(input, platform) {
  const sendButton = findSendButton(input, platform);
  if (sendButton) {
    sendButton.scrollIntoView({ block: "center", inline: "center" });
    await sleep(200);
    
    const rect = sendButton.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    
    sendButton.click();
    await sleep(100);
    
    if (platform === "qianwen") {
      try {
        sendButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: centerX, clientY: centerY }));
        await sleep(50);
        sendButton.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: centerX, clientY: centerY }));
        await sleep(50);
      } catch (e) {}
    }
    
    return true;
  }
  
  pressEnter(input);
  await sleep(300);
  
  pressEnter(input);
  return false;
}

async function sendPrompt(platform, text) {
  const rules = PLATFORM_RULES[platform] || PLATFORM_RULES.doubao;
  const input = firstVisible(rules.input);
  if (!input) throw new Error("找不到输入框，请先确认平台页面已登录并处于聊天页");

  setInputValue(input, text);
  await sleep(500);

  await clickSendButton(input, platform);

  const started = Date.now();
  while (Date.now() - started < 8000) {
    if (!document.body.contains(input) || getInputText(input) !== text.trim()) {
      return true;
    }
    await sleep(400);
  }

  throw new Error("问题已填入输入框，但没有成功发送：发送按钮可能没有点击到");
}

function getAnswerCandidates(platform) {
  const rules = PLATFORM_RULES[platform] || PLATFORM_RULES.doubao;
  for (const selector of rules.answer) {
    const nodes = Array.from(document.querySelectorAll(selector)).filter((node) => {
      if (node.closest("#geo-auto-root")) return false;
      const rect = node.getBoundingClientRect();
      const text = (node.innerText || node.textContent || "").trim();
      return text.length > 10 && rect.width > 0 && rect.height > 0;
    });
    if (nodes.length) return nodes;
  }
  return [];
}

function getAnswerText(platform) {
  return getAnswerCandidates(platform)
    .map((node) => (node.innerText || node.textContent || "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function findLatestAnswerElement(platform, previousText = "", answerText = "") {
  const candidates = getAnswerCandidates(platform);
  if (!candidates.length) return null;

  const scored = candidates.map((node, index) => {
    const text = (node.innerText || node.textContent || "").trim();
    const rect = node.getBoundingClientRect();
    let score = index;
    if (text && !previousText.includes(text)) score += 500;
    if (answerText && answerText.includes(text)) score += 200;
    score += Math.max(0, rect.top + window.scrollY) / 1000;
    return { node, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0].node;
}

function scrollToAnswerElement(element) {
  if (!element || !document.body.contains(element)) return;
  const rect = element.getBoundingClientRect();
  const targetTop = rect.top + window.scrollY - window.innerHeight * 0.2;
  window.scrollTo({
    top: Math.max(0, targetTop),
    behavior: "smooth",
  });
  return targetTop;
}

function ensureElementVisible(element, padding = 80) {
  if (!element || !document.body.contains(element)) return;
  const rect = element.getBoundingClientRect();
  
  if (rect.top < padding || rect.bottom > window.innerHeight - padding) {
    const targetTop = rect.top + window.scrollY - window.innerHeight * 0.3;
    window.scrollTo({
      top: Math.max(0, targetTop),
      behavior: "smooth",
    });
    return true;
  }
  return false;
}

async function waitAnswerStable(task, previousText = "") {
  const pollMs = Number(task.answer_poll_interval || 2) * 1000;
  const stableMs = Number(task.answer_stable_seconds || 10) * 1000;
  const timeoutMs = Number(task.answer_timeout_seconds || 180) * 1000;
  const started = Date.now();
  let lastText = getAnswerText(task.platform);
  let lastChangedAt = Date.now();
  let sawNewAnswer = lastText && lastText !== previousText;

  while (Date.now() - started < timeoutMs) {
    const text = getAnswerText(task.platform);
    if (text !== lastText) {
      lastText = text;
      lastChangedAt = Date.now();
      if (text && text !== previousText) {
        sawNewAnswer = true;
      }
    }
    if (sawNewAnswer && lastText && Date.now() - lastChangedAt >= stableMs) {
      GEO_LAST_ANSWER_ELEMENT = findLatestAnswerElement(task.platform, previousText, lastText);
      return lastText;
    }
    await sleep(pollMs);
  }

  if (!sawNewAnswer) {
    throw new Error("问题可能没有发送成功：等待超时，页面没有出现新的回答内容");
  }
  GEO_LAST_ANSWER_ELEMENT = findLatestAnswerElement(task.platform, previousText, lastText);
  return lastText;
}

function clearOldMarks() {
  document.querySelectorAll(".geo-keyword-mark").forEach((node) => node.remove());
}

function markKeywords(keywords, root = GEO_LAST_ANSWER_ELEMENT || document.body) {
  clearOldMarks();
  const keywordList = splitKeywords(keywords);
  if (!keywordList.length) return false;
  GEO_LAST_MARK_KEYWORDS = keywordList;
  GEO_LAST_MARK_ROOT = root && document.body.contains(root) ? root : document.body;

  const walker = document.createTreeWalker(GEO_LAST_MARK_ROOT, NodeFilter.SHOW_TEXT);
  const ranges = [];
  const matchedKeywords = new Set();

  while (walker.nextNode()) {
    const node = walker.currentNode;
    for (const keyword of keywordList) {
      let index = node.nodeValue.indexOf(keyword);
      while (index >= 0) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + keyword.length);
        ranges.push(range);
        matchedKeywords.add(keyword);
        index = node.nodeValue.indexOf(keyword, index + keyword.length);
      }
    }
  }

  if (!ranges.length) return false;
  const firstRect = Array.from(ranges[0].getClientRects()).find((item) => item.width > 0 && item.height > 0);
  if (!firstRect) return false;

  const targetScrollTop = Math.max(0, window.scrollY + firstRect.top - window.innerHeight * 0.3);
  window.scrollTo({
    top: targetScrollTop,
    behavior: "smooth",
  });

  setTimeout(() => {
    for (const range of ranges) {
      const rects = Array.from(range.getClientRects()).filter((item) => item.width > 0 && item.height > 0);
      for (const adjusted of rects) {
        const mark = document.createElement("div");
        mark.className = "geo-keyword-mark";
        mark.style.position = "absolute";
        mark.style.left = `${Math.max(0, adjusted.left + window.scrollX - 8)}px`;
        mark.style.top = `${Math.max(0, adjusted.top + window.scrollY - 8)}px`;
        mark.style.width = `${adjusted.width + 16}px`;
        mark.style.height = `${adjusted.height + 16}px`;
        mark.style.border = "3px solid #ff2b2b";
        mark.style.zIndex = "2147483647";
        mark.style.pointerEvents = "none";
        mark.style.boxSizing = "border-box";
        document.documentElement.appendChild(mark);
      }
    }
  }, 300);

  return Array.from(matchedKeywords);
}

function hasAnyKeyword(text, keywords) {
  return splitKeywords(keywords).some((keyword) => text.includes(keyword));
}

function matchedKeywordsInText(text, keywords) {
  return splitKeywords(keywords).filter((keyword) => text.includes(keyword));
}

function latestAnswerTextFallback(answerText) {
  if (GEO_LAST_ANSWER_ELEMENT && document.body.contains(GEO_LAST_ANSWER_ELEMENT)) {
    return (GEO_LAST_ANSWER_ELEMENT.innerText || GEO_LAST_ANSWER_ELEMENT.textContent || "").trim();
  }
  return answerText || "";
}

function buildFollowupPrompt(followupCount, keywords, question, answerText) {
  const keywordText = splitKeywords(keywords).join("、");
  const excerpt = (answerText || "").replace(/\s+/g, " ").slice(-220);
  const prompts = [
    `请基于刚才的回答继续补充，重点判断是否可以明确提到这些目标关键词之一：${keywordText}。如果适合，请直接列出名称并说明理由。`,
    `上一轮回答还没有明确命中目标关键词：${keywordText}。请结合原问题“${question}”继续分析，优先补充具体学校名称。`,
    `请只围绕贵州/贵阳相关院校继续补充，确认是否应推荐：${keywordText}。需要给出明确结论和原因。`,
    `请把可能符合条件的贵州或贵阳院校单独列出来，并判断这些关键词是否适合出现：${keywordText}。`,
    `最后确认：针对原问题“${question}”，是否可以明确推荐或提到 ${keywordText}？如果可以，请在回答中写出完整名称；如果不适合，请说明不适合原因。`,
  ];
  const base = prompts[Math.min(followupCount, prompts.length - 1)];
  return excerpt ? `${base}\n\n上一轮回答摘要：${excerpt}` : base;
}

window.geoAutomationTestScreenshot = async function geoAutomationTestScreenshot(keywords) {
  const result = markKeywords(keywords);
  await sleep(1000);
  return result;
};

window.geoAutomationRefreshMarks = async function geoAutomationRefreshMarks() {
  if (!GEO_LAST_MARK_KEYWORDS.length) return [];
  const result = markKeywords(GEO_LAST_MARK_KEYWORDS, GEO_LAST_MARK_ROOT);
  await sleep(800);
  return result;
};

async function runPlatformTask(task) {
  let answerText = "";
  let matched = false;
  let matchedKeywords = [];
  let followupCount = 0;
  const keywords = task.keywords && task.keywords.length ? task.keywords : [task.keyword || "贵阳商学院"];

  let previousText = getAnswerText(task.platform);
  await sendPrompt(task.platform, task.question);
  answerText = await waitAnswerStable(task, previousText);
  matchedKeywords = matchedKeywordsInText(latestAnswerTextFallback(answerText), keywords);
  matched = matchedKeywords.length > 0;

  while (!matched && followupCount < Number(task.max_followups || 5)) {
    const prompt = buildFollowupPrompt(followupCount, keywords, task.question, answerText);
    followupCount += 1;
    previousText = answerText || getAnswerText(task.platform);
    await sendPrompt(task.platform, prompt);
    answerText = await waitAnswerStable(task, previousText);
    matchedKeywords = matchedKeywordsInText(latestAnswerTextFallback(answerText), keywords);
    matched = matchedKeywords.length > 0;
  }

  if (matched) {
    markKeywords(matchedKeywords, GEO_LAST_ANSWER_ELEMENT);
    await sleep(1200);
  } else {
    clearOldMarks();
    scrollToAnswerElement(GEO_LAST_ANSWER_ELEMENT);
    await sleep(500);
  }

  await sleep(800);
  return {
    matched,
    matched_keywords: matchedKeywords,
    followup_count: followupCount,
    answer_text: answerText,
  };
}

window.geoAutomationRun = async function geoAutomationRun(task) {
  try {
    return await runPlatformTask(task);
  } catch (error) {
    return {
      matched: false,
      followup_count: 0,
      answer_text: getAnswerText(task.platform),
      error: String(error && error.message ? error.message : error),
    };
  }
};

injectFloatingPanel();
