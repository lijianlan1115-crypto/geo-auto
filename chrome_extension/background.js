let running = false;
let activeCount = 0;
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
  return configuredKeywords.length ? configuredKeywords : taskKeywords;
}

async function runOneTask(task) {
  let win = null;
  let tab = null;
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
    activeCount -= 1;
    if (win && win.id) {
      await chrome.windows.remove(win.id).catch(() => {});
    }
    pump();
  }
}

async function captureTabScreenshot(windowId) {
  try {
    return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } catch (e) {
    return null;
  }
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

async function pump() {
  if (!running) return;
  while (running) {
    const effectiveConcurrency = await getEffectiveConcurrency();
    if (activeCount >= effectiveConcurrency) {
      await sleep(1000);
      continue;
    }

    const data = await api("/next-task");
    if (!data.ok || !data.task) {
      running = false;
      return;
    }
    activeCount += 1;
    runOneTask(data.task);
    await sleep(1000);
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
      pump();
      const stats = health && health.stats ? health.stats : {};
      sendResponse({
        ok: true,
        running,
        concurrency: currentConcurrency,
        message: `已开始 / 继续执行：已完成 ${Number(stats.done || 0)}，待执行 ${Number(stats.pending || 0)}，失败 ${Number(stats.failed || 0)}。`,
        stats,
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
      sendResponse({ ok: true, running });
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
