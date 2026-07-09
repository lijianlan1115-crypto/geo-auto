// 平台识别兜底补丁：
// 即使用户在插件里手动新增平台，名称/URL 像千问、元宝等，也自动归一到内置平台 key。
// 这样后续输入框、发送按钮、回答区域、追问逻辑都会走专门适配规则，而不是 custom_xxx 通用规则。
(function () {
  function canonicalPlatformKey(value, name, url) {
    const text = `${value || ""} ${name || ""} ${url || ""}`.toLowerCase();

    if (/doubao|豆包|www\.doubao\.com|doubao\.com/.test(text)) return "doubao";
    if (/qianwen|千问|通义|tongyi\.aliyun\.com|aliyun\.com\/qianwen/.test(text)) return "qianwen";
    if (/deepseek|深度求索|chat\.deepseek\.com/.test(text)) return "deepseek";
    if (/yuanbao|元宝|腾讯元宝|yuanbao\.tencent\.com/.test(text)) return "yuanbao";
    if (/wenxin|文心|一言|yiyan|chat\.baidu\.com|baidu\.com/.test(text)) return "wenxin";

    return value || "doubao";
  }

  function normalizeTaskPlatform(task) {
    if (!task || typeof task !== "object") return task;

    const originalPlatform = task.platform || "";
    const canonical = canonicalPlatformKey(
      task.platform,
      task.platform_name,
      task.platform_url || task.url
    );

    if (canonical && canonical !== originalPlatform) {
      task.original_platform = originalPlatform;
      task.platform = canonical;
      task.platform_normalized = true;
    }

    return task;
  }

  function normalizePlatformRows() {
    const root = document.getElementById("geo-auto-root");
    const shadow = root && root.shadowRoot;
    if (!shadow) return;

    shadow.querySelectorAll(".platform-row").forEach((row, index) => {
      const nameInput = row.querySelector("[data-platform-name]");
      const urlInput = row.querySelector("[data-platform-url]");
      const name = nameInput ? nameInput.value : "";
      const url = urlInput ? urlInput.value : "";
      const current = row.dataset.platformKey || `custom_${index + 1}`;
      const canonical = canonicalPlatformKey(current, name, url);

      if (canonical && canonical !== current) {
        row.dataset.originalPlatformKey = current;
        row.dataset.platformKey = canonical;
      }
    });
  }

  function installPanelNormalizer() {
    const root = document.getElementById("geo-auto-root");
    const shadow = root && root.shadowRoot;
    if (!shadow || shadow.__geoPlatformRowsNormalized) return;
    shadow.__geoPlatformRowsNormalized = true;

    normalizePlatformRows();
    shadow.addEventListener("input", normalizePlatformRows, true);
    shadow.addEventListener("change", normalizePlatformRows, true);
    shadow.addEventListener("click", () => setTimeout(normalizePlatformRows, 0), true);

    const platformsBox = shadow.querySelector("[data-platforms]");
    if (platformsBox && window.MutationObserver) {
      const observer = new MutationObserver(() => normalizePlatformRows());
      observer.observe(platformsBox, { childList: true, subtree: true, attributes: true });
    }
  }

  function wrapRunner() {
    if (!window.geoAutomationRun || window.__geoPlatformPatchWrapped) return;
    const originalRun = window.geoAutomationRun;
    window.geoAutomationRun = async function geoAutomationRunWithPlatformNormalize(task) {
      return await originalRun(normalizeTaskPlatform(task));
    };
    window.__geoPlatformPatchWrapped = true;
  }

  function installAll() {
    wrapRunner();
    installPanelNormalizer();
    normalizePlatformRows();
  }

  installAll();
  setTimeout(installAll, 0);
  setTimeout(installAll, 500);
  setInterval(installAll, 2000);
})();
