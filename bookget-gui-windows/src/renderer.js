const bridge = window.bookgetBridge;

const MAX_RECENT = 8;
const LOG_LIMIT = 240000;

const defaultSettings = {
  urlText: "",
  saveDirectory: "",
  needLogin: false,
  showAdvanced: false,
  appMode: "0",
  concurrency: "2",
  retries: "3",
  seq: "",
  vol: "",
  captureInterval: "",
  fileExt: "_",
  userAgent: "",
  cookieFilePath: "",
  localStorageFilePath: "",
  recentUrls: [],
  recentDirectories: [],
};

const state = {
  appMeta: "",
  supportedSites: [],
  settings: { ...defaultSettings },
  runState: "idle",
  queue: [],
  logText: "",
};

const el = {};

function bindElements() {
  [
    "appMeta",
    "urlText",
    "saveDirectory",
    "needLogin",
    "advancedBlock",
    "appMode",
    "concurrency",
    "retries",
    "seq",
    "vol",
    "captureInterval",
    "fileExt",
    "userAgent",
    "cookieFilePath",
    "localStorageFilePath",
    "recentUrlsSelect",
    "recentDirsSelect",
    "btnInsertRecentUrl",
    "btnUseRecentDir",
    "btnPickDir",
    "btnStart",
    "btnPause",
    "btnResume",
    "btnStop",
    "btnExportLog",
    "btnRestoreLast",
    "btnResetAll",
    "btnClearRecent",
    "btnSupportedSites",
    "btnHelp",
    "statePill",
    "statusLine",
    "statTotal",
    "statDone",
    "statStopped",
    "statFailed",
    "queueList",
    "logBox",
    "sitesDialog",
    "siteSearch",
    "siteList",
    "helpDialog",
  ].forEach((id) => {
    el[id] = document.getElementById(id);
  });
}

function setStatus(text) {
  el.statusLine.textContent = text;
}

function setStatePill(runState) {
  state.runState = runState;
  const map = {
    idle: "就绪",
    running: "下载中",
    retrying: "重试中",
    paused: "已暂停",
    stopped: "已终止",
    completed: "已完成",
    failed: "已完成（有失败）",
  };
  el.statePill.textContent = map[runState] || runState;
}

function buttonDisabledOnRun(isRunning) {
  el.btnStart.disabled = isRunning;
  el.btnPause.disabled = !isRunning;
  el.btnStop.disabled = !isRunning && state.runState !== "paused";
  el.btnResume.disabled = state.runState !== "paused";
}

function mergeSettings(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    ...defaultSettings,
    ...src,
    recentUrls: Array.isArray(src.recentUrls) ? src.recentUrls.slice(0, MAX_RECENT) : [],
    recentDirectories: Array.isArray(src.recentDirectories) ? src.recentDirectories.slice(0, MAX_RECENT) : [],
  };
}

function applySettingsToUI(next) {
  state.settings = mergeSettings(next);
  el.urlText.value = state.settings.urlText || "";
  el.saveDirectory.value = state.settings.saveDirectory || "";
  el.needLogin.checked = Boolean(state.settings.needLogin);
  el.advancedBlock.open = Boolean(state.settings.showAdvanced);
  el.appMode.value = state.settings.appMode || "0";
  el.concurrency.value = state.settings.concurrency || "2";
  el.retries.value = state.settings.retries || "3";
  el.seq.value = state.settings.seq || "";
  el.vol.value = state.settings.vol || "";
  el.captureInterval.value = state.settings.captureInterval || "";
  el.fileExt.value = state.settings.fileExt || "_";
  el.userAgent.value = state.settings.userAgent || "";
  el.cookieFilePath.value = state.settings.cookieFilePath || "";
  el.localStorageFilePath.value = state.settings.localStorageFilePath || "";

  renderRecentSelects();
}

function snapshotSettingsFromUI() {
  return {
    urlText: el.urlText.value,
    saveDirectory: el.saveDirectory.value.trim(),
    needLogin: el.needLogin.checked,
    showAdvanced: el.advancedBlock.open,
    appMode: el.appMode.value.trim(),
    concurrency: el.concurrency.value.trim(),
    retries: el.retries.value.trim(),
    seq: el.seq.value.trim(),
    vol: el.vol.value.trim(),
    captureInterval: el.captureInterval.value.trim(),
    fileExt: el.fileExt.value.trim() || "_",
    userAgent: el.userAgent.value.trim(),
    cookieFilePath: el.cookieFilePath.value.trim(),
    localStorageFilePath: el.localStorageFilePath.value.trim(),
    recentUrls: state.settings.recentUrls.slice(0, MAX_RECENT),
    recentDirectories: state.settings.recentDirectories.slice(0, MAX_RECENT),
  };
}

function saveSettings() {
  const snap = snapshotSettingsFromUI();
  state.settings = snap;
  return bridge.saveSettings({ bookgetWindowsGUI: snap });
}

function addRecent(list, value) {
  const v = String(value || "").trim();
  if (!v) return list.slice(0, MAX_RECENT);
  const next = [v, ...list.filter((x) => x !== v)];
  return next.slice(0, MAX_RECENT);
}

function renderRecentSelects() {
  const urlSelect = el.recentUrlsSelect;
  const dirSelect = el.recentDirsSelect;

  urlSelect.innerHTML = `<option value="">选择最近网址...</option>`;
  state.settings.recentUrls.forEach((item) => {
    const opt = document.createElement("option");
    opt.value = item;
    opt.textContent = item.length > 90 ? `${item.slice(0, 90)}...` : item;
    urlSelect.appendChild(opt);
  });

  dirSelect.innerHTML = `<option value="">选择最近目录...</option>`;
  state.settings.recentDirectories.forEach((item) => {
    const opt = document.createElement("option");
    opt.value = item;
    opt.textContent = item;
    dirSelect.appendChild(opt);
  });
}

function parseURLs(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function escapeHtml(v) {
  return String(v || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderQueue(queue) {
  state.queue = Array.isArray(queue) ? queue : [];
  const html = state.queue
    .map((item, idx) => {
      const statusClass = escapeHtml(item.state || "waiting");
      return `
        <article class="queue-item">
          <div class="url">${idx + 1}. ${escapeHtml(item.url || "")}</div>
          <div class="meta">
            <span>${escapeHtml(item.note || "")}</span>
            <span class="tag ${statusClass}">${escapeHtml(item.state || "waiting")}</span>
          </div>
        </article>
      `;
    })
    .join("");

  el.queueList.innerHTML = html || `<div class="mono">暂无任务</div>`;

  const total = state.queue.length;
  const done = state.queue.filter((i) => i.state === "succeeded").length;
  const stopped = state.queue.filter((i) => i.state === "stopped").length;
  const failed = state.queue.filter((i) => i.state === "failed").length;

  el.statTotal.textContent = `总 ${total}`;
  el.statDone.textContent = `完成 ${done}`;
  el.statStopped.textContent = `终止 ${stopped}`;
  el.statFailed.textContent = `失败 ${failed}`;
}

function appendLog(chunk) {
  const text = String(chunk || "");
  if (!text) return;
  state.logText += text;
  if (state.logText.length > LOG_LIMIT) {
    state.logText = state.logText.slice(-Math.floor(LOG_LIMIT * 0.75));
  }
  el.logBox.textContent = state.logText;
  el.logBox.scrollTop = el.logBox.scrollHeight;
}

function resetRuntimeView() {
  state.logText = "";
  el.logBox.textContent = "";
  renderQueue([]);
  setStatus("就绪");
  setStatePill("idle");
  buttonDisabledOnRun(false);
}

function updateButtonsByState() {
  const running = state.runState === "running" || state.runState === "retrying";
  buttonDisabledOnRun(running);
  if (state.runState === "paused") {
    el.btnResume.disabled = false;
  }
}

function renderSites(keyword = "") {
  const query = keyword.trim().toLowerCase();
  const list = state.supportedSites.filter((site) => {
    if (!query) return true;
    return (
      String(site.name || "").toLowerCase().includes(query) ||
      String(site.url || "").toLowerCase().includes(query) ||
      String(site.note || "").toLowerCase().includes(query)
    );
  });

  el.siteList.innerHTML = list
    .map((site) => {
      return `
        <article class="site-item">
          <h4>${escapeHtml(site.name || "")}</h4>
          <a href="#" data-url="${escapeHtml(site.url || "")}">${escapeHtml(site.url || "")}</a>
          <p>${escapeHtml(site.note || "")}</p>
        </article>
      `;
    })
    .join("") || `<div class="mono">无匹配站点</div>`;
}

async function startTask() {
  const urls = parseURLs(el.urlText.value);
  const outputDirectory = el.saveDirectory.value.trim();

  if (!urls.length) {
    setStatus("请至少输入一个网址。\n");
    return;
  }
  if (!outputDirectory) {
    setStatus("请选择保存目录。\n");
    return;
  }

  const options = {
    outputDirectory,
    needLogin: el.needLogin.checked,
    showAdvanced: el.advancedBlock.open,
    appMode: el.appMode.value.trim() || "0",
    concurrency: el.concurrency.value.trim() || "2",
    retries: el.retries.value.trim() || "3",
    seq: el.seq.value.trim(),
    vol: el.vol.value.trim(),
    captureInterval: el.captureInterval.value.trim(),
    fileExt: el.fileExt.value.trim() || "_",
    userAgent: el.userAgent.value.trim(),
    cookieFilePath: el.cookieFilePath.value.trim(),
    localStorageFilePath: el.localStorageFilePath.value.trim(),
  };

  state.settings.recentUrls = addRecent(state.settings.recentUrls, el.urlText.value.trim());
  state.settings.recentDirectories = addRecent(state.settings.recentDirectories, outputDirectory);
  renderRecentSelects();

  await saveSettings();

  await bridge.startDownload({ urls, options });
}

function bindActions() {
  el.btnPickDir.addEventListener("click", async () => {
    const picked = await bridge.pickDirectory(el.saveDirectory.value.trim());
    if (picked) {
      el.saveDirectory.value = picked;
      state.settings.recentDirectories = addRecent(state.settings.recentDirectories, picked);
      renderRecentSelects();
      saveSettings();
    }
  });

  el.btnInsertRecentUrl.addEventListener("click", () => {
    const v = el.recentUrlsSelect.value;
    if (!v) return;
    const base = el.urlText.value.trim();
    el.urlText.value = base ? `${base}\n${v}` : v;
  });

  el.btnUseRecentDir.addEventListener("click", () => {
    const v = el.recentDirsSelect.value;
    if (!v) return;
    el.saveDirectory.value = v;
  });

  el.btnStart.addEventListener("click", () => {
    startTask().catch((error) => {
      setStatus(`启动失败：${error.message || String(error)}`);
    });
  });

  el.btnPause.addEventListener("click", async () => {
    await bridge.pauseDownload();
  });

  el.btnResume.addEventListener("click", async () => {
    const options = {
      outputDirectory: el.saveDirectory.value.trim(),
      needLogin: el.needLogin.checked,
      showAdvanced: el.advancedBlock.open,
      appMode: el.appMode.value.trim() || "0",
      concurrency: el.concurrency.value.trim() || "2",
      retries: el.retries.value.trim() || "3",
      seq: el.seq.value.trim(),
      vol: el.vol.value.trim(),
      captureInterval: el.captureInterval.value.trim(),
      fileExt: el.fileExt.value.trim() || "_",
      userAgent: el.userAgent.value.trim(),
      cookieFilePath: el.cookieFilePath.value.trim(),
      localStorageFilePath: el.localStorageFilePath.value.trim(),
    };
    await bridge.resumeDownload({ options });
  });

  el.btnStop.addEventListener("click", async () => {
    await bridge.stopDownload();
  });

  el.btnExportLog.addEventListener("click", async () => {
    const out = await bridge.exportLog(el.saveDirectory.value.trim());
    if (out?.ok) {
      setStatus(`日志已导出：${out.path}`);
    } else {
      setStatus(out?.error || "日志导出失败。");
    }
  });

  el.btnRestoreLast.addEventListener("click", async () => {
    const boot = await bridge.bootstrap();
    const saved = mergeSettings(boot.settings?.bookgetWindowsGUI || {});
    applySettingsToUI(saved);
    setStatus("已恢复上次设置。");
  });

  el.btnResetAll.addEventListener("click", async () => {
    applySettingsToUI(defaultSettings);
    resetRuntimeView();
    await saveSettings();
  });

  el.btnClearRecent.addEventListener("click", async () => {
    state.settings.recentUrls = [];
    state.settings.recentDirectories = [];
    renderRecentSelects();
    await saveSettings();
  });

  el.btnSupportedSites.addEventListener("click", () => {
    el.siteSearch.value = "";
    renderSites("");
    el.sitesDialog.showModal();
  });

  el.siteSearch.addEventListener("input", () => {
    renderSites(el.siteSearch.value);
  });

  el.siteList.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.tagName.toLowerCase() === "a") {
      event.preventDefault();
      const url = target.dataset.url;
      if (url) {
        bridge.openExternal(url);
      }
    }
  });

  el.btnHelp.addEventListener("click", () => {
    el.helpDialog.showModal();
  });
}

function bindRunnerEvents() {
  bridge.onRunnerEvent((event) => {
    const { type, payload } = event || {};
    if (type === "state") {
      const runState = payload?.state || "idle";
      const detail = payload?.detail || "";
      setStatePill(runState);
      setStatus(detail);
      updateButtonsByState();
      return;
    }

    if (type === "queue") {
      renderQueue(payload?.queue || []);
      return;
    }

    if (type === "log") {
      appendLog(payload?.chunk || "");
      return;
    }

    if (type === "task-started") {
      const idx = payload?.index || 0;
      const total = payload?.total || 0;
      setStatus(`下载中 (${idx}/${total})`);
      return;
    }

    if (type === "task-finished") {
      return;
    }
  });
}

async function bootstrap() {
  bindElements();
  bindActions();
  bindRunnerEvents();

  const boot = await bridge.bootstrap();
  state.supportedSites = Array.isArray(boot.supportedSites) ? boot.supportedSites : [];
  state.appMeta = `${boot.appName} · ${boot.platform} · bin: ${boot.binDir}`;
  el.appMeta.textContent = state.appMeta;

  const saved = mergeSettings(boot.settings?.bookgetWindowsGUI || {});
  if (!saved.saveDirectory) {
    saved.saveDirectory = boot.defaultOutputDir || "";
  }
  applySettingsToUI(saved);

  const snapshot = await bridge.getSnapshot();
  setStatePill(snapshot?.state || "idle");
  renderQueue(snapshot?.queue || []);
  updateButtonsByState();

  setStatus("就绪");
}

bootstrap().catch((error) => {
  console.error(error);
  document.body.innerHTML = `<pre style=\"color:#fff;padding:16px\">启动失败: ${escapeHtml(error.message || String(error))}</pre>`;
});
