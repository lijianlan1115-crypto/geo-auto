const serverUrlInput = document.getElementById("serverUrl");
const concurrencyInput = document.getElementById("concurrency");
const keywordInput = document.getElementById("keyword");
const logEl = document.getElementById("log");

function log(message) {
  logEl.textContent = message;
}

async function send(action, payload = {}) {
  return chrome.runtime.sendMessage({ action, ...payload });
}

document.getElementById("health").addEventListener("click", async () => {
  const serverUrl = serverUrlInput.value.replace(/\/$/, "");
  const result = await send("HEALTH", { serverUrl });
  log(JSON.stringify(result, null, 2));
});

document.getElementById("testShot").addEventListener("click", async () => {
  const serverUrl = serverUrlInput.value.replace(/\/$/, "");
  const keyword = keywordInput.value.trim() || "贵阳商学院";
  const result = await send("TEST_SCREENSHOT", { serverUrl, keyword });
  log(JSON.stringify(result, null, 2));
});

document.getElementById("mockUrls").addEventListener("click", async () => {
  const serverUrl = serverUrlInput.value.replace(/\/$/, "");
  const concurrency = Number(concurrencyInput.value || 3);
  const keyword = keywordInput.value.trim() || "贵阳商学院";
  const platformUrls = {
    doubao: `${serverUrl}/mock-platform`,
    qianwen: `${serverUrl}/mock-platform`,
    deepseek: `${serverUrl}/mock-platform`,
    yuanbao: `${serverUrl}/mock-platform`,
    wenxin: `${serverUrl}/mock-platform`,
  };
  const result = await send("SAVE_SETTINGS", { serverUrl, concurrency, keyword, platformUrls });
  log(JSON.stringify({ ...result, platformUrls }, null, 2));
});

document.getElementById("realUrls").addEventListener("click", async () => {
  const serverUrl = serverUrlInput.value.replace(/\/$/, "");
  const concurrency = Number(concurrencyInput.value || 3);
  const keyword = keywordInput.value.trim() || "贵阳商学院";
  const platformUrls = {
    doubao: "https://www.doubao.com/chat/",
    qianwen: "https://tongyi.aliyun.com/qianwen/",
    deepseek: "https://chat.deepseek.com/",
    yuanbao: "https://yuanbao.tencent.com/chat/",
    wenxin: "https://chat.baidu.com/?enter_type=yiyan_site",
  };
  const result = await send("SAVE_SETTINGS", { serverUrl, concurrency, keyword, platformUrls });
  log(JSON.stringify({ ...result, platformUrls }, null, 2));
});

document.getElementById("reloadPage").addEventListener("click", async () => {
  const result = await send("RELOAD_ACTIVE_TAB");
  log(JSON.stringify(result, null, 2));
});

document.getElementById("reloadExtension").addEventListener("click", async () => {
  const result = await send("RELOAD_EXTENSION");
  log(JSON.stringify(result, null, 2));
});

document.getElementById("resetFailed").addEventListener("click", async () => {
  const result = await send("RESET_FAILED_TASKS");
  log(JSON.stringify(result, null, 2));
});

document.getElementById("start").addEventListener("click", async () => {
  const serverUrl = serverUrlInput.value.replace(/\/$/, "");
  const concurrency = Number(concurrencyInput.value || 3);
  const keyword = keywordInput.value.trim() || "贵阳商学院";
  await chrome.storage.local.set({ serverUrl, concurrency, keyword });
  const result = await send("START", { serverUrl, concurrency });
  log(JSON.stringify(result, null, 2));
});

document.getElementById("openLoginTabs").addEventListener("click", async () => {
  const serverUrl = serverUrlInput.value.replace(/\/$/, "");
  const concurrency = Number(concurrencyInput.value || 3);
  const keyword = keywordInput.value.trim() || "贵阳商学院";
  await chrome.storage.local.set({ serverUrl, concurrency, keyword });
  const result = await send("OPEN_LOGIN_TABS");
  log(JSON.stringify(result, null, 2));
});

document.getElementById("stop").addEventListener("click", async () => {
  const result = await send("STOP");
  log(JSON.stringify(result, null, 2));
});

chrome.storage.local.get(["serverUrl", "concurrency", "keyword"], (data) => {
  if (data.serverUrl) serverUrlInput.value = data.serverUrl;
  if (data.concurrency) concurrencyInput.value = data.concurrency;
  if (data.keyword) keywordInput.value = data.keyword;
});
