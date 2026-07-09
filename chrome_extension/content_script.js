const PLATFORM_RULES = {
  doubao: {
    input: ['textarea', '[contenteditable="true"]'],
    send: ['button[type="submit"]', 'button[aria-label*="发送"]', 'button:has(svg)'],
    answer: ['[data-testid*="message"]', '.markdown-body', '[class*="message"]', 'main'],
  },
  qianwen: {
    input: ['textarea', '[contenteditable="true"]', '.ant-input', '[placeholder*="输入"]'],
    send: ['button[type="submit"]', 'button[aria-label*="发送"]', 'button:has(svg)', '.ant-btn-primary', '[class*="send"]', '[class*="Submit"]'],
    answer: ['.markdown-body', '.ant-typography', '[class*="message-content"]', '[class*="content"]', '[class*="assistant"]', '[class*="response"]', 'main'],
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
    input: ['textarea', '[contenteditable="true"]', '[class*="input"]', '[class*="search"]', '[class*="chat-input"]'],
    send: ['button[type="submit"]', 'button[aria-label*="发送"]', 'button:has(svg)', '[class*="send"]', '[class*="submit"]', '[class*="Send"]', '[class*="icon-send"]', 'button'],
    answer: ['[class*="answer"]', '[class*="chat-message"]', '[class*="message"]', '[class*="content"]', '[class*="response"]', '[class*="result"]', 'main'],
  },
};

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
const DEFAULT_PLATFORMS = Object.entries(DEFAULT_PLATFORM_URLS).map(([key, url]) => ({
  key,
  name: PLATFORM_LABELS[key] || key,
  url,
}));

let GEO_LAST_ANSWER_ELEMENT = null;
let GEO_LAST_ANSWER_DEBUG = null;

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
    return { ok: false, error: text };
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
      label.inline { display: flex; align-items: center; gap: 8px; }
      input[type="checkbox"] { width: auto; }
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
      .platform-head {
        display: grid;
        grid-template-columns: 84px 1fr 32px;
        gap: 6px;
        margin-top: 10px;
        color: #5f6368;
        font-size: 12px;
      }
      .platform-row {
        display: grid;
        grid-template-columns: 84px 1fr 32px;
        gap: 6px;
        margin-top: 6px;
        align-items: center;
      }
      .platform-row input { font-family: system-ui, sans-serif; }
      button.icon {
        border: 0;
        border-radius: 6px;
        height: 30px;
        cursor: pointer;
        color: #5f6368;
        background: #f1f3f4;
        font: 16px system-ui, sans-serif;
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
      <label class="inline"><input data-key="aiJudgeEnabled" type="checkbox">启用内部 AI 判定（追问生成只需填写下面的 AI 配置）</label>
      <label>AI 接口地址（用于追问生成/内部判定）</label>
      <input data-key="aiJudgeApiUrl" placeholder="例如：https://api.example.com/v1/chat/completions">
      <label>AI 模型</label>
      <input data-key="aiJudgeModel" placeholder="例如：gpt-4o-mini / deepseek-chat">
      <label>API Key（只保存到本机 Chrome 和本地服务）</label>
      <input data-key="aiJudgeApiKey" type="password" placeholder="留空则沿用本地服务已保存的 Key">
      <label>平台列表（只会运行下面这些平台）</label>
      <div class="platform-head"><span>名称</span><span>URL</span><span></span></div>
      <div data-platforms></div>
      <div class="row">
        <button class="action secondary" data-action="addPlatform">增加平台</button>
      </div>
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
        <button class="action danger" data-action="resetAll">重置所有任务</button>
      </div>
      <div class="status">点击“检查服务”确认 Python 已启动。</div>
    </section>
  `;

  document.documentElement.appendChild(root);

  const panel = shadow.querySelector(".panel");
  const status = shadow.querySelector(".status");
  const platformsBox = shadow.querySelector("[data-platforms]");

  const platformKeyFromName = (name, index) => {
    const known = Object.entries(PLATFORM_LABELS).find(([, label]) => label === name);
    if (known) return known[0];
    return `custom_${index + 1}_${String(name || "platform").replace(/\W+/g, "_").slice(0, 24)}`;
  };

  const renderPlatforms = (platforms) => {
    platformsBox.innerHTML = "";
    const list = platforms && platforms.length ? platforms : DEFAULT_PLATFORMS;
    list.forEach((platform, index) => {
      const row = document.createElement("div");
      row.className = "platform-row";
      row.dataset.platformKey = platform.key || platformKeyFromName(platform.name, index);
      row.innerHTML = `
        <input data-platform-name value="${platform.name || platform.key || `平台${index + 1}`}">
        <input data-platform-url value="${platform.url || ""}">
        <button class="icon" data-action="removePlatform" title="删除平台">×</button>
      `;
      platformsBox.appendChild(row);
    });
  };

  renderPlatforms(DEFAULT_PLATFORMS);

  const setStatus = (value) => {
    status.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  };

  const readForm = () => {
    const serverUrl = shadow.querySelector('[data-key="serverUrl"]').value.replace(/\/$/, "");
    const concurrency = Number(shadow.querySelector('[data-key="concurrency"]').value || 3);
    const keyword = shadow.querySelector('[data-key="keyword"]').value.trim() || "贵阳商学院";
    const aiJudge = {
      enabled: shadow.querySelector('[data-key="aiJudgeEnabled"]').checked,
      api_url: shadow.querySelector('[data-key="aiJudgeApiUrl"]').value.trim(),
      model: shadow.querySelector('[data-key="aiJudgeModel"]').value.trim(),
      api_key: shadow.querySelector('[data-key="aiJudgeApiKey"]').value.trim(),
    };
    const platforms = [];
    const platformUrls = {};
    shadow.querySelectorAll(".platform-row").forEach((row, index) => {
      const name = row.querySelector("[data-platform-name]").value.trim() || `平台${index + 1}`;
      const url = row.querySelector("[data-platform-url]").value.trim();
      if (!url) return;
      const key = row.dataset.platformKey || platformKeyFromName(name, index);
      platforms.push({ key, name, url });
      platformUrls[key] = url;
    });
    return { serverUrl, concurrency, keyword, platformUrls, platforms, aiJudge };
  };

  const loadSettings = async () => {
    const settings = await runtimeMessage({ action: "GET_SETTINGS" });
    if (!settings || !settings.ok) return;
    shadow.querySelector('[data-key="serverUrl"]').value = settings.serverUrl || DEFAULT_SERVER_URL;
    shadow.querySelector('[data-key="concurrency"]').value = settings.concurrency || 3;
    shadow.querySelector('[data-key="keyword"]').value = settings.keyword || "贵阳商学院";
    const aiJudge = settings.aiJudge || {};
    shadow.querySelector('[data-key="aiJudgeEnabled"]').checked = Boolean(aiJudge.enabled);
    shadow.querySelector('[data-key="aiJudgeApiUrl"]').value = aiJudge.api_url || "";
    shadow.querySelector('[data-key="aiJudgeModel"]').value = aiJudge.model || "";
    const apiKeyInput = shadow.querySelector('[data-key="aiJudgeApiKey"]');
    apiKeyInput.value = aiJudge.api_key || "";
    apiKeyInput.placeholder = aiJudge.has_api_key
      ? `已保存 ${aiJudge.api_key_preview || ""}，不修改可留空`
      : "留空则沿用本地服务已保存的 Key";
    if (settings.platforms && settings.platforms.length) {
      renderPlatforms(settings.platforms);
    } else {
      const urls = { ...DEFAULT_PLATFORM_URLS, ...(settings.platformUrls || {}) };
      renderPlatforms(Object.entries(urls).map(([key, url]) => ({ key, name: PLATFORM_LABELS[key] || key, url })));
    }
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
      renderPlatforms(DEFAULT_PLATFORMS.map((item) => ({ ...item, url: "http://127.0.0.1:8765/mock-platform" })));
      const mockForm = readForm();
      setStatus(await runtimeMessage({ action: "SAVE_SETTINGS", ...mockForm }));
    }
    if (action === "realUrls") {
      renderPlatforms(DEFAULT_PLATFORMS);
      const realForm = readForm();
      setStatus(await runtimeMessage({ action: "SAVE_SETTINGS", ...realForm }));
    }
    if (action === "addPlatform") {
      const current = readForm().platforms;
      current.push({ key: `custom_${Date.now()}`, name: `平台${current.length + 1}`, url: "" });
      renderPlatforms(current);
      return;
    }
    if (action === "removePlatform") {
      const row = event.target.closest(".platform-row");
      if (row) row.remove();
      return;
    }
    if (action === "health") {
      const saved = await runtimeMessage({ action: "SAVE_SETTINGS", ...form });
      if (!saved || !saved.ok) {
        setStatus(saved || { ok: false, error: "保存配置失败" });
        return;
      }
      setStatus(await runtimeMessage({ action: "HEALTH", serverUrl: form.serverUrl }));
    }
    if (action === "start") {
      const saved = await runtimeMessage({ action: "SAVE_SETTINGS", ...form });
      if (!saved || !saved.ok) {
        setStatus(saved || { ok: false, error: "保存配置失败" });
        return;
      }
      setStatus(await runtimeMessage({ action: "START", serverUrl: form.serverUrl, concurrency: form.concurrency, platforms: form.platforms, aiJudge: form.aiJudge }));
    }
    if (action === "openLoginTabs") {
      const saved = await runtimeMessage({ action: "SAVE_SETTINGS", ...form });
      if (!saved || !saved.ok) {
        setStatus(saved || { ok: false, error: "保存配置失败" });
        return;
      }
      setStatus(await runtimeMessage({ action: "OPEN_LOGIN_TABS" }));
    }
    if (action === "testShot") {
      const saved = await runtimeMessage({ action: "SAVE_SETTINGS", ...form });
      if (!saved || !saved.ok) {
        setStatus(saved || { ok: false, error: "保存配置失败" });
        return;
      }
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
    if (action === "resetAll") {
      setStatus(await runtimeMessage({ action: "RESET_ALL_TASKS" }));
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

function nativeSetValue(input, text) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
  if (descriptor && descriptor.set) {
    descriptor.set.call(input, text);
  } else {
    input.value = text;
  }
}

function dispatchTextInputEvents(input, text) {
  try {
    input.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
  } catch (e) {}
  try {
    input.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: new DataTransfer() }));
  } catch (e) {}
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.dispatchEvent(new Event("compositionend", { bubbles: true }));
}

async function setInputValue(input, text) {
  input.focus();
  if (input.isContentEditable) {
    input.textContent = text;
    dispatchTextInputEvents(input, text);
  } else {
    nativeSetValue(input, text);
    dispatchTextInputEvents(input, text);
  }

  await sleep(120);
  const current = getInputText(input);
  if (!current || current !== String(text).trim()) {
    input.focus();
    if (input.isContentEditable) {
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, text);
    } else {
      input.select?.();
      nativeSetValue(input, text);
    }
    dispatchTextInputEvents(input, text);
  }

  // Some chat apps only enable send after a real editing delta.
  if (!input.isContentEditable) {
    nativeSetValue(input, `${text} `);
    dispatchTextInputEvents(input, " ");
    await sleep(60);
    nativeSetValue(input, text);
    dispatchTextInputEvents(input, null);
  }
}

function pressEnterToSend(input) {
  input.focus();
  // 如果是 contenteditable 或 textarea，先用 execCommand 确保输入内容注册
  try {
    if (input.isContentEditable) {
      document.execCommand("selectAll", false, null);
    } else if (typeof input.select === "function") {
      input.select();
    }
  } catch (e) {}
  // 触发完整的 Enter 事件链
  input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13, shiftKey: false }));
  input.dispatchEvent(new KeyboardEvent("keypress", { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 }));
  input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 }));
  // 部分平台监听 input 事件
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertLineBreak", data: "\n" }));
}

async function submitInputForm(input) {
  const form = input.closest && input.closest("form");
  if (!form) return false;
  try {
    if (typeof form.requestSubmit === "function") {
      form.requestSubmit();
    } else {
      form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    }
    await sleep(300);
    return true;
  } catch (e) {
    return false;
  }
}

function qianwenTextOf(node) {
  return `${node.innerText || ""} ${node.textContent || ""} ${node.getAttribute("aria-label") || ""} ${node.title || ""}`.replace(/\s+/g, " ").trim();
}

function qianwenHasActiveToolMode() {
  const bodyText = document.body.innerText || "";
  return /自动识别\s*[↔\-→]*\s*中文/.test(bodyText) || /翻译\s*[×x]/.test(bodyText);
}

async function clearQianwenActiveModes() {
  const modeWords = /(翻译|代码|编程|PPT|研究|任务助理|AI生视频|图片翻译|文档翻译)/;
  const buttons = Array.from(document.querySelectorAll("button, [role='button'], [aria-label], [title], span, div"))
    .filter((node) => {
      if (!node || node.closest("#geo-auto-root")) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      if (rect.width > 260 || rect.height > 90) return false;
      const text = qianwenTextOf(node);
      if (!modeWords.test(text)) return false;
      return /关闭|取消|移除|删除|×|x/i.test(text) || node.querySelector("svg, i");
    })
    .sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return ar.width * ar.height - br.width * br.height;
    });

  for (const button of buttons.slice(0, 3)) {
    try {
      button.click();
      await sleep(250);
    } catch (e) {}
  }
}

async function ensureQianwenChatMode(input, text) {
  await clearQianwenActiveModes();
  await sleep(200);
  if (!qianwenHasActiveToolMode()) return input;

  const newChatButtons = Array.from(document.querySelectorAll("button, [role='button'], a"))
    .filter((node) => {
      const rect = node.getBoundingClientRect();
      const label = qianwenTextOf(node);
      return rect.width > 0 && rect.height > 0 && /新建对话|新对话|开始对话/.test(label);
    });
  if (newChatButtons.length) {
    newChatButtons[0].click();
    await sleep(800);
  }

  await clearQianwenActiveModes();
  const rules = PLATFORM_RULES.qianwen;
  return firstVisible(rules.input) || input;
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
      const text = [
        button.innerText || "",
        button.textContent || "",
        button.getAttribute("aria-label") || "",
        button.title || "",
        ...Array.from(button.querySelectorAll("[aria-label], [title]")).map((node) => `${node.getAttribute("aria-label") || ""} ${node.title || ""}`),
      ].join(" ");
      const classList = String(button.className || "");

      if (/Tool|Deep Thinking|更多|快速|PPT|图片|视频|录音|编程|代码|Code|code|模式|\+|清空|重置/.test(text.trim())) return false;

      const overlapsInputVertically = rect.bottom >= inputRect.top - 28 && rect.top <= inputRect.bottom + 28;
      const rightSideOfInput = rect.left >= inputRect.left + inputRect.width * 0.65;
      const nearInputRight = Math.abs(rect.right - inputRect.right) < 180 || Math.abs(rect.left - inputRect.right) < 180;

      const isSubmit = /发送|Send|send|提交/.test(text);
      const isPrimary = /primary|ant-btn-primary/.test(classList);
      const typeSubmit = button.getAttribute("type") === "submit";
      const looksLikeRightSendIcon = rightSideOfInput && nearInputRight && overlapsInputVertically && rect.width <= 72 && rect.height <= 72;

      return overlapsInputVertically && nearInputRight && (isSubmit || isPrimary || typeSubmit || looksLikeRightSendIcon);
    })
    .map((button) => {
      const rect = button.getBoundingClientRect();
      const text = `${button.innerText || ""} ${button.textContent || ""} ${button.getAttribute("aria-label") || ""} ${button.title || ""}`;
      const classList = String(button.className || "");
      let score = 0;

      if (/发送|Send|send|提交/.test(text)) score += 200;
      if (/primary|ant-btn-primary/.test(classList)) score += 150;
      if (button.getAttribute("type") === "submit") score += 140;
      if (rect.left > inputRect.left + inputRect.width * 0.75) score += 140;
      if (rect.width <= 72 && rect.height <= 72) score += 70;
      if (Math.abs((rect.top + rect.bottom) / 2 - inputCenterY) < 48) score += 60;

      score -= Math.abs(rect.right - inputRect.right) / 10;
      score -= Math.abs(rect.top - inputRect.top) / 20;
      score -= Math.abs((rect.left + rect.right) / 2 - inputCenterX) / 30;

      return { button, score };
    })
    .sort((a, b) => b.score - a.score);

  if (candidates.length) return candidates[0].button;

  const fallbackButtons = visibleElements(['.ant-btn-primary', '[class*="send"]', '[class*="Send"]', '[class*="submit"]', '[class*="Submit"]']);
  for (const btn of fallbackButtons) {
    const rect = btn.getBoundingClientRect();
    const text = `${btn.innerText || ""} ${btn.textContent || ""} ${btn.getAttribute("aria-label") || ""} ${btn.title || ""}`;
    if (/Tool|Deep Thinking|更多|快速|PPT|图片|视频|录音|编程|代码|Code|code|模式|\+|清空|重置/.test(text.trim())) continue;
    if (!btn.disabled && rect.width > 0 && rect.left >= inputRect.left + inputRect.width * 0.55) return btn;
  }

  return null;
}

function findWenxinSendButton(input) {
  const inputRect = input.getBoundingClientRect();
  // 在输入框周围找按钮：文心一言的发送按钮通常在右下角或输入框右侧
  const candidates = Array.from(document.querySelectorAll('button, [role="button"], [class*="send"], [class*="Send"], [class*="submit"], [class*="Submit"]'))
    .filter((btn) => {
      if (btn.disabled || btn.getAttribute("aria-disabled") === "true") return false;
      const rect = btn.getBoundingClientRect();
      if (rect.width <= 8 || rect.height <= 8) return false;
      // 靠近输入框：在输入框下方 0-200px 或右侧 0-200px
      const nearInputBottom = rect.top >= inputRect.bottom - 10 && rect.top <= inputRect.bottom + 200;
      const nearInputRight = rect.left >= inputRect.left && rect.left <= inputRect.right + 200;
      const text = (btn.innerText || btn.textContent || btn.getAttribute("aria-label") || "").trim();
      const classList = String(btn.className || "");
      if (/Tool|Deep Thinking|更多|快速|PPT|图片|视频|录音|编程|代码|Code|code|快捷键|\+|清空|重置/.test(text)) return false;
      if (text.includes("发送") || text.includes("Send") || text.includes("send") || classList.includes("send") || classList.includes("Send")) return true;
      // 如果按钮有 SVG 图标且在输入框附近，也是候选
      if (btn.querySelector("svg") && (nearInputBottom || nearInputRight)) return true;
      return false;
    })
    .map((btn) => {
      const rect = btn.getBoundingClientRect();
      let score = 0;
      const text = (btn.innerText || btn.textContent || btn.getAttribute("aria-label") || "").trim();
      if (text.includes("发送")) score += 200;
      if (text.includes("Send") || text.includes("send")) score += 180;
      if (btn.querySelector("svg")) score += 100;
      if (String(btn.className || "").includes("send") || String(btn.className || "").includes("Send")) score += 150;
      // 离输入框越近分越高
      const distFromBottom = Math.abs(rect.top - inputRect.bottom);
      const distFromRight = Math.abs(rect.left - inputRect.right);
      score -= Math.min(distFromBottom, distFromRight) / 5;
      return { button: btn, score };
    })
    .sort((a, b) => b.score - a.score);
  
  return candidates.length ? candidates[0].button : null;
}

async function clickSendButton(input, platform) {
  // 千问：优先用 Enter 发送（千问的 textarea 支持 Enter 发送）
  if (platform === "qianwen") {
    pressEnterToSend(input);
    await sleep(400);
    pressEnterToSend(input);
    await sleep(500);
    const textAfter = getInputText(input);
    if (!textAfter || textAfter.length === 0) return true;
  }

  // 文心一言：使用专门的按钮查找
  if (platform === "wenxin") {
    const wenxinBtn = findWenxinSendButton(input);
    if (wenxinBtn) {
      wenxinBtn.scrollIntoView({ block: "center" });
      await sleep(200);
      wenxinBtn.click();
      await sleep(400);
      const textAfter = getInputText(input);
      if (!textAfter || textAfter.length === 0) return true;
      return true;
    }
    // 找不到按钮时，尝试多次点击常见位置
    // 部分文心版本用 contenteditable 输入框，尝试用 submitInputForm
    if (await submitInputForm(input)) {
      await sleep(500);
      return true;
    }
    // 最后尝试 Enter（部分 textarea 版本支持）
    pressEnterToSend(input);
    await sleep(300);
    pressEnterToSend(input);
    await sleep(500);
    return true;
  }

  const sendButton = findSendButton(input, platform);
  if (sendButton) {
    sendButton.scrollIntoView({ block: "center", inline: "center" });
    await sleep(200);
    sendButton.click();
    await sleep(250);
    const textAfter = getInputText(input);
    if (!textAfter || textAfter.length === 0) return true;
    return true;
  }

  throw new Error("没有找到可靠的发送按钮，已停止使用 Enter 兜底，避免误触代码/工具模式。请检查页面是否已登录、输入框右侧发送按钮是否可用。");
}

async function sendPrompt(platform, text) {
  const rules = PLATFORM_RULES[platform] || PLATFORM_RULES.doubao;
  if (platform === "qianwen") {
    await clearQianwenActiveModes();
  }
  let input = firstVisible(rules.input);
  if (!input) throw new Error("找不到输入框，请先确认平台页面已登录并处于聊天页");

  if (platform === "qianwen") {
    input = await ensureQianwenChatMode(input, text);
  }
  await setInputValue(input, text);
  await sleep(500);

  if (platform === "qianwen") {
    // 千问：只清理模式按钮，不清理关闭按钮
    // 不再调用 clearQianwenActiveModes（可能误点关闭按钮）
    // await clearQianwenActiveModes();
    // await sleep(200);
    if (qianwenHasActiveToolMode()) {
      input = await ensureQianwenChatMode(input, text);
      await setInputValue(input, text);
      await sleep(500);
    }
  }

  await clickSendButton(input, platform);
  await sleep(800);
  return true;
}

function getAnswerCandidates(platform) {
  const rules = PLATFORM_RULES[platform] || PLATFORM_RULES.doubao;
  const seen = new Set();
  const candidates = [];

  // 千问特殊处理：查找包含回答内容的容器
  if (platform === "qianwen") {
    const allTextBlocks = Array.from(document.querySelectorAll('[class*="message"], [class*="content"], [class*="answer"], [class*="response"], .ant-typography, .markdown-body, p, div'))
      .filter((node) => {
        if (seen.has(node)) return false;
        seen.add(node);
        if (node.closest("#geo-auto-root")) return false;
        if (isIgnoredLocateNode(node)) return false;
        const text = (node.innerText || node.textContent || "").trim();
        const rect = node.getBoundingClientRect();
        if (text.length <= 10 || rect.width <= 0 || rect.height <= 0) return false;
        // 排除输入框和用户消息区域
        const className = String(node.className || "");
        if (/send-msg|send-bubble|user-message|human-message|question|query|user/i.test(className) && !/answer|assistant|agent|markdown|response/i.test(className)) return false;
        // 排除侧边栏、工具栏等
        if (window.innerWidth > 900 && rect.right < window.innerWidth * 0.18) return false;
        return true;
      });
    candidates.push(...allTextBlocks);
  } else {
    for (const selector of rules.answer) {
      const nodes = Array.from(document.querySelectorAll(selector)).filter((node) => {
        if (seen.has(node)) return false;
        seen.add(node);
        if (node.closest("#geo-auto-root")) return false;
        if (isIgnoredLocateNode(node)) return false;
        if (node.querySelector("textarea, input, [contenteditable='true']")) return false;
        const rect = node.getBoundingClientRect();
        const text = (node.innerText || node.textContent || "").trim();
        const className = String(node.className || "");
        if (/send-msg|send-bubble|user-message|human-message|question|query|user/i.test(className) && !/answer|assistant|agent|markdown|response/i.test(className)) return false;
        if (text.length <= 10 || rect.width <= 0 || rect.height <= 0) return false;
        if (window.innerWidth > 900 && rect.right < window.innerWidth * 0.18) return false;
        if (/^(Search|Yuanbao|All Collections|Group|Chat|Today|Yesterday|我的空间|最近对话)$/i.test(text)) return false;
        return true;
      });
      candidates.push(...nodes);
    }
  }

  return candidates
    .map((node, index) => {
      const rect = node.getBoundingClientRect();
      const text = (node.innerText || node.textContent || "").trim();
      const area = rect.width * rect.height;
      const className = String(node.className || "");
      let score = index;
      if (/markdown|answer|response|agent|assistant|ds-markdown/i.test(className)) score += 260;
      if (/message/i.test(className)) score += 80;
      if (/send-msg|user-message|human-message|question|query|user/i.test(className)) score -= 350;
      if (text.length > 40 && text.length < 8000) score += 80;
      if (area < window.innerWidth * window.innerHeight * 0.9) score += 60;
      score += Math.max(0, rect.top + window.scrollY) / 1000;
      return { node, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((item) => item.node);
}

function deepestUsefulAnswerNode(node) {
  if (!node) return node;
  const selectors = [
    ".markdown-body",
    ".ant-typography",
    "[class*='markdown']",
    "[class*='message-content']",
    "[class*='assistant']",
    "[class*='answer']",
    "[class*='response']",
    "table",
    "article",
    "section",
  ];
  let current = node;
  for (let depth = 0; depth < 5; depth++) {
    const text = textFromNode(current);
    const children = selectors
      .flatMap((selector) => Array.from(current.querySelectorAll(selector)))
      .filter((child) => {
        if (!child || child === current || isIgnoredLocateNode(child)) return false;
        const rect = child.getBoundingClientRect();
        const childText = textFromNode(child);
        if (rect.width <= 0 || rect.height <= 0 || childText.length < 20) return false;
        if (child.querySelector("textarea, input, [contenteditable='true']")) return false;
        return text.includes(childText);
      })
      .map((child) => {
        const rect = child.getBoundingClientRect();
        const childText = textFromNode(child);
        let score = 0;
        const className = String(child.className || "");
        if (/markdown|answer|response|assistant|message-content|ant-typography/i.test(className)) score += 300;
        if (childText.length >= 80) score += 120;
        if (childText.length < text.length * 0.9) score += 90;
        score -= Math.max(0, rect.width * rect.height - window.innerWidth * window.innerHeight * 0.65) / 5000;
        return { child, score };
      })
      .sort((a, b) => b.score - a.score);
    if (!children.length || children[0].score < 120) break;
    current = children[0].child;
  }
  return current;
}

function answerNodeDebug(node, index = 0) {
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  const text = textFromNode(node);
  return {
    index,
    tag: node.tagName,
    class_name: String(node.className || "").slice(0, 180),
    role: node.getAttribute("role") || "",
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    text_length: text.length,
    text_preview: text.replace(/\s+/g, " ").slice(0, 260),
  };
}

function collectAnswerDebug(platform, previousText = "", selected = null, stage = "") {
  const candidates = getAnswerCandidates(platform).slice(0, 12);
  return {
    platform,
    stage,
    candidate_count: candidates.length,
    previous_length: String(previousText || "").length,
    selected: answerNodeDebug(selected, -1),
    candidates: candidates.map(answerNodeDebug),
  };
}

function textFromNode(node) {
  return (node && (node.innerText || node.textContent) || "").trim();
}

function getAnswerText(platform) {
  return getAnswerCandidates(platform)
    .slice(0, 8)
    .map(textFromNode)
    .filter(Boolean)
    .join("\n")
    .trim();
}

function isTransientAnswerText(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return true;
  const lower = normalized.toLowerCase();
  const transientPatterns = [
    "searching for information",
    "searching for info",
    "thinking",
    "deep thinking",
    "generating",
    "loading",
    "正在搜索",
    "正在检索",
    "正在思考",
    "正在生成",
    "生成中",
    "搜索中",
    "思考中",
    "请稍候",
  ];
  const withoutNoise = lower
    .replace(/ai-generated content, for reference only/gi, "")
    .replace(/download for desktop/gi, "")
    .replace(/sources?/gi, "")
    .replace(/[.\s，。！？、:：-]+/g, "");
  if (withoutNoise.length < 12 && transientPatterns.some((pattern) => lower.includes(pattern))) return true;
  return transientPatterns.some((pattern) => lower === pattern || lower.endsWith(pattern));
}

function pageIsAnswerGenerating(platform) {
  const statusNodes = Array.from(document.querySelectorAll("div, span, p, [class*='loading'], [class*='search'], [class*='think']"))
    .filter((node) => {
      if (node.closest("#geo-auto-root")) return false;
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= window.innerHeight) return false;
      const text = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 120) return false;
      return /^(Searching for information|Searching for info|正在搜索|正在检索|正在思考|正在生成|生成中|搜索中|思考中)/i.test(text);
    });
  if (statusNodes.length) {
    return true;
  }

  const activeControls = Array.from(document.querySelectorAll("button, [role='button'], [aria-label]"))
    .filter((node) => {
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      if (node.closest("#geo-auto-root")) return false;
      const text = `${node.innerText || node.textContent || ""} ${node.getAttribute("aria-label") || ""}`.trim();
      return /停止|中止|取消|stop|Stop|generating|loading/i.test(text);
    });
  if (activeControls.length) return true;

  return false;
}

function latestAnswerElementText(fallbackText = "") {
  if (GEO_LAST_ANSWER_ELEMENT && document.body.contains(GEO_LAST_ANSWER_ELEMENT)) {
    const text = textFromNode(GEO_LAST_ANSWER_ELEMENT);
    const normalizedText = normalizeKeywordText(text);
    const normalizedFallback = normalizeKeywordText(fallbackText);
    if (
      normalizedText.length >= 20 &&
      (!normalizedFallback || normalizedText.length >= normalizedFallback.length * 0.35)
    ) {
      return text;
    }
  }
  return fallbackText || "";
}

function findLatestAnswerElement(platform, previousText = "", answerText = "") {
  const candidates = getAnswerCandidates(platform);
  if (!candidates.length) return null;

  const normalizedPrevious = normalizeKeywordText(previousText || "");
  const normalizedAnswer = normalizeKeywordText(answerText || "");
  const candidateTexts = candidates.map((node) => textFromNode(node));
  const normalizedTexts = candidateTexts.map(normalizeKeywordText);

  const scored = candidates.map((node, index) => {
    const text = candidateTexts[index] || "";
    const normalized = normalizedTexts[index] || "";
    const rect = node.getBoundingClientRect();
    const className = String(node.className || "");
    let score = index;

    if (normalized && !normalizedPrevious.includes(normalized)) score += 500;
    if (normalizedAnswer && normalizedAnswer.includes(normalized)) score += 160;
    if (/markdown|answer|response|agent|assistant|ds-markdown|speech-card__text|cosd-markdown-content/i.test(className)) score += 260;
    if (/send-msg|send-bubble|user-message|human-message|question|query|user/i.test(className) && !/answer|assistant|agent|markdown|response/i.test(className)) score -= 500;

    if (normalized.length >= 80) score += Math.min(260, normalized.length / 8);
    if (normalized.length < 40) score -= 260;

    const isContainedByLonger = normalizedTexts.some((other, otherIndex) => {
      return otherIndex !== index && other.length > normalized.length + 80 && other.includes(normalized);
    });
    if (isContainedByLonger) score -= 420;

    score += Math.max(0, rect.top + window.scrollY) / 2000;
    return { node, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return deepestUsefulAnswerNode(scored[0].node);
}

async function waitAnswerStable(task, previousText = "") {
  const pollMs = Math.max(300, Number(task.answer_poll_interval || 0.8) * 1000);
  const stableMs = Number(task.answer_stable_seconds || 3) * 1000;
  const keywordStableMs = Number(task.answer_keyword_stable_seconds || 1.5) * 1000;
  const timeoutMs = Number(task.answer_timeout_seconds || 90) * 1000;
  const started = Date.now();
  const previousNormalized = normalizeKeywordText(previousText || "");
  const keywords = task.keywords && task.keywords.length ? task.keywords : [task.keyword || ""];
  let lastText = getAnswerText(task.platform);
  let lastNormalized = normalizeKeywordText(lastText || "");
  let lastChangedAt = Date.now();
  let sawNewAnswer = Boolean(lastNormalized && lastNormalized !== previousNormalized && !isTransientAnswerText(lastText));
  let keywordSeen = containsAnyTargetKeyword(lastText, keywords);

  while (Date.now() - started < timeoutMs) {
    const text = getAnswerText(task.platform);
    const normalized = normalizeKeywordText(text || "");
    const transient = isTransientAnswerText(text);
    const generating = pageIsAnswerGenerating(task.platform);
    if (normalized !== lastNormalized) {
      lastText = text;
      lastNormalized = normalized;
      lastChangedAt = Date.now();
      keywordSeen = containsAnyTargetKeyword(text, keywords);
      if (normalized && normalized !== previousNormalized && !transient) sawNewAnswer = true;
    }
    const requiredStableMs = keywordSeen ? keywordStableMs : stableMs;
    if (sawNewAnswer && lastNormalized && !transient && !generating && Date.now() - lastChangedAt >= requiredStableMs) {
      GEO_LAST_ANSWER_ELEMENT = findLatestAnswerElement(task.platform, previousText, lastText);
      GEO_LAST_ANSWER_DEBUG = collectAnswerDebug(task.platform, previousText, GEO_LAST_ANSWER_ELEMENT, keywordSeen ? "keyword_fast_stable" : "stable");
      return latestAnswerElementText(lastText);
    }
    await sleep(pollMs);
  }

  if (!sawNewAnswer) {
    throw new Error("问题可能没有发送成功：等待超时，页面没有出现新的回答内容");
  }
  GEO_LAST_ANSWER_ELEMENT = findLatestAnswerElement(task.platform, previousText, lastText);
  GEO_LAST_ANSWER_DEBUG = collectAnswerDebug(task.platform, previousText, GEO_LAST_ANSWER_ELEMENT, "timeout_return_last");
  return latestAnswerElementText(lastText);
}

function clearKeywordMarks() {
  document.querySelectorAll(".geo-keyword-mark").forEach((node) => {
    if (node.dataset && node.dataset.geoInlineMark === "1") {
      const parent = node.parentNode;
      while (node.firstChild) parent.insertBefore(node.firstChild, node);
      node.remove();
      parent.normalize();
    } else {
      node.remove();
    }
  });
}

function clearMatchedBadges() {
  document.querySelectorAll(".geo-matched-badge").forEach((el) => el.remove());
}

function uniqueList(items) {
  const result = [];
  const seen = new Set();
  for (const item of items || []) {
    const value = String(item || "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function uniqueNodes(items) {
  const result = [];
  const seen = new Set();
  for (const item of items || []) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function normalizeKeywordText(text) {
  return String(text || "")
    .replace(/\s+/g, "")
    .replace(/[，。！？、,.!?]/g, "");
}

function containsAnyTargetKeyword(text, keywords) {
  const normalized = normalizeKeywordText(text || "");
  if (!normalized) return false;
  const aliases = typeof keywordAliasesForPrompt === "function"
    ? keywordAliasesForPrompt(keywords)
    : splitKeywords(keywords);
  return aliases.some((keyword) => {
    const term = normalizeKeywordText(keyword);
    return term && normalized.includes(term);
  });
}

function getKeywordContext(text, start, length, size = 15) {
  const begin = Math.max(0, start - size);
  const end = Math.min(text.length, start + length + size);
  return text.slice(begin, end);
}

function getAnswerKeywordHit(answerText, keywords, judgeResult = null) {
  const text = String(answerText || "");
  for (const keyword of splitKeywords(keywords)) {
    const index = text.indexOf(keyword);
    if (index >= 0) {
      const prefixStart = Math.max(0, index - 15);
      return {
        keyword,
        index,
        prefix15: text.slice(prefixStart, index),
        context: getKeywordContext(text, index, keyword.length, 15),
      };
    }
  }

  const judgedTerms = [
    judgeResult && judgeResult.matched_text,
    judgeResult && judgeResult.keyword,
  ].filter(Boolean);
  for (const term of judgedTerms) {
    const index = text.indexOf(term);
    if (index >= 0) {
      const prefixStart = Math.max(0, index - 15);
      return {
        keyword: term,
        reportedKeyword: judgeResult.keyword || term,
        index,
        prefix15: text.slice(prefixStart, index),
        context: getKeywordContext(text, index, term.length, 15),
        evidence: judgeResult.evidence || "",
      };
    }
  }

  if (judgeResult && judgeResult.evidence) {
    const evidence = String(judgeResult.evidence || "").trim();
    const compactEvidence = evidence.replace(/\s+/g, " ").slice(0, 80);
    const index = text.indexOf(evidence) >= 0 ? text.indexOf(evidence) : text.indexOf(compactEvidence);
    if (index >= 0) {
      return {
        keyword: compactEvidence,
        reportedKeyword: judgeResult.keyword || compactEvidence,
        index,
        prefix15: text.slice(Math.max(0, index - 15), index),
        context: evidence.slice(0, 180),
        evidence,
      };
    }
  }
  return null;
}

function isIgnoredLocateNode(node) {
  return Boolean(
    node.closest(
      [
        "#geo-auto-root",
        ".geo-keyword-mark",
        "script",
        "style",
        "noscript",
        "textarea",
        "input",
        "button",
        "[contenteditable='true']",
        "nav",
        "aside",
        "[role='navigation']",
        "[class*='sidebar']",
        "[class*='Sidebar']",
        "[class*='history']",
        "[class*='History']",
        "[class*='composer']",
        "[class*='input']",
        "[class*='toolbar']",
        "[class*='footer']",
        "[class*='suggest']",
        "[class*='recommend']",
        "[class*='thinking']",
        "[class*='Thinking']",
        "[class*='reference']",
        "[class*='Reference']",
        "[class*='source']",
        "[class*='Source']",
        "[class*='citation']",
        "[class*='Citation']",
        "[class*='answer-ask']",
      ].join(",")
    )
  );
}

function findRootByAnswerContext(answerHit) {
  if (!answerHit) return null;
  const needles = [
    `${answerHit.prefix15 || ""}${answerHit.keyword || ""}`,
    answerHit.evidence || "",
    answerHit.context || "",
  ].map(normalizeKeywordText).filter((item) => item && item.length >= 4);
  if (!needles.length) return null;

  const candidates = Array.from(document.querySelectorAll("main, article, section, div, table, p, li"))
      .filter((node) => !isIgnoredLocateNode(node))
    .map((node) => {
      const text = normalizeKeywordText(node.innerText || node.textContent || "");
      if (!needles.some((needle) => text.includes(needle) || needle.includes(text))) return null;
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      if (window.innerWidth > 900 && rect.right < window.innerWidth * 0.18) return null;
      if (rect.width < 200 || rect.height < 50) return null;
      const tagText = (node.innerText || node.textContent || "").trim();
      if (tagText.length < 100) return null;
      let score = 0;
      const normalizedTagText = normalizeKeywordText(tagText);
      for (const needle of needles) {
        if (normalizedTagText.includes(needle)) score += 500;
        if (needle.includes(normalizedTagText)) score += 180;
      }
      if (/^(TABLE|TR|TD|P|LI|ARTICLE|SECTION)$/i.test(node.tagName)) score += 220;
      if (tagText.length <= 1200) score += 200;
      if (tagText.length <= 500) score += 120;
      score -= Math.max(0, tagText.length - 1800) / 4;
      score -= Math.max(0, rect.width * rect.height - window.innerWidth * window.innerHeight * 0.7) / 2500;
      return { node, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  return candidates.length ? candidates[0].node : null;
}

function findKeywordRangesInDOM(root, keyword) {
  if (!root || !keyword) return [];

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const keywordNormalized = normalizeKeywordText(keyword);
  const results = [];

  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.parentElement || isIgnoredLocateNode(node.parentElement)) continue;
    const raw = node.nodeValue || "";
    const normalized = normalizeKeywordText(raw);

    let index = normalized.indexOf(keywordNormalized);
    while (index >= 0) {
      const charStart = findCharIndexByNormalizedIndex(raw, index);
      const charEnd = findCharIndexByNormalizedIndex(raw, index + keywordNormalized.length);

      const range = document.createRange();
      range.setStart(node, Math.max(0, Math.min(charStart, raw.length)));
      range.setEnd(node, Math.max(0, Math.min(charEnd, raw.length)));

      results.push({
        range,
        node,
        keyword,
        context: getKeywordContext(raw, charStart, keyword.length),
      });

      index = normalized.indexOf(keywordNormalized, index + keywordNormalized.length);
    }
  }

  return results;
}

function findCharIndexByNormalizedIndex(raw, normalizedIndex) {
  let count = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (/\s|[，。！？、,.!?]/.test(ch)) continue;
    if (count === normalizedIndex) return i;
    count++;
  }
  return raw.length;
}

function scrollableContainers(root = document.body) {
  const base = root && document.body.contains(root) ? root : document.body;
  const nodes = [document.scrollingElement || document.documentElement, ...Array.from(base.querySelectorAll("*"))];
  return uniqueNodes(nodes.filter((node) => {
    if (!node || node.nodeType !== 1) return false;
    if (isIgnoredLocateNode(node)) return false;
    const style = window.getComputedStyle(node);
    const canScrollY = /(auto|scroll|overlay)/.test(`${style.overflowY} ${style.overflow}`);
    if (!canScrollY && node !== document.scrollingElement && node !== document.documentElement) return false;
    return node.scrollHeight > node.clientHeight + 80;
  }));
}

function nearestScrollableContainer(element) {
  let node = element && element.nodeType === Node.TEXT_NODE ? element.parentElement : element;
  while (node && node !== document.body && node !== document.documentElement) {
    const style = window.getComputedStyle(node);
    if (/(auto|scroll|overlay)/.test(`${style.overflowY} ${style.overflow}`) && node.scrollHeight > node.clientHeight + 40) {
      return node;
    }
    node = node.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}

function scrollContainerToCenter(container, rect) {
  if (!container || !rect) return;
  if (container === document.scrollingElement || container === document.documentElement || container === document.body) {
    const targetTop = window.scrollY + rect.top - window.innerHeight / 2 + rect.height / 2;
    window.scrollTo(0, Math.max(0, targetTop));
    return;
  }
  const containerRect = container.getBoundingClientRect();
  const delta = rect.top - containerRect.top - container.clientHeight / 2 + rect.height / 2;
  container.scrollTop = Math.max(0, container.scrollTop + delta);
}

function scrollContainerToCenterSmooth(container, rect) {
  if (!container || !rect) return;
  if (container === document.scrollingElement || container === document.documentElement || container === document.body) {
    const targetTop = window.scrollY + rect.top - window.innerHeight * 0.45 + rect.height / 2;
    window.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
    return;
  }
  const containerRect = container.getBoundingClientRect();
  const delta = rect.top - containerRect.top - container.clientHeight * 0.45 + rect.height / 2;
  container.scrollTo({ top: Math.max(0, container.scrollTop + delta), behavior: "smooth" });
}

function targetRectForKeywordMatch(match) {
  if (!match || !match.range) return null;
  const start = match.range.startContainer;
  const element = start && start.nodeType === Node.TEXT_NODE ? start.parentElement : start;
  if (!element) return bestRangeRect(match.range);
  const target = element.closest("td, th, tr, li, p") || element;
  const rect = target.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0 && rect.height <= window.innerHeight * 0.55) return rect;
  return bestRangeRect(match.range);
}

function scrollSnapshot(container = null) {
  const target = container || document.scrollingElement || document.documentElement;
  return {
    windowY: window.scrollY,
    targetTop: target ? target.scrollTop : 0,
  };
}


async function waitForScrollStable(timeoutMs = 3000, container = null) {
  const started = Date.now();
  let last = scrollSnapshot(container);
  let stableCount = 0;

  while (Date.now() - started < timeoutMs) {
    await sleep(100);
    const current = scrollSnapshot(container);
    if (Math.abs(current.windowY - last.windowY) < 5 && Math.abs(current.targetTop - last.targetTop) < 5) {
      stableCount++;
      if (stableCount >= 5) return true;
    } else {
      stableCount = 0;
    }
    last = current;
  }

  return false;
}


function wrapKeywordRange(range) {
  const mark = document.createElement("span");
  mark.className = "geo-keyword-mark";
  mark.dataset.geoInlineMark = "1";
  Object.assign(mark.style, {
    outline: "4px solid #ff0000",
    outlineOffset: "3px",
    background: "rgba(255, 0, 0, 0.12)",
    borderRadius: "2px",
    boxDecorationBreak: "clone",
    webkitBoxDecorationBreak: "clone",
    position: "relative",
    zIndex: "2147483646",
  });
  try {
    range.surroundContents(mark);
    return true;
  } catch (error) {
    // If surroundContents fails (e.g. range spans multiple elements), try extracting
    try {
      const fragment = range.extractContents();
      mark.appendChild(fragment);
      range.insertNode(mark);
      return true;
    } catch (e2) {
      return false;
    }
  }
}

function markerTargetForRange(range) {
  const start = range.startContainer;
  const base = start.nodeType === Node.TEXT_NODE ? start.parentElement : start;
  if (!base) return null;
  const selector = "li, p, tr, td, th, blockquote, [class*='paragraph'], [class*='markdown'], [class*='content'], div";
  let node = base.closest(selector);
  const answerRoot = GEO_LAST_ANSWER_ELEMENT && document.body.contains(GEO_LAST_ANSWER_ELEMENT) ? GEO_LAST_ANSWER_ELEMENT : document.body;
  while (node && node !== answerRoot && node.parentElement) {
    const rect = node.getBoundingClientRect();
    const text = (node.innerText || node.textContent || "").trim();
    if (rect.width >= 80 && rect.height >= 18 && text.length <= 260) break;
    const parent = node.parentElement.closest(selector);
    if (!parent || parent === node) break;
    const parentText = (parent.innerText || parent.textContent || "").trim();
    if (parentText.length > 320) break;
    node = parent;
  }
  return node || base;
}

function drawElementBox(element) {
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) return [];

  const margin = 10;
  const left = Math.max(8, rect.left - margin);
  const top = Math.max(8, rect.top - margin);
  const right = Math.min(window.innerWidth - 8, rect.right + margin);
  const bottom = Math.min(window.innerHeight - 8, rect.bottom + margin);
  const width = Math.max(24, right - left);
  const height = Math.max(20, bottom - top);

  const box = document.createElement("div");
  box.className = "geo-keyword-mark";
  box.dataset.geoFixedBox = "1";
  Object.assign(box.style, {
    position: "fixed",
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    height: `${height}px`,
    border: "4px solid #ff0000",
    background: "rgba(255, 0, 0, 0.05)",
    boxShadow: "0 0 0 2px rgba(255,0,0,0.25), 0 2px 8px rgba(255,0,0,0.22)",
    pointerEvents: "none",
    zIndex: "2147483646",
    boxSizing: "border-box",
  });
  document.documentElement.appendChild(box);
  return [box.getBoundingClientRect()];
}


function drawBoxFromRect(rect, padding = 8) {
  if (!rect || rect.width <= 0 || rect.height <= 0) return [];
  if (rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0 || rect.left >= window.innerWidth) return [];

  const left = Math.max(8, rect.left - padding);
  const top = Math.max(8, rect.top - padding);
  const right = Math.min(window.innerWidth - 8, rect.right + padding);
  const bottom = Math.min(window.innerHeight - 8, rect.bottom + padding);
  const width = Math.max(24, right - left);
  const height = Math.max(20, bottom - top);

  const overlay = document.createElement("div");
  overlay.className = "geo-keyword-mark";
  overlay.dataset.geoFixedBox = "1";
  Object.assign(overlay.style, {
    position: "fixed",
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    height: `${height}px`,
    border: "4px solid #ff0000",
    background: "rgba(255, 0, 0, 0.05)",
    boxShadow: "0 0 0 2px rgba(255,0,0,0.25), 0 2px 8px rgba(255,0,0,0.22)",
    pointerEvents: "none",
    zIndex: "2147483646",
    boxSizing: "border-box",
  });
  document.documentElement.appendChild(overlay);
  return [overlay.getBoundingClientRect()];
}

function bestRangeRect(range) {
  const rects = Array.from(range.getClientRects())
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .sort((a, b) => {
      const aVisible = a.bottom > 0 && a.top < window.innerHeight && a.right > 0 && a.left < window.innerWidth;
      const bVisible = b.bottom > 0 && b.top < window.innerHeight && b.right > 0 && b.left < window.innerWidth;
      if (aVisible !== bVisible) return aVisible ? -1 : 1;
      return Math.abs((a.top + a.bottom) / 2 - window.innerHeight / 2) - Math.abs((b.top + b.bottom) / 2 - window.innerHeight / 2);
    });
  return rects[0] || range.getBoundingClientRect();
}

function drawDOMKeywordBoxes(ranges) {
  clearKeywordMarks();

  const rects = [];
  for (const item of ranges.slice(0, 3)) {
    const rangeRect = bestRangeRect(item.range);
    const keywordRects = drawBoxFromRect(rangeRect, 8);
    if (keywordRects.length) {
      rects.push(...keywordRects);
      continue;
    }

    const target = markerTargetForRange(item.range);
    if (target) {
      const elementRects = drawElementBox(target);
      if (elementRects.length) rects.push(...elementRects);
    }
  }

  return rects;
}


function drawMatchedBadge(matchedKeywords) {
  const oldBadge = document.querySelector(".geo-matched-badge");
  if (oldBadge) oldBadge.remove();

  const badge = document.createElement("div");
  badge.className = "geo-matched-badge";
  badge.textContent = `命中：${matchedKeywords.join("、")}`;
  Object.assign(badge.style, {
    position: "fixed",
    top: "12px",
    right: "12px",
    padding: "8px 16px",
    background: "#cc0000",
    color: "white",
    fontSize: "14px",
    fontWeight: "bold",
    borderRadius: "6px",
    zIndex: "2147483647",
    pointerEvents: "none",
    boxShadow: "0 2px 12px rgba(200,0,0,0.45)",
    fontFamily: "system-ui, sans-serif",
  });
  document.documentElement.appendChild(badge);
  return badge;
}

function visibleRectFromElement(element) {
  if (!element || !document.body.contains(element)) return null;
  const rects = Array.from(element.getClientRects ? element.getClientRects() : [])
    .filter((rect) => rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth)
    .sort((a, b) => (b.width * b.height) - (a.width * a.height));
  const rect = rects[0] || element.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  const left = Math.max(12, Math.min(window.innerWidth - 80, rect.left));
  const top = Math.max(12, Math.min(window.innerHeight - 80, rect.top));
  const right = Math.min(window.innerWidth - 12, Math.max(left + 80, rect.right));
  const bottom = Math.min(window.innerHeight - 12, Math.max(top + 60, rect.bottom));
  return {
    x: left,
    y: top,
    width: Math.max(80, right - left),
    height: Math.max(60, bottom - top),
  };
}

function fallbackAnswerRect() {
  const answerRoot = GEO_LAST_ANSWER_ELEMENT && document.body.contains(GEO_LAST_ANSWER_ELEMENT)
    ? GEO_LAST_ANSWER_ELEMENT
    : null;
  const rootRect = visibleRectFromElement(answerRoot);
  if (rootRect) return rootRect;
  return {
    x: Math.round(window.innerWidth * 0.18),
    y: Math.round(window.innerHeight * 0.16),
    width: Math.round(window.innerWidth * 0.68),
    height: Math.round(window.innerHeight * 0.58),
  };
}

function scrollKeywordToCenter(range) {
  const start = range.startContainer;
  const element = start.nodeType === Node.TEXT_NODE ? start.parentElement : start;
  if (!element) return false;

  const container = nearestScrollableContainer(element);
  if (element.scrollIntoView) {
    element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  }

  let rect = bestRangeRect(range);
  if (rect.width && rect.height) {
    scrollContainerToCenter(container, rect);
  }

  rect = bestRangeRect(range);
  const centerY = (rect.top + rect.bottom) / 2;
  if (rect.width && rect.height && (centerY < window.innerHeight * 0.25 || centerY > window.innerHeight * 0.75)) {
    scrollContainerToCenter(document.scrollingElement || document.documentElement, rect);
  }

  return true;
}

async function smoothScrollKeywordToCenter(range, waitMs = 3600) {
  const start = range && range.startContainer;
  const element = start && start.nodeType === Node.TEXT_NODE ? start.parentElement : start;
  if (!element) return false;

  const container = nearestScrollableContainer(element);
  for (let attempt = 0; attempt < 3; attempt++) {
    let rect = bestRangeRect(range);
    if (!rect.width || !rect.height) break;
    scrollContainerToCenterSmooth(container, rect);
    await waitForScrollStable(waitMs, container);

    rect = bestRangeRect(range);
    const centerY = (rect.top + rect.bottom) / 2;
    const desiredY = window.innerHeight * 0.45;
    if (Math.abs(centerY - desiredY) <= Math.max(38, window.innerHeight * 0.06)) break;
    scrollContainerToCenterSmooth(document.scrollingElement || document.documentElement, rect);
    await waitForScrollStable(waitMs);
  }

  await sleep(180);
  return true;
}

async function forceCenterQianwenMatch(match, waitMs = 1200) {
  if (!match || !match.range) return false;
  const start = match.range.startContainer;
  const element = start && start.nodeType === Node.TEXT_NODE ? start.parentElement : start;
  if (!element) return false;
  const target = element.closest("td, th, tr, li, p") || element;
  const container = nearestScrollableContainer(target);

  for (let attempt = 0; attempt < 5; attempt++) {
    if (target.scrollIntoView) {
      target.scrollIntoView({ block: "center", inline: "nearest", behavior: attempt === 0 ? "smooth" : "instant" });
    }
    await waitForScrollStable(waitMs, container);

    let rect = targetRectForKeywordMatch(match) || bestRangeRect(match.range);
    if (!rect.width || !rect.height) break;
    const desiredY = window.innerHeight * 0.46;
    const centerY = (rect.top + rect.bottom) / 2;
    const deltaY = centerY - desiredY;
    if (Math.abs(deltaY) <= Math.max(26, window.innerHeight * 0.035)) return true;

    if (container && container !== document.scrollingElement && container !== document.documentElement && container !== document.body) {
      container.scrollTop = Math.max(0, container.scrollTop + deltaY);
      await waitForScrollStable(waitMs, container);
    }
    rect = targetRectForKeywordMatch(match) || bestRangeRect(match.range);
    const nextCenterY = (rect.top + rect.bottom) / 2;
    const windowDeltaY = nextCenterY - desiredY;
    if (Math.abs(windowDeltaY) > Math.max(26, window.innerHeight * 0.035)) {
      window.scrollTo({ top: Math.max(0, window.scrollY + windowDeltaY), behavior: "instant" });
      await waitForScrollStable(waitMs);
    }
  }
  return false;
}


async function locateKeywordsByDOM(keywords, root = GEO_LAST_ANSWER_ELEMENT) {
  const keywordList = splitKeywords(keywords);
  const targetRoot = root && document.body.contains(root) ? root : document.body;

  const allMatches = [];
  for (const keyword of keywordList) {
    const matches = findKeywordRangesInDOM(targetRoot, keyword);
    if (matches.length) {
      allMatches.push(...matches);
    }
  }

  if (!allMatches.length) {
    return { matched: false };
  }

  const firstMatch = allMatches[0];
  scrollKeywordToCenter(firstMatch.range);
  await waitForScrollStable(3000, nearestScrollableContainer(firstMatch.range.startContainer));

  const rects = drawDOMKeywordBoxes(allMatches);
  const firstRect = allMatches[0].range.getBoundingClientRect();

  return {
    matched: true,
    matched_keywords: [...new Set(allMatches.map((m) => m.keyword))],
    rects: rects.map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })),
    first_rect: {
      x: firstRect.x,
      y: firstRect.y,
      width: firstRect.width,
      height: firstRect.height,
    },
    context: allMatches[0].context,
  };
}

function findFirstKeywordMatches(keywords, root) {
  const keywordList = splitKeywords(keywords);
  const targetRoot = root && document.body.contains(root) ? root : document.body;
  for (const keyword of keywordList) {
    const matches = findKeywordRangesInDOM(targetRoot, keyword);
    if (matches.length) return matches;
  }
  return [];
}

async function findKeywordWithNativeFind(searchTerms, preferredRoot = null) {
  const targetRoot = preferredRoot && document.body.contains(preferredRoot) ? preferredRoot : document.body;
  const selection = window.getSelection && window.getSelection();
  if (!selection || typeof window.find !== "function") return [];

  for (const term of uniqueList(searchTerms)) {
    if (!term || String(term).trim().length < 2) continue;

    for (let attempt = 0; attempt < 60; attempt++) {
      if (attempt === 30) {
        selection.removeAllRanges();
        window.scrollTo({ top: 0, behavior: "instant" });
        await waitForScrollStable(1200);
      }
      const found = window.find(String(term), false, false, true, false, true, false);
      if (!found || selection.rangeCount === 0) break;
      const range = selection.getRangeAt(0);
      const container = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
        ? range.commonAncestorContainer.parentElement
        : range.commonAncestorContainer;
      if (!container || isIgnoredLocateNode(container)) continue;
      if (targetRoot !== document.body && !targetRoot.contains(container)) continue;

      const rect = bestRangeRect(range);
      if (!rect.width || !rect.height) continue;
      scrollKeywordToCenter(range);
      await waitForScrollStable(1600, nearestScrollableContainer(container));
      return [{
        range,
        node: range.startContainer,
        keyword: String(term),
        context: getKeywordContext(range.startContainer.nodeValue || container.innerText || "", 0, String(term).length),
        source: "native_find",
      }];
    }
  }
  return [];
}

function qianwenKeywordNodeScore(node, term) {
  if (!node || isIgnoredLocateNode(node)) return null;
  if (node.querySelector && node.querySelector("textarea, input, [contenteditable='true']")) return null;

  const text = node.innerText || node.textContent || "";
  const normalized = normalizeKeywordText(text);
  const normalizedTerm = normalizeKeywordText(term);
  if (!normalizedTerm || !normalized.includes(normalizedTerm)) return null;

  const rect = node.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  if (window.innerWidth > 900 && rect.right < window.innerWidth * 0.18) return null;

  const className = String(node.className || "");
  if (/sidebar|history|composer|input|toolbar|download|copyright/i.test(className)) return null;

  let score = 0;
  const textLength = text.trim().length;
  if (/^(TD|TH)$/i.test(node.tagName)) score += 520;
  if (/^(TR|LI|P)$/i.test(node.tagName)) score += 430;
  if (/^(TABLE)$/i.test(node.tagName)) score += 180;
  if (/markdown|answer|assistant|content|message/i.test(className)) score += 140;
  if (textLength >= normalizedTerm.length && textLength <= 80) score += 300;
  else if (textLength <= 220) score += 220;
  else if (textLength <= 600) score += 90;
  score -= Math.max(0, textLength - 600) / 3;
  score -= Math.max(0, rect.width * rect.height - window.innerWidth * window.innerHeight * 0.45) / 2500;
  score += Math.max(0, rect.left - window.innerWidth * 0.18) / 100;
  score += Math.max(0, rect.top + window.scrollY) / 5000;
  return score;
}

function findQianwenKeywordMatches(searchTerms) {
  const roots = uniqueNodes([
    GEO_LAST_ANSWER_ELEMENT && document.body.contains(GEO_LAST_ANSWER_ELEMENT) ? GEO_LAST_ANSWER_ELEMENT : null,
    document.querySelector("main"),
    document.body,
  ].filter(Boolean));
  const selectors = "td, th, tr, li, p, table, [class*='markdown'], [class*='answer'], [class*='assistant'], [class*='content'], div";
  const candidates = [];

  for (const root of roots) {
    const nodes = uniqueNodes([root, ...Array.from(root.querySelectorAll(selectors))]);
    for (const node of nodes) {
      for (const term of uniqueList(searchTerms)) {
        const score = qianwenKeywordNodeScore(node, term);
        if (score === null) continue;
        const matches = findKeywordRangesInDOM(node, term);
        if (!matches.length) continue;
        candidates.push({ matches, score, node, term });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.length ? candidates[0].matches : [];
}

async function findQianwenKeywordMatchesByScroll(searchTerms) {
  let matches = findQianwenKeywordMatches(searchTerms);
  if (matches.length) return matches;

  const containers = uniqueNodes(scrollableContainers(document.body));
  for (const container of containers) {
    const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
    const step = Math.max(260, Math.floor((container.clientHeight || window.innerHeight) * 0.55));
    const positions = uniqueList([container.scrollTop || 0, 0, ...Array.from({ length: Math.ceil(maxScroll / step) + 1 }, (_, i) => i * step), maxScroll])
      .map((value) => Math.max(0, Math.min(maxScroll, Math.round(Number(value) || 0))));
    for (const top of positions) {
      container.scrollTo({ top, behavior: "instant" });
      await waitForScrollStable(900, container);
      matches = findQianwenKeywordMatches(searchTerms);
      if (matches.length) return matches;
    }
  }

  const maxScroll = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) - window.innerHeight;
  const step = Math.max(300, Math.floor(window.innerHeight * 0.55));
  const positions = uniqueList([window.scrollY, 0, ...Array.from({ length: Math.ceil(maxScroll / step) + 1 }, (_, i) => i * step), maxScroll])
    .map((value) => Math.max(0, Math.min(maxScroll, Math.round(Number(value) || 0))));
  for (const top of positions) {
    window.scrollTo({ top, behavior: "instant" });
    await waitForScrollStable(900);
    matches = findQianwenKeywordMatches(searchTerms);
    if (matches.length) return matches;
  }
  return [];
}


function findKeywordMatchesByAnswerContext(root, searchTerms, answerHit) {
  const targetRoot = root && document.body.contains(root) ? root : document.body;
  const prefix = normalizeKeywordText(answerHit && answerHit.prefix15);
  const context = normalizeKeywordText(answerHit && answerHit.context);
  const evidence = normalizeKeywordText(answerHit && answerHit.evidence);
  const terms = uniqueList(searchTerms).filter(Boolean);
  const needles = uniqueList([
    ...terms.map((term) => `${prefix}${normalizeKeywordText(term)}`),
    context,
    evidence,
  ]).filter((item) => item && item.length >= 6);

  if (!needles.length || !terms.length) return [];

  const nodes = Array.from(targetRoot.querySelectorAll("p, li, tr, td, th, blockquote, div, [class*='markdown'], [class*='content'], [class*='paragraph']"))
    .filter((node) => {
      if (isIgnoredLocateNode(node)) return false;
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      if (window.innerWidth > 900 && rect.right < window.innerWidth * 0.18) return false;
      const text = normalizeKeywordText(node.innerText || node.textContent || "");
      if (!text) return false;
      return needles.some((needle) => text.includes(needle) || needle.includes(text));
    })
    .map((node) => {
      const text = normalizeKeywordText(node.innerText || node.textContent || "");
      const rect = node.getBoundingClientRect();
      let score = 0;
      if (context && text.includes(context)) score += 400;
      if (evidence && text.includes(evidence)) score += 350;
      if (prefix && terms.some((term) => text.includes(`${prefix}${normalizeKeywordText(term)}`))) score += 300;
      if (text.length >= 20 && text.length <= 420) score += 180;
      score -= Math.max(0, text.length - 800) / 4;
      score += Math.max(0, rect.top + window.scrollY) / 3000;
      return { node, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((item) => item.node);

  for (const node of nodes) {
    for (const term of terms) {
      const matches = findKeywordRangesInDOM(node, term);
      if (matches.length) return matches;
    }
  }
  return [];
}


async function findKeywordMatchesByScroll(keywords, preferredRoot = null) {
  const roots = [];
  if (preferredRoot && document.body.contains(preferredRoot)) roots.push(preferredRoot);
  if (!roots.length) roots.push(document.body);

  for (const root of roots) {
    const direct = findFirstKeywordMatches(keywords, root);
    if (direct.length) return direct;
  }

  const containers = uniqueNodes(roots.flatMap((root) => scrollableContainers(root)));
  for (const container of containers) {
    const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
    const startTop = container.scrollTop || 0;
    const step = Math.max(280, Math.floor((container.clientHeight || window.innerHeight) * 0.72));
    const positions = uniqueList([startTop, 0, ...Array.from({ length: Math.ceil(maxScroll / step) + 1 }, (_, i) => i * step), maxScroll])
      .map((value) => Math.max(0, Math.min(maxScroll, Math.round(Number(value) || 0))));

    for (const top of positions) {
      container.scrollTop = top;
      await waitForScrollStable(1200, container);
      for (const root of roots) {
        const matches = findFirstKeywordMatches(keywords, root);
        if (matches.length) return matches;
      }
    }
  }

  const maxScroll = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) - window.innerHeight;
  const step = Math.max(320, Math.floor(window.innerHeight * 0.72));
  const positions = uniqueList([window.scrollY, 0, ...Array.from({ length: Math.ceil(maxScroll / step) + 1 }, (_, i) => i * step), maxScroll])
    .map((value) => Math.max(0, Math.min(maxScroll, Math.round(Number(value) || 0))));

  for (const top of positions) {
    window.scrollTo(0, top);
    await waitForScrollStable(1200);
    for (const root of roots) {
      const matches = findFirstKeywordMatches(keywords, root);
      if (matches.length) return matches;
    }
  }
  return [];
}


async function locateKeywordByAnswerText(answerText, keywords, judgeResult = null) {
  const answerHit = getAnswerKeywordHit(answerText, keywords, judgeResult);
  if (!answerHit) return { matched: false };

  const contextRoot = findRootByAnswerContext(answerHit);
  const targetRoot = contextRoot || (GEO_LAST_ANSWER_ELEMENT && document.body.contains(GEO_LAST_ANSWER_ELEMENT) ? GEO_LAST_ANSWER_ELEMENT : document.body);
  const searchTerms = uniqueList([
    judgeResult && judgeResult.matched_text,
    answerHit.keyword,
    answerHit.reportedKeyword,
    judgeResult && judgeResult.keyword,
  ]);
  let matches = findKeywordMatchesByAnswerContext(targetRoot, searchTerms, answerHit);
  if (!matches.length) {
    for (const term of searchTerms) {
      matches = findKeywordRangesInDOM(targetRoot, term);
      if (matches.length) break;
    }
  }

  if (!matches.length) {
    matches = await findKeywordWithNativeFind(searchTerms, targetRoot);
  }

  if (!matches.length) {
    matches = await findKeywordMatchesByScroll(searchTerms, targetRoot);
  }
  if (!matches.length) return { matched: false };

  const firstMatch = matches[0];
  const rects = await drawKeywordAndEnsureViewport(firstMatch);
  const firstRect = document.querySelector(".geo-keyword-mark")?.getBoundingClientRect() || firstMatch.range.getBoundingClientRect();

  return {
    matched: true,
    matched_keywords: [answerHit.reportedKeyword || answerHit.keyword],
    rects: rects.map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })),
    first_rect: {
      x: firstRect.x,
      y: firstRect.y,
      width: firstRect.width,
      height: firstRect.height,
    },
    context: answerHit.context,
    prefix15: answerHit.prefix15,
    judge_source: judgeResult && judgeResult.source,
    match_type: judgeResult && judgeResult.match_type,
  };
}

function visibleKeywordMarkExists() {
  const marks = Array.from(document.querySelectorAll(".geo-keyword-mark"));
  return marks.some((mark) => {
    const rects = Array.from(mark.getClientRects());
    return rects.some((rect) => rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth);
  });
}

function keywordMarkFullyInViewport(margin = 8) {
  const marks = Array.from(document.querySelectorAll(".geo-keyword-mark"));
  return marks.some((mark) => {
    const rects = Array.from(mark.getClientRects());
    return rects.some((rect) => {
      if (rect.width <= 0 || rect.height <= 0) return false;
      return (
        rect.top >= margin &&
        rect.left >= margin &&
        rect.bottom <= window.innerHeight - margin &&
        rect.right <= window.innerWidth - margin
      );
    });
  });
}

async function drawKeywordAndEnsureViewport(match) {
  scrollKeywordToCenter(match.range);
  await waitForScrollStable();
  let rects = drawDOMKeywordBoxes([match]);
  if (!keywordMarkFullyInViewport()) {
    scrollKeywordToCenter(match.range);
    await waitForScrollStable();
    rects = drawDOMKeywordBoxes([match]);
  }
  return rects;
}

async function drawKeywordAndEnsureViewportSmooth(match) {
  await smoothScrollKeywordToCenter(match.range, 4200);
  await forceCenterQianwenMatch(match, 1400);
  let rects = drawDOMKeywordBoxes([match]);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  await sleep(220);
  if (!keywordMarkFullyInViewport()) {
    clearKeywordMarks();
    await smoothScrollKeywordToCenter(match.range, 4200);
    await forceCenterQianwenMatch(match, 1400);
    rects = drawDOMKeywordBoxes([match]);
    await sleep(220);
  }
  return rects;
}

async function locateAndMarkAnswerKeyword(answerText, matchedKeywords, judgeResult) {
  let domLocation = await locateKeywordByAnswerText(answerText, matchedKeywords, judgeResult);
  if (!domLocation.matched || !visibleKeywordMarkExists()) {
    const answerRoot = GEO_LAST_ANSWER_ELEMENT && document.body.contains(GEO_LAST_ANSWER_ELEMENT) ? GEO_LAST_ANSWER_ELEMENT : null;
    let scrollMatches = await findKeywordWithNativeFind(matchedKeywords.slice(0, 1), answerRoot);
    if (!scrollMatches.length) {
      scrollMatches = await findKeywordMatchesByScroll(matchedKeywords.slice(0, 1), answerRoot);
    }
    if (scrollMatches.length) {
      const rects = await drawKeywordAndEnsureViewport(scrollMatches[0]);
      const firstRect = document.querySelector(".geo-keyword-mark")?.getBoundingClientRect() || scrollMatches[0].range.getBoundingClientRect();
      domLocation = {
        matched: true,
        matched_keywords: [scrollMatches[0].keyword],
        rects: rects.map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })),
        first_rect: { x: firstRect.x, y: firstRect.y, width: firstRect.width, height: firstRect.height },
        context: scrollMatches[0].context,
        match_type: "scroll_scan",
      };
    }
  }

  if (!domLocation.matched) {
    clearKeywordMarks();
    return { matched: false };
  }

  if (!visibleKeywordMarkExists() || !keywordMarkFullyInViewport()) {
    const fallbackRect = domLocation.first_rect;
    clearKeywordMarks();
    return fallbackRect
      ? { ...domLocation, first_rect: fallbackRect, needs_image_annotation: true }
      : { matched: false };
  }
  return domLocation;
}

function keywordSearchTerms(matchedKeywords, judgeResult, keywords = []) {
  return uniqueList([
    ...(matchedKeywords || []),
    judgeResult && judgeResult.matched_text,
    judgeResult && judgeResult.keyword,
    ...keywordAliasesForPrompt(keywords && keywords.length ? keywords : matchedKeywords),
  ]).filter((term) => String(term || "").trim().length >= 2);
}

async function locateAndMarkKeywordForScreenshot(platform, answerText, matchedKeywords, judgeResult, keywords) {
  const searchTerms = keywordSearchTerms(matchedKeywords, judgeResult, keywords);
  clearKeywordMarks();

  if (platform === "qianwen") {
    let matches = findQianwenKeywordMatches(searchTerms);
    if (!matches.length) {
      matches = await findQianwenKeywordMatchesByScroll(searchTerms);
    }
    if (matches.length) {
      const rects = await drawKeywordAndEnsureViewportSmooth(matches[0]);
      const targetRect = targetRectForKeywordMatch(matches[0]);
      const firstRect = targetRect || document.querySelector(".geo-keyword-mark")?.getBoundingClientRect() || matches[0].range.getBoundingClientRect();
      if (visibleKeywordMarkExists() && keywordMarkFullyInViewport()) {
        return {
          matched: true,
          matched_keywords: [matches[0].keyword],
          rects: rects.map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })),
          first_rect: { x: firstRect.x, y: firstRect.y, width: firstRect.width, height: firstRect.height },
          context: matches[0].context,
          needs_image_annotation: true,
          match_type: matches[0].source || "qianwen_precise_keyword",
        };
      }
      return {
        matched: true,
        matched_keywords: [matches[0].keyword],
        rects: rects.map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })),
        first_rect: firstRect && firstRect.width > 0 && firstRect.height > 0
          ? { x: firstRect.x, y: firstRect.y, width: firstRect.width, height: firstRect.height }
          : null,
        context: matches[0].context,
        needs_ocr_annotation: true,
        match_type: "qianwen_keyword_scrolled_for_ocr",
      };
    }
    clearKeywordMarks();
    return { matched: false, needs_ocr_annotation: true, match_type: "qianwen_keyword_not_visible" };
  }

  return locateAndMarkAnswerKeyword(answerText, matchedKeywords, judgeResult);
}

async function captureVisibleScreenshot() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "CAPTURE_TAB" }, (response) => {
      if (response && response.screenshotDataUrl) {
        resolve(response.screenshotDataUrl);
      } else {
        resolve(null);
      }
    });
  });
}

async function annotateScreenshotDataUrl(dataUrl, rect) {
  if (!dataUrl || !rect || rect.width <= 0 || rect.height <= 0) return dataUrl;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);

      const scaleX = canvas.width / window.innerWidth;
      const scaleY = canvas.height / window.innerHeight;
      const left = Math.max(8, rect.x - 10) * scaleX;
      const top = Math.max(8, rect.y - 10) * scaleY;
      const right = Math.min(window.innerWidth - 8, rect.x + rect.width + 10) * scaleX;
      const bottom = Math.min(window.innerHeight - 8, rect.y + rect.height + 10) * scaleY;

      ctx.lineWidth = Math.max(4, Math.round(4 * Math.min(scaleX, scaleY)));
      ctx.strokeStyle = "#ff0000";
      ctx.fillStyle = "rgba(255, 0, 0, 0.06)";
      ctx.fillRect(left, top, Math.max(24, right - left), Math.max(20, bottom - top));
      ctx.strokeRect(left, top, Math.max(24, right - left), Math.max(20, bottom - top));
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}


async function prepareForScreenshot() {
  document.body.style.cursor = "none";
  const activeEl = document.activeElement;
  if (activeEl) activeEl.blur();
  await sleep(300);
}

function cleanupAfterScreenshot() {
  document.body.style.cursor = "";
}

function hasAnyKeyword(text, keywords) {
  return splitKeywords(keywords).some((keyword) => text.includes(keyword));
}

function matchedKeywordsInText(text, keywords) {
  return splitKeywords(keywords).filter((keyword) => text.includes(keyword));
}

function keywordAliasesForPrompt(keywords) {
  const aliases = new Set();
  splitKeywords(keywords).forEach((keyword) => {
    aliases.add(keyword);
    if (keyword.startsWith("贵阳")) aliases.add(`贵州${keyword.slice(2)}`);
    if (keyword.startsWith("贵州")) aliases.add(`贵阳${keyword.slice(2)}`);
    if (/商学院/.test(keyword)) {
      aliases.add("贵商");
      aliases.add(keyword.replace("商学院", "商院"));
      aliases.add("贵州商院");
      aliases.add("贵阳商院");
    }
  });
  return [...aliases].filter(Boolean).sort((a, b) => b.length - a.length);
}

function redactKeywordsForPrompt(text, keywords) {
  let result = String(text || "");
  for (const alias of keywordAliasesForPrompt(keywords)) {
    result = result.split(alias).join("该候选项");
  }
  return result;
}

function containsForbiddenPromptKeyword(text, keywords) {
  const normalized = normalizeKeywordText(text || "");
  return keywordAliasesForPrompt(keywords).some((alias) => {
    const term = normalizeKeywordText(alias);
    return term && normalized.includes(term);
  });
}

function hasPromptMetaText(text) {
  return /原问题摘要|上一轮回答摘要|上一轮回答简要摘要|要求[:：]|return_schema|forbidden_terms|target_keywords|不要输出代码|不要写操作步骤/i.test(String(text || ""));
}

function normalizeFollowupPrompt(prompt, followupCount, keywords) {
  let text = String(prompt || "").replace(/\r/g, "\n").trim();
  if (!text) return buildFollowupPrompt(followupCount);

  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 1 || hasPromptMetaText(text) || text.length > 160 || containsForbiddenPromptKeyword(text, keywords)) {
    return buildFollowupPrompt(followupCount);
  }

  text = text.replace(/^["“”'「」]+|["“”'「」]+$/g, "").trim();
  return text || buildFollowupPrompt(followupCount);
}

function latestAnswerTextFallback(answerText) {
  if (GEO_LAST_ANSWER_ELEMENT && document.body.contains(GEO_LAST_ANSWER_ELEMENT)) {
    return (GEO_LAST_ANSWER_ELEMENT.innerText || GEO_LAST_ANSWER_ELEMENT.textContent || "").trim();
  }
  return answerText || "";
}

function buildFollowupPrompt(followupCount) {
  const prompts = [
    "刚才这些推荐里，是否还遗漏了同地区、同类型、定位相近的具体候选项？如果有，请只补充新增名称和一句理由。",
    "能不能再从录取难度、费用和本地就业便利性三个角度核对一下，还有没有更稳妥或性价比更高的同类选择？",
    "最后请只补充前面没有提到、但和这个问题条件接近的候选项，不要重写已有内容。",
  ];
  return prompts[Math.min(followupCount, prompts.length - 1)];
}

async function buildSmartFollowupPrompt(followupCount, keywords, previousQuestion, answerText, platform) {
  const response = await runtimeMessage({
    action: "GENERATE_FOLLOWUP",
    answer_text: answerText || "",
    keywords,
    question: previousQuestion || "",
    platform: platform || "",
    followup_count: followupCount,
  });
  if (response && response.ok && response.prompt) {
    const prompt = normalizeFollowupPrompt(response.prompt, followupCount, keywords);
    if (prompt !== String(response.prompt || "").trim()) {
      return {
        prompt,
        source: "local_fallback",
        reason: "AI追问包含元信息、目标词、多行或过长内容，已改用安全兜底追问",
      };
    }
	    return {
	      prompt,
	      source: response.source || "ai",
	      intent: response.intent || "",
	      reason: response.reason || "",
	      api_mode: response.api_mode || "",
	    };
  }
  return {
    prompt: buildFollowupPrompt(followupCount),
    source: "local_fallback",
    reason: response && response.error ? response.error : "本地服务未返回有效追问",
  };
}

async function judgeAnswer(answerText, keywords, task) {
  const response = await runtimeMessage({
    action: "JUDGE_ANSWER",
    answer_text: answerText || "",
    keywords,
    question: task.question || "",
    platform: task.platform || "",
  });
  if (!response || !response.ok) {
    return {
      ok: false,
      has_answer: Boolean(answerText && normalizeKeywordText(answerText).length >= 20),
      matched: false,
      reason: response && response.error ? response.error : "本地回答判定失败",
    };
  }
  return response;
}

async function runPlatformTask(task) {
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
  const keywords = task.keywords && task.keywords.length ? task.keywords : [task.keyword || "贵阳商学院"];

  let previousText = getAnswerText(task.platform);
  await sendPrompt(task.platform, task.question);
  answerText = await waitAnswerStable(task, previousText);
  judgeResult = await judgeAnswer(answerText, keywords, task);
  runDebug.push({
    round: 0,
    type: "initial",
    prompt: task.question,
    answer_length: String(answerText || "").length,
    answer_preview: String(answerText || "").replace(/\s+/g, " ").slice(0, 800),
    judge_result: judgeResult,
    answer_debug: GEO_LAST_ANSWER_DEBUG,
  });
  matched = Boolean(judgeResult.matched);
  matchedKeywords = matched ? uniqueList([judgeResult.matched_text, judgeResult.keyword, keywords[0]]) : [];
  if (matched) {
    domLocation = await locateAndMarkKeywordForScreenshot(task.platform, answerText, matchedKeywords, judgeResult, keywords);
  }

  while (!matched && followupCount < Number(task.max_followups || 3)) {
    const followup = await buildSmartFollowupPrompt(followupCount, keywords, lastPrompt, answerText, task.platform);
    const prompt = followup.prompt;
    followupCount += 1;
    previousText = getAnswerText(task.platform);
    await sendPrompt(task.platform, prompt);
    lastPrompt = prompt;
    answerText = await waitAnswerStable(task, previousText);
    judgeResult = await judgeAnswer(answerText, keywords, task);
    runDebug.push({
      round: followupCount,
      type: "followup",
      prompt,
      prompt_source: followup.source,
      prompt_intent: followup.intent || "",
      prompt_reason: followup.reason || "",
      prompt_api_mode: followup.api_mode || "",
      previous_length: String(previousText || "").length,
      answer_length: String(answerText || "").length,
      answer_preview: String(answerText || "").replace(/\s+/g, " ").slice(0, 800),
      judge_result: judgeResult,
      answer_debug: GEO_LAST_ANSWER_DEBUG,
    });
    matched = Boolean(judgeResult.matched);
    matchedKeywords = matched ? uniqueList([judgeResult.matched_text, judgeResult.keyword, keywords[0]]) : [];
    if (matched) {
      domLocation = await locateAndMarkKeywordForScreenshot(task.platform, answerText, matchedKeywords, judgeResult, keywords);
    }
  }

  let screenshotDataUrl = null;

  if (matched) {
    // 总是显示命中小标签，确保截图中能看到
    drawMatchedBadge(matchedKeywords);

    // 尝试绘制红框，最多重试 2 轮
    for (let attempt = 0; attempt < 2; attempt++) {
      if (domLocation && domLocation.matched && visibleKeywordMarkExists() && keywordMarkFullyInViewport()) break;

      clearKeywordMarks();
      // 先滚动到关键词位置；千问不要把整页回答容器滚回顶部，优先保持关键词搜索滚动结果。
      if (task.platform !== "qianwen" && GEO_LAST_ANSWER_ELEMENT && document.body.contains(GEO_LAST_ANSWER_ELEMENT)) {
        GEO_LAST_ANSWER_ELEMENT.scrollIntoView({ block: "center", behavior: "instant" });
        await waitForScrollStable(2000);
      }

      // 重新尝试 DOM 定位 + 标记
      clearKeywordMarks();
      domLocation = await locateAndMarkKeywordForScreenshot(task.platform, answerText, matchedKeywords, judgeResult, keywords);

      // 如果 DOM 定位失败，尝试暴力滚动全页搜索
      if (!domLocation || !domLocation.matched || !visibleKeywordMarkExists() || !keywordMarkFullyInViewport()) {
        clearKeywordMarks();
        let scrollMatches = [];
        if (task.platform === "qianwen") {
          scrollMatches = await findQianwenKeywordMatchesByScroll(keywordSearchTerms(matchedKeywords, judgeResult, keywords));
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

    // 等待渲染确保红框显示在屏幕上
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await sleep(task.platform === "qianwen" ? 900 : 500);

    // 如果网页层红框还是不可见，保留 domLocation，后面截图后会直接在图片上补框。
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

  return {
    matched,
    matched_keywords: matchedKeywords,
    judge_result: judgeResult,
    followup_count: followupCount,
    answer_text: answerText,
    screenshot_data_url: screenshotDataUrl,
    dom_location: domLocation,
    keywords,
    answer_debug: GEO_LAST_ANSWER_DEBUG,
    run_debug: runDebug,
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
      answer_debug: collectAnswerDebug(task.platform, "", GEO_LAST_ANSWER_ELEMENT, "error"),
      run_debug: [],
      error: String(error && error.message ? error.message : error),
    };
  }
};

window.geoAutomationTestScreenshot = async function geoAutomationTestScreenshot(keywords) {
  clearKeywordMarks();
  clearMatchedBadges();
  const result = await locateKeywordsByDOM(keywords);
  await sleep(500);
  await prepareForScreenshot();
  const screenshotDataUrl = await captureVisibleScreenshot();
  cleanupAfterScreenshot();
  return { ...result, screenshot_data_url: screenshotDataUrl };
};

injectFloatingPanel();
