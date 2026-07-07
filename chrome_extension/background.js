let running = false;
let activeCount = 0;
let currentServerUrl = "http://127.0.0.1:8765";
let currentConcurrency = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function splitKeywords(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "贵阳商学院")
    .split(/[\n,，、;；|/]+|\s+or\s+|\s+OR\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function api(path, options = {}) {
  const response = await fetch(`${currentServerUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  return response.json();
}

async function waitForTabLoaded(tabId, timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return;
    await sleep(500);
  }
}

async function runOneTask(task) {
  let tab;
  try {
    const data = await chrome.storage.local.get(["platformUrls"]);
    const customUrl = data.platformUrls && data.platformUrls[task.platform];
    const platformUrl = customUrl || task.platform_url;
    tab = await chrome.tabs.create({ url: platformUrl, active: false });
    await waitForTabLoaded(tab.id);
    await sleep(2500);
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content_script.js"],
    }).catch(() => {});

    if (!task.keywords || !task.keywords.length) {
      task.keywords = ["贵阳商学院"];
      task.keyword = "贵阳商学院";
    }

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (payload) => window.geoAutomationRun(payload),
      args: [task],
    });

    if (!result || result.error) {
      throw new Error(result && result.error ? result.error : "content script did not return result");
    }

    await chrome.tabs.update(tab.id, { active: true });
    
    await sleep(1000);
    
    if (result && result.matched) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async () => window.geoAutomationRefreshMarks && await window.geoAutomationRefreshMarks(),
      }).catch(() => {});
    }
    
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        document.body.style.cursor = 'none';
        const activeEl = document.activeElement;
        if (activeEl) {
          activeEl.blur();
        }
      },
    }).catch(() => {});
    
    await sleep(500);
    
    const screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        document.body.style.cursor = '';
      },
    }).catch(() => {});

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
        screenshot_data_url: screenshotDataUrl,
      }),
    });
  } catch (error) {
    await api("/task-failed", {
      method: "POST",
      body: JSON.stringify({
        task_id: task.task_id,
        error: String(error && error.message ? error.message : error),
      }),
    }).catch(() => {});
  } finally {
    activeCount -= 1;
    if (tab && tab.id) {
      await chrome.tabs.remove(tab.id).catch(() => {});
    }
    pump();
  }
}

async function testScreenshot(keywordText) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error("找不到当前标签页");

  const excelKeywords = await api("/test-keywords").catch(() => null);
  const keywords = excelKeywords && excelKeywords.ok && excelKeywords.keywords && excelKeywords.keywords.length
    ? excelKeywords.keywords
    : splitKeywords(keywordText);
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async (targetKeywords) => await window.geoAutomationTestScreenshot(targetKeywords),
    args: [keywords],
  });

  await sleep(1500);
  
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      document.body.style.cursor = 'none';
      const activeEl = document.activeElement;
      if (activeEl) {
        activeEl.blur();
      }
    },
  }).catch(() => {});
  
  await sleep(500);
  
  const screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      document.body.style.cursor = '';
    },
  }).catch(() => {});
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
    keyword_source: excelKeywords ? excelKeywords.source : "input",
    keyword_message: excelKeywords ? excelKeywords.message : undefined,
    excel_row_number: excelKeywords ? excelKeywords.row_number : undefined,
  };
}

async function openLoginTabs() {
  const data = await chrome.storage.local.get(["platformUrls"]);
  const defaultUrls = {
    doubao: "https://www.doubao.com/chat/",
    qianwen: "https://tongyi.aliyun.com/qianwen/",
    deepseek: "https://chat.deepseek.com/",
    yuanbao: "https://yuanbao.tencent.com/chat/",
    wenxin: "https://chat.baidu.com/?enter_type=yiyan_site",
  };
  const urls = { ...defaultUrls, ...(data.platformUrls || {}) };
  const opened = [];

  for (const [platform, url] of Object.entries(urls)) {
    const tab = await chrome.tabs.create({ url, active: platform === "deepseek" });
    opened.push({ platform, url, tabId: tab.id });
    await sleep(600);
  }

  return {
    ok: true,
    message: "已打开5个平台，请先逐个登录；登录完成后再点“开始”。",
    opened,
  };
}

async function pump() {
  if (!running) return;
  while (running && activeCount < currentConcurrency) {
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.action === "HEALTH") {
      currentServerUrl = message.serverUrl || currentServerUrl;
      sendResponse(await api("/health"));
      return;
    }

    if (message.action === "GET_SETTINGS") {
      const data = await chrome.storage.local.get(["serverUrl", "concurrency", "platformUrls", "keyword"]);
      sendResponse({
        ok: true,
        serverUrl: data.serverUrl || currentServerUrl,
        concurrency: data.concurrency || currentConcurrency,
        keyword: data.keyword || "贵阳商学院",
        platformUrls: data.platformUrls || {},
      });
      return;
    }

    if (message.action === "SAVE_SETTINGS") {
      currentServerUrl = message.serverUrl || currentServerUrl;
      currentConcurrency = Math.max(1, Math.min(5, Number(message.concurrency || currentConcurrency)));
      await chrome.storage.local.set({
        serverUrl: currentServerUrl,
        concurrency: currentConcurrency,
        keyword: message.keyword || "贵阳商学院",
        platformUrls: message.platformUrls || {},
      });
      sendResponse({ ok: true });
      return;
    }

    if (message.action === "TEST_SCREENSHOT") {
      currentServerUrl = message.serverUrl || currentServerUrl;
      const keyword = message.keyword || "贵阳商学院";
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
      const health = await api("/health").catch(() => null);
      if (health && health.stats && !health.stats.pending) {
        sendResponse({
          ok: false,
          running: false,
          message: "没有待执行任务。请先点“重置失败任务”，或更换/重建 Excel 任务。",
          stats: health.stats,
        });
        return;
      }
      running = true;
      pump();
      sendResponse({ ok: true, running, concurrency: currentConcurrency, stats: health ? health.stats : undefined });
      return;
    }

    if (message.action === "RESET_FAILED_TASKS") {
      sendResponse(await api("/reset-failed-tasks", { method: "POST", body: JSON.stringify({}) }));
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
