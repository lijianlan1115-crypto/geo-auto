let running = false;
let activeCount = 0;
let pumpActive = false;
let currentServerUrl = "http://127.0.0.1:8765";
let currentConcurrency = 3;

const CONTENT_SCRIPTS = ["content_script.js", "content_script_geo_patch.js", "content_script_platform_patch.js"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function splitKeywords(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  return String(value || "")
    .split(/[\n,，、;；|/]+|\s+or\s+|\s+OR\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function api(path, options = {}) {
  try {
    const response = await fetch(`${currentServerUrl}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch (error) {
      payload = { ok: false, error: text || response.statusText };
    }
    if (!response.ok) {
      return { ok: false, error: payload.error || `Python 服务返回 HTTP ${response.status}` };
    }
    return payload;
  } catch (error) {
    return {
      ok: false,
      error: `连接不上 Python 服务：${currentServerUrl}。请先启动 python_service/server.py，再点“检查服务”。原始错误：${String(error && error.message ? error.message : error)}`,
    };
  }
}

async function waitForTabLoaded(tabId, timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return;
    await sleep(500);
  }
}

async function createTaskWindow(url) {
  return await chrome.windows.create({
    url,
    type: "normal",
    state: "normal",
    focused: false,
    width: 1280,
    height: 800,
  });
}

async function injectAutomationScripts(tabId) {
  for (const file of CONTENT_SCRIPTS) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [file],
    }).catch(() => {});
  }
}

async function effectiveTaskKeywords(task) {
  const data = await chrome.storage.local.get(["keyword"]);
  const taskKeywords = splitKeywords(task.keywords || task.keyword);
  const configuredKeywords = splitKeywords(data.keyword);
  // Excel 每一行的目标关键词必须优先。面板关键词只在任务本身没有关键词时兜底，
  // 否则不同问题会错误地用同一组全局关键词定位正文和截图。
  return taskKeywords.length ? taskKeywords : configuredKeywords;
}

async function runOneTask(task) {
  let win = null;
  let tab = null;
  let keepWindowOpen = false;
  try {
    const data = await chrome.storage.local.get(["platformUrls"]);
    const customUrl = data.platformUrls && data.platformUrls[task.platform];
    const platformUrl = customUrl || task.platform_url;

    win = await createTaskWindow(platformUrl);
    if (!win || !win.id || !win.tabs || !win.tabs.length) {
      throw new Error("无法创建任务窗口");
    }
    tab = win.tabs[0];

    await waitForTabLoaded(tab.id);
    await sleep(2500);
    await injectAutomationScripts(tab.id);

    const keywords = await effectiveTaskKeywords(task);
    if (!keywords.length) {
      throw new Error("缺少目标关键词：请在插件面板或 Excel 关键词列中填写目标关键词后再开始。");
    }
    task.keywords = keywords;
    task.keyword = keywords[0];

    let scriptResult;
    try {
      scriptResult = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (payload) => window.geoAutomationRun(payload),
        args: [task],
      });
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      if (!/Frame with ID .*was removed|Extension context invalidated|Cannot access/.test(message)) throw error;
      await sleep(2500);
      await waitForTabLoaded(tab.id).catch(() => {});
      await injectAutomationScripts(tab.id);
      scriptResult = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (payload) => window.geoAutomationRun(payload),
        args: [task],
      });
    }

    const [{ result }] = scriptResult;

    if (!result) {
      throw new Error("content script did not return result");
    }
    if (
      task.platform === "wenxin" &&
      /文心.*(?:发送按钮|输入框未清空|避免重复发送)/.test(String(result.error || ""))
    ) {
      keepWindowOpen = true;
    }

    if (!result.screenshot_data_url && tab && tab.windowId) {
      result.screenshot_data_url = await captureTabScreenshot(tab.windowId);
    }
    if (!result.screenshot_data_url) {
      const err = new Error(result.error || "截图失败：未获取到页面截图");
      err.answer_debug = result.answer_debug || null;
      err.run_debug = result.run_debug || [];
      throw err;
    }

    await api("/submit-result", {
      method: "POST",
      body: JSON.stringify({
        task_id: task.task_id,
        row_number: task.row_number,
        row_id: task.row_id,
        question: task.question,
        platform: task.platform,
        matched: Boolean(result && result.matched),
        matched_keywords: result && result.matched_keywords ? result.matched_keywords : [],
        followup_count: result ? result.followup_count : 0,
        answer_text: result ? result.answer_text : "",
        error: result ? result.error : "content script did not return result",
        screenshot_data_url: result && result.screenshot_data_url ? result.screenshot_data_url : null,
        dom_location: result && result.dom_location ? result.dom_location : null,
        answer_debug: result && result.answer_debug ? result.answer_debug : null,
        run_debug: result && result.run_debug ? result.run_debug : [],
        keywords: task.keywords,
      }),
    });
  } catch (error) {
    if (
      task.platform === "wenxin" &&
      /文心.*(?:发送按钮|输入框未清空|避免重复发送)/.test(String(error && error.message ? error.message : error))
    ) {
      keepWindowOpen = true;
    }
    let fallbackSubmitted = false;
    if (tab && tab.windowId) {
      const fallbackScreenshot = await captureTabScreenshot(tab.windowId).catch(() => null);
      if (fallbackScreenshot) {
        const submitted = await api("/submit-result", {
          method: "POST",
          body: JSON.stringify({
            task_id: task.task_id,
            row_number: task.row_number,
            row_id: task.row_id,
            question: task.question,
            platform: task.platform,
            matched: false,
            matched_keywords: [],
            followup_count: 0,
            answer_text: "",
            error: String(error && error.message ? error.message : error),
            screenshot_data_url: fallbackScreenshot,
            dom_location: null,
            answer_debug: error && error.answer_debug ? error.answer_debug : null,
            run_debug: error && error.run_debug ? error.run_debug : [],
            keywords: task.keywords || [],
          }),
        }).catch(() => null);
        fallbackSubmitted = Boolean(submitted && submitted.ok);
      }
    }
    if (fallbackSubmitted) return;
    await api("/task-failed", {
      method: "POST",
      body: JSON.stringify({
        task_id: task.task_id,
        error: String(error && error.message ? error.message : error),
        answer_debug: error && error.answer_debug ? error.answer_debug : null,
        run_debug: error && error.run_debug ? error.run_debug : [],
      }),
    }).catch(() => {});
  } finally {
    activeCount = Math.max(0, activeCount - 1);
    if (win && win.id && !keepWindowOpen) {
      await chrome.windows.remove(win.id).catch(() => {});
    }
  }
}

async function captureTabScreenshot(windowId) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const screenshot = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
      if (screenshot) return screenshot;
    } catch (e) {}
    await sleep(250);
  }
  return null;
}

async function testScreenshot(keywordText) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error("找不到当前标签页");

  const configuredKeywords = splitKeywords(keywordText);
  const excelKeywords = configuredKeywords.length
    ? null
    : await api("/test-keywords").catch(() => null);
  const keywords = configuredKeywords.length
    ? configuredKeywords
    : (excelKeywords && excelKeywords.ok && excelKeywords.keywords && excelKeywords.keywords.length
      ? excelKeywords.keywords
      : []);

  if (!keywords.length) throw new Error("缺少测试关键词，请先在插件面板或 Excel 关键词列中填写。 ");

  await injectAutomationScripts(tab.id);

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async (targetKeywords) => await window.geoAutomationTestScreenshot(targetKeywords),
    args: [keywords],
  });

  const screenshotDataUrl = result && result.screenshot_data_url
    ? result.screenshot_data_url
    : await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });

  const saved = await api("/save-test-screenshot", {
    method: "POST",
    body: JSON.stringify({
      keyword: keywords.join("，"),
      keywords,
      screenshot_data_url: screenshotDataUrl,
    }),
  });

  return {
    ...saved,
    keywords,
    keyword_source: configuredKeywords.length ? "plugin" : (excelKeywords ? excelKeywords.source : "missing"),
    keyword_message: excelKeywords ? excelKeywords.message : undefined,
    excel_row_number: excelKeywords ? excelKeywords.row_number : undefined,
    dom_location: result && result.dom_location ? result.dom_location : null,
  };
}

async function openLoginTabs() {
  const data = await chrome.storage.local.get(["platforms", "platformUrls"]);
  const list = data.platforms && data.platforms.length
    ? data.platforms
    : Object.entries(data.platformUrls || {}).map(([key, url]) => ({ key, name: key, url }));
  const opened = [];

  for (const item of list) {
    const tab = await chrome.tabs.create({ url: item.url, active: false });
    opened.push({ platform: item.key, name: item.name, url: item.url, tabId: tab.id });
    await sleep(600);
  }

  return {
    ok: true,
    message: `已打开${opened.length}个平台，请先逐个登录；登录完成后再点“开始”。`,
    opened,
  };
}

async function getEffectiveConcurrency() {
  const data = await chrome.storage.local.get(["concurrency"]);
  return Math.max(1, Math.min(5, Number(data.concurrency || currentConcurrency)));
}

async function collectOneTargetPlatformContext(platform, keywords) {
  let win = null;
  let tab = null;
  try {
    win = await createTaskWindow(platform.url);
    if (!win || !win.id || !win.tabs || !win.tabs.length) {
      throw new Error("无法创建目标预搜索窗口");
    }
    tab = win.tabs[0];
    await waitForTabLoaded(tab.id);
    await sleep(2200);
    await injectAutomationScripts(tab.id);
    const scriptResult = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (payload) => {
        if (typeof window.geoAutomationCollectTargetContext !== "function") {
          return { ok: false, answer_text: "", error: "目标预搜索脚本未加载" };
        }
        return await window.geoAutomationCollectTargetContext(payload);
      },
      args: [{
        platform: platform.key,
        keywords,
        answer_poll_interval: 0.8,
        answer_stable_seconds: 3,
        answer_final_settle_seconds: 5,
        answer_timeout_seconds: 70,
      }],
    });
    const result = scriptResult && scriptResult[0] ? scriptResult[0].result : null;
    await api("/target-platform-context", {
      method: "POST",
      body: JSON.stringify({
        keywords,
        platform: platform.key,
        ok: Boolean(result && result.ok),
        answer_text: result && result.answer_text ? result.answer_text : "",
        error: result && result.error ? result.error : "目标预搜索没有返回结果",
      }),
    });
    return {
      platform: platform.key,
      ok: Boolean(result && result.ok),
      error: result && result.error ? result.error : "",
    };
  } catch (error) {
    await api("/target-platform-context", {
      method: "POST",
      body: JSON.stringify({
        keywords,
        platform: platform.key,
        ok: false,
        answer_text: "",
        error: String(error && error.message ? error.message : error),
      }),
    }).catch(() => {});
    return {
      platform: platform.key,
      ok: false,
      error: String(error && error.message ? error.message : error),
    };
  } finally {
    if (win && win.id) await chrome.windows.remove(win.id).catch(() => {});
  }
}

async function prewarmTargetContexts(platforms) {
  const response = await api("/target-keyword-groups");
  const groups = response && response.ok && Array.isArray(response.groups) ? response.groups : [];
  const availablePlatforms = (platforms || []).filter((item) => item && item.key && item.url);
  const results = [];

  // Different target groups run one after another to avoid opening too many
  // windows, while Doubao/Yuanbao/Qianwen for the same target run in parallel.
  for (const group of groups) {
    if (!running) break;
    const keywords = Array.isArray(group.keywords) ? group.keywords.filter(Boolean) : [];
    const cached = new Set(Array.isArray(group.cached_platforms) ? group.cached_platforms : []);
    if (!keywords.length) continue;
    const jobs = availablePlatforms
      .filter((platform) => !cached.has(platform.key))
      .map((platform) => collectOneTargetPlatformContext(platform, keywords));
    if (jobs.length) results.push(...await Promise.all(jobs));
  }

  return {
    groups: groups.length,
    attempted: results.length,
    succeeded: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
  };
}

async function pump() {
  if (!running || pumpActive) return;
  pumpActive = true;
  try {
    while (running) {
      const effectiveConcurrency = await getEffectiveConcurrency();
      if (activeCount >= effectiveConcurrency) {
        await sleep(100);
        continue;
      }

      const data = await api("/next-task");
      if (!data.ok) {
        running = false;
        return;
      }
      if (!data.task) {
        if (activeCount > 0) {
          await sleep(100);
          continue;
        }
        // All windows have finished. Persist the final workbook first, then let
        // the service clear this batch's temporary SQLite task records.
        await api("/finalize-batch", {
          method: "POST",
          body: JSON.stringify({}),
        }).catch(() => {});
        running = false;
        return;
      }
      activeCount += 1;
      void runOneTask(data.task);
      await sleep(50);
    }
  } finally {
    pumpActive = false;
  }
}

async function syncRunConfig(platforms, aiJudge) {
  if (platforms && platforms.length) {
    const configured = await api("/set-platforms", {
      method: "POST",
      body: JSON.stringify({ platforms }),
    });
    if (!configured || !configured.ok) return configured;
  }
  if (aiJudge !== undefined && aiJudge !== null) {
    const configured = await api("/ai-judge-config", {
      method: "POST",
      body: JSON.stringify(aiJudge),
    });
    if (!configured || !configured.ok) return configured;
  }
  return { ok: true };
}

async function mergedSettingsFromStorage() {
  const data = await chrome.storage.local.get(["serverUrl", "concurrency", "platformUrls", "platforms", "keyword", "aiJudge"]);
  currentServerUrl = data.serverUrl || currentServerUrl;
  const storedAiJudge = data.aiJudge || {};
  const serverAiJudge = await api("/ai-judge-config").catch(() => null);
  const aiJudge = {
    ...storedAiJudge,
    ...(serverAiJudge && serverAiJudge.ok ? {
      enabled: Boolean(serverAiJudge.enabled),
      api_url: serverAiJudge.api_url || storedAiJudge.api_url || "",
      model: serverAiJudge.model || storedAiJudge.model || "",
      has_api_key: Boolean(serverAiJudge.has_api_key || storedAiJudge.api_key),
      api_key_preview: serverAiJudge.api_key_preview || (storedAiJudge.api_key ? "***" : ""),
    } : {}),
    api_key: storedAiJudge.api_key || "",
  };
  return { data, aiJudge };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.action === "CAPTURE_TAB") {
      if (!sender.tab || !sender.tab.windowId) {
        sendResponse({ ok: false, error: "找不到窗口" });
        return;
      }
      const screenshotDataUrl = await captureTabScreenshot(sender.tab.windowId);
      sendResponse({ ok: Boolean(screenshotDataUrl), screenshotDataUrl });
      return;
    }

    if (message.action === "WENXIN_CLICK_SEND_MAIN") {
      if (!sender.tab || !sender.tab.id) {
        sendResponse({ ok: false, error: "找不到文心标签页" });
        return;
      }
      try {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: sender.tab.id },
          world: "MAIN",
          func: () => {
          const wrapper = Array.from(document.querySelectorAll(".ci-submit-button")).find((node) => {
            const rect = node.getBoundingClientRect();
            return rect.width > 8 && rect.height > 8 && node.querySelector("#ci-submit-button-ai");
          });
          if (!wrapper) return { ok: false, error: "主页面未找到 .ci-submit-button" };
          const target = wrapper.querySelector("#ci-submit-button-ai") || wrapper;
          target.focus?.();
          const init = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, buttons: 1 };
          try {
            target.dispatchEvent(new PointerEvent("pointerdown", { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true }));
          } catch (e) {}
          target.dispatchEvent(new MouseEvent("mousedown", init));
          try {
            target.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0, pointerId: 1, pointerType: "mouse", isPrimary: true }));
          } catch (e) {}
          target.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0 }));
          target.click();
          return {
            ok: true,
            active: target.classList.contains("ci-submit-button-ai-active"),
            target: target.id || target.className || target.tagName,
          };
          },
        });
        sendResponse(result || { ok: false, error: "文心主页面点击没有返回结果" });
      } catch (error) {
        sendResponse({ ok: false, error: String(error && error.message ? error.message : error) });
      }
      return;
    }

    if (message.action === "WENXIN_SET_INPUT_MAIN") {
      if (!sender.tab || !sender.tab.id) {
        sendResponse({ ok: false, error: "找不到文心标签页" });
        return;
      }
      try {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: sender.tab.id },
          world: "MAIN",
          args: [String(message.text || "")],
          func: async (text) => {
            const selectors = [
              "#input-root textarea",
              '#input-root [contenteditable="true"]',
              '#input-root [contenteditable="plaintext-only"]',
              "#chat-input-home textarea",
              '#chat-input-home [contenteditable="true"]',
              '#chat-input-home [contenteditable="plaintext-only"]',
              ".ci-root textarea",
              '.ci-root [contenteditable="true"]',
              '.ci-root [contenteditable="plaintext-only"]',
            ];
            const candidates = [];
            const seen = new Set();
            for (const selector of selectors) {
              for (const node of document.querySelectorAll(selector)) {
                if (seen.has(node)) continue;
                seen.add(node);
                const rect = node.getBoundingClientRect();
                if (rect.width < 80 || rect.height < 20 || node.disabled || node.getAttribute("aria-disabled") === "true") continue;
                let score = rect.top + Math.min(rect.width, 1200);
                if (node.closest("#input-root")) score += 5000;
                if (node.closest(".ci-root")) score += 3000;
                candidates.push({ node, score });
              }
            }
            candidates.sort((a, b) => b.score - a.score);
            const input = candidates[0] && candidates[0].node;
            if (!input) return { ok: false, error: "主页面未找到 #input-root 内的真实编辑框" };

            input.focus();
            if (input.isContentEditable) {
              const selection = window.getSelection();
              const range = document.createRange();
              range.selectNodeContents(input);
              selection.removeAllRanges();
              selection.addRange(range);
              let inserted = false;
              try {
                inserted = document.execCommand("insertText", false, text);
              } catch (e) {}
              if (!inserted || String(input.textContent || "").trim() !== text.trim()) {
                input.textContent = text;
              }
            } else {
              const proto = input instanceof HTMLTextAreaElement
                ? HTMLTextAreaElement.prototype
                : HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
              if (setter) setter.call(input, text);
              else input.value = text;
            }
            input.dispatchEvent(new InputEvent("input", {
              bubbles: true,
              composed: true,
              inputType: "insertText",
              data: text,
            }));
            input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
            await new Promise((resolve) => setTimeout(resolve, 180));
            const actual = String(input.isContentEditable ? input.textContent : input.value || "").trim();
            return {
              ok: actual === text.trim(),
              error: actual === text.trim() ? "" : "写入后文本校验不一致",
              actual_length: actual.length,
              expected_length: text.trim().length,
              tag: input.tagName,
              class_name: String(input.className || ""),
            };
          },
        });
        sendResponse(result || { ok: false, error: "文心主页面写入没有返回结果" });
      } catch (error) {
        sendResponse({ ok: false, error: String(error && error.message ? error.message : error) });
      }
      return;
    }

    if (message.action === "JUDGE_ANSWER") {
      sendResponse(await api("/judge-answer", {
        method: "POST",
        body: JSON.stringify({
          answer_text: message.answer_text || "",
          keywords: message.keywords || [],
          question: message.question || "",
          platform: message.platform || "",
        }),
      }));
      return;
    }

    if (message.action === "GENERATE_FOLLOWUP") {
      sendResponse(await api("/generate-followup", {
        method: "POST",
        body: JSON.stringify({
          answer_text: message.answer_text || "",
          keywords: message.keywords || [],
          question: message.question || "",
          platform: message.platform || "",
          followup_count: message.followup_count || 0,
          task_id: message.task_id || (message.question && message.question.task_id) || "",
        }),
      }));
      return;
    }

    if (message.action === "HEALTH") {
      currentServerUrl = message.serverUrl || currentServerUrl;
      sendResponse(await api("/health"));
      return;
    }

    if (message.action === "GET_SETTINGS") {
      const { data, aiJudge } = await mergedSettingsFromStorage();
      sendResponse({
        ok: true,
        serverUrl: data.serverUrl || currentServerUrl,
        concurrency: data.concurrency || currentConcurrency,
        keyword: data.keyword || "",
        platformUrls: data.platformUrls || {},
        platforms: data.platforms || [],
        aiJudge,
      });
      return;
    }

    if (message.action === "SAVE_SETTINGS") {
      currentServerUrl = message.serverUrl || currentServerUrl;
      currentConcurrency = Math.max(1, Math.min(5, Number(message.concurrency || currentConcurrency)));
      const existing = await chrome.storage.local.get(["aiJudge"]);
      const existingAiJudge = existing.aiJudge || {};
      const nextAiJudge = {
        ...existingAiJudge,
        ...(message.aiJudge || {}),
        api_key: message.aiJudge && message.aiJudge.api_key ? message.aiJudge.api_key : (existingAiJudge.api_key || ""),
      };
      await chrome.storage.local.set({
        serverUrl: currentServerUrl,
        concurrency: currentConcurrency,
        keyword: message.keyword || "",
        platformUrls: message.platformUrls || {},
        platforms: message.platforms || [],
        aiJudge: nextAiJudge,
      });
      const synced = await syncRunConfig(message.platforms || [], message.aiJudge ? { ...message.aiJudge, api_key: message.aiJudge.api_key || "" } : undefined).catch((error) => ({
        ok: false,
        error: String(error && error.message ? error.message : error),
      }));
      if (!synced || !synced.ok) {
        sendResponse({
          ok: false,
          saved_to_chrome: true,
          error: synced && synced.error ? synced.error : "配置已保存到插件，但同步到 Python 服务失败。请先启动服务后再保存一次。",
        });
        return;
      }
      sendResponse({ ok: true, saved_to_chrome: true, synced_to_python: true });
      return;
    }

    if (message.action === "TEST_SCREENSHOT") {
      currentServerUrl = message.serverUrl || currentServerUrl;
      const keyword = message.keyword || "";
      await chrome.storage.local.set({ serverUrl: currentServerUrl, keyword });
      sendResponse(await testScreenshot(keyword));
      return;
    }

    if (message.action === "START") {
      currentServerUrl = message.serverUrl || currentServerUrl;
      currentConcurrency = Math.max(1, Math.min(5, Number(message.concurrency || 3)));
      await chrome.storage.local.set({
        serverUrl: currentServerUrl,
        concurrency: currentConcurrency,
      });
      const synced = await syncRunConfig(message.platforms || [], message.aiJudge).catch((error) => ({ ok: false, error: String(error && error.message ? error.message : error) }));
      if (!synced || !synced.ok) {
        sendResponse({
          ok: false,
          running: false,
          message: synced && synced.error ? synced.error : "同步平台配置失败。",
        });
        return;
      }
      const excelSync = await api("/sync-results", {
        method: "POST",
        body: JSON.stringify({ reason: "before_start" }),
      }).catch((error) => ({
        ok: false,
        error: String(error && error.message ? error.message : error),
      }));
      if (!excelSync || !excelSync.ok) {
        sendResponse({
          ok: false,
          running: false,
          message: `插件配置已保存，但结果 Excel 准备失败：${excelSync && excelSync.error ? excelSync.error : "未知错误"}`,
        });
        return;
      }
      await api("/reset-running-tasks", { method: "POST", body: JSON.stringify({}) }).catch(() => {});
      const health = await api("/health").catch(() => null);
      if (!health || !health.ok) {
        sendResponse({
          ok: false,
          running: false,
          message: health && health.error ? health.error : "连接不上 Python 服务，请先启动服务。",
          stats: health ? health.stats : undefined,
        });
        return;
      }
      if (health && health.stats && !health.stats.pending) {
        const stats = health.stats || {};
        sendResponse({
          ok: false,
          running: false,
          message: `没有待执行任务。已完成 ${Number(stats.done || 0)}，失败 ${Number(stats.failed || 0)}。失败项可使用“重置失败任务”后继续。`,
          stats,
        });
        return;
      }
      running = true;
      const targetWarmup = await prewarmTargetContexts(message.platforms || []).catch((error) => ({
        groups: 0,
        attempted: 0,
        succeeded: 0,
        failed: 0,
        error: String(error && error.message ? error.message : error),
      }));
      if (!running) {
        sendResponse({ ok: true, running: false, message: "已停止；目标预搜索结果已保留供下次继续。", target_warmup: targetWarmup });
        return;
      }
      pump();
      const stats = health && health.stats ? health.stats : {};
      sendResponse({
        ok: true,
        running,
        concurrency: currentConcurrency,
        message: `目标预搜索完成（成功 ${Number(targetWarmup.succeeded || 0)}/${Number(targetWarmup.attempted || 0)}），已开始执行：已完成 ${Number(stats.done || 0)}，待执行 ${Number(stats.pending || 0)}，失败 ${Number(stats.failed || 0)}。`,
        stats,
        target_warmup: targetWarmup,
      });
      return;
    }

    if (message.action === "RESET_FAILED_TASKS") {
      sendResponse(await api("/reset-failed-tasks", { method: "POST", body: JSON.stringify({}) }));
      return;
    }

    if (message.action === "RESET_ALL_TASKS") {
      sendResponse(await api("/reset-all-tasks", { method: "POST", body: JSON.stringify({}) }));
      return;
    }

    if (message.action === "OPEN_LOGIN_TABS") {
      sendResponse(await openLoginTabs());
      return;
    }

    if (message.action === "STOP") {
      running = false;
      const syncResult = await api("/sync-results", {
        method: "POST",
        body: JSON.stringify({ reason: "manual_stop" }),
      }).catch((error) => ({ ok: false, error: String(error && error.message ? error.message : error) }));
      sendResponse({
        ok: Boolean(syncResult && syncResult.ok),
        running,
        synced: Boolean(syncResult && syncResult.synced),
        result_excel: syncResult && syncResult.result_excel ? syncResult.result_excel : "",
        message: syncResult && syncResult.ok
          ? "已停止，并已把已完成截图补写到结果 Excel"
          : `已停止；Excel 暂未写入：${syncResult && syncResult.error ? syncResult.error : "请关闭 Excel/WPS 后重启服务补写"}`,
      });
      return;
    }

    if (message.action === "RELOAD_ACTIVE_TAB") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) {
        sendResponse({ ok: false, error: "找不到当前标签页" });
        return;
      }
      await chrome.tabs.reload(tab.id);
      sendResponse({ ok: true, message: "当前网页已刷新" });
      return;
    }

    if (message.action === "RELOAD_EXTENSION") {
      sendResponse({ ok: true, message: "插件正在重载，重载后请刷新当前网页" });
      setTimeout(() => chrome.runtime.reload(), 200);
      return;
    }

    sendResponse({ ok: false, error: "unknown action" });
  })();
  return true;
});
