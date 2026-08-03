const notifyScheduler = () => {
  chrome.runtime.sendMessage({ action: "GEO_KEEPALIVE" }).catch(() => null);
};

notifyScheduler();
setInterval(notifyScheduler, 15000);
