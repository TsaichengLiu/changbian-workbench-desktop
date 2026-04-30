const path = require("path");
const fs = require("fs");
const os = require("os");
const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");

const { loadSupportedSites } = require("./supported-sites.cjs");
const {
  BookGetTaskRunner,
  splitUrls,
  toNetscapeCookieLines,
  hostMatchesCookieDomain,
  hostKeyOf,
} = require("./task-runner.cjs");

const APP_NAME = "BookGet GUI (Windows)";
const SETTINGS_FILE = path.join(app.getPath("userData"), "settings.json");

let mainWindow = null;

function isDevMode() {
  return !app.isPackaged;
}

function appRoot() {
  return app.getAppPath();
}

function resourceBinDir() {
  return isDevMode() ? path.join(appRoot(), "resources", "bin") : path.join(process.resourcesPath, "bin");
}

function readSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) {
      return {};
    }
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeSettings(next) {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

function resolveUIFile(name) {
  return path.join(appRoot(), "src", name);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1420,
    height: 900,
    minWidth: 1180,
    minHeight: 760,
    title: APP_NAME,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      sandbox: false,
    },
  });

  const entryFile = resolveUIFile("index.html");
  mainWindow.loadFile(entryFile).catch((error) => {
    const detail = String(error?.message || error || "unknown error");
    const html = `
      <html>
        <body style="font-family:Segoe UI,Microsoft YaHei,sans-serif;padding:16px;background:#0f1a2a;color:#f3f6fb">
          <h3>UI load failed</h3>
          <pre style="white-space:pre-wrap">${detail.replace(/[<>&]/g, (s) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[s]))}</pre>
          <p style="opacity:.8">entry: ${entryFile.replace(/[<>&]/g, (s) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[s]))}</p>
        </body>
      </html>
    `;
    mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  });

  if (isDevMode()) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function exportCookiesToTemp(session, targetURL) {
  const host = hostKeyOf(targetURL);
  let cookies = [];

  try {
    cookies = await session.cookies.get({});
  } catch {
    cookies = [];
  }

  if (host) {
    cookies = cookies.filter((c) => hostMatchesCookieDomain(host, c.domain));
  }

  if (!cookies.length) {
    try {
      cookies = await session.cookies.get({ url: targetURL });
    } catch {
      cookies = [];
    }
  }

  const file = path.join(os.tmpdir(), `bookget_auto_cookie_${Date.now()}_${Math.random().toString(16).slice(2)}.txt`);
  fs.writeFileSync(file, toNetscapeCookieLines(cookies), "utf8");
  return file;
}

const popupWindows = new Map();

async function openLoginPopup({ url, title, hint, mode }) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 1320,
      height: 920,
      minWidth: 980,
      minHeight: 720,
      parent: mainWindow || undefined,
      modal: false,
      autoHideMenuBar: true,
      title: `${title} - F8 完成 / Esc 取消`,
      webPreferences: {
        preload: path.join(__dirname, "popup-preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    popupWindows.set(win.id, win);

    let settled = false;

    const settle = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };

    const closeWithCancel = () => {
      settle({ cancelled: true, cookiePath: "", finalUrl: "", windowId: null });
      if (!win.isDestroyed()) {
        win.destroy();
      }
    };

    win.webContents.on("before-input-event", async (event, input) => {
      if (input.key === "Escape") {
        event.preventDefault();
        closeWithCancel();
        return;
      }

      if (input.key === "F8") {
        event.preventDefault();
        const finalUrl = win.webContents.getURL() || url;
        const cookiePath = await exportCookiesToTemp(win.webContents.session, finalUrl);

        if (mode === "login") {
          settle({ cancelled: false, cookiePath, finalUrl, windowId: null });
          if (!win.isDestroyed()) {
            win.destroy();
          }
          return;
        }

        settle({ cancelled: false, cookiePath, finalUrl, windowId: win.id });
        win.setTitle(`${title} - 抓页进行中，请勿关闭窗口`);
      }
    });

    win.on("closed", () => {
      popupWindows.delete(win.id);
      if (!settled) {
        settle({ cancelled: true, cookiePath: "", finalUrl: "", windowId: null });
      }
    });

    win.webContents.on("did-finish-load", () => {
      win.webContents.send("popup:init", { hint, startUrl: url });
    });

    win.loadURL(url).catch(() => {
      closeWithCancel();
    });
  });
}

async function scrapeRbookFromWindow({ windowId, outDir, intervalSeconds }) {
  const win = popupWindows.get(windowId) || BrowserWindow.fromId(windowId);
  if (!win || win.isDestroyed()) {
    return { ok: false, error: "popup window not found" };
  }

  const wc = win.webContents;

  const readyScript = "document.querySelector('#ImageDisplay') != null && document.querySelector('#sel-content-no') != null";
  let ready = false;
  for (let i = 0; i < 45; i += 1) {
    try {
      ready = Boolean(await wc.executeJavaScript(readyScript, true));
    } catch {
      ready = false;
    }
    if (ready) break;

    try {
      await wc.executeJavaScript(
        `
        (function(){
          function abs(u){ try { return new URL(u, document.baseURI).toString(); } catch(e) { return ''; } }
          function getUrl(el){
            if (!el) return '';
            var href = el.getAttribute('href') || '';
            if (href && href !== '#' && href.indexOf('javascript:') !== 0) return abs(href);
            var du = el.getAttribute('data-url') || el.getAttribute('data-href') || '';
            if (du) return abs(du);
            var on = el.getAttribute('onclick') || '';
            var m = on.match(/(?:window\\.open|location\\.href|location\\.assign)\\(['\"]([^'\"]+)['\"]/);
            if (m && m[1]) return abs(m[1]);
            return '';
          }
          var sel = '.btn.btn-default.bg-malachite-green.text-white.mr-5px';
          var b = document.querySelector(sel);
          var u = getUrl(b);
          if (u) { location.href = u; return u; }
          if (b) { try { b.click(); return 'clicked'; } catch(e) {} }
          return '';
        })();
        `,
        true
      );
    } catch {
      // Ignore and retry.
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!ready) {
    return { ok: false, error: "viewer not ready" };
  }

  fs.mkdirSync(outDir, { recursive: true });

  let retryCount = 0;
  for (;;) {
    const payload = await wc.executeJavaScript(
      `
      (function(){
        var img = document.querySelector('#ImageDisplay');
        var sel = document.querySelector('#sel-content-no');
        var totalEl = document.querySelector('span.total-page');
        var pageNum = '';
        if (sel && sel.selectedOptions && sel.selectedOptions[0]) {
          pageNum = (sel.selectedOptions[0].textContent || '').trim();
        }
        var totalPages = '';
        if (totalEl) {
          totalPages = (totalEl.textContent || '').trim().replace('/ ', '').replace('/', '');
        }
        var w = img ? (img.naturalWidth || 0) : 0;
        var h = img ? (img.naturalHeight || 0) : 0;
        var dataUrl = '';
        if (img && w > 0 && h > 0) {
          try {
            var canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            var ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, w, h);
            dataUrl = canvas.toDataURL('image/png');
            if (dataUrl.indexOf('data:image/png;base64,') === 0) {
              dataUrl = dataUrl.substring('data:image/png;base64,'.length);
            } else {
              dataUrl = '';
            }
          } catch (e) {
            dataUrl = '';
          }
        }
        return { pageNum: pageNum, totalPages: totalPages, width: w, height: h, dataUrl: dataUrl };
      })();
      `,
      true
    );

    const pageNum = String(payload?.pageNum || "").trim();
    const totalPages = String(payload?.totalPages || "").trim();
    const w = Number(payload?.width || 0);
    const h = Number(payload?.height || 0);
    const dataUrl = String(payload?.dataUrl || "");

    if (!pageNum || !totalPages || w <= 0 || h <= 0 || dataUrl.length < 200) {
      retryCount += 1;
      if (retryCount >= 240) {
        return { ok: false, error: "page render timeout" };
      }
      await new Promise((r) => setTimeout(r, Math.min(2000, Math.max(500, (Number(intervalSeconds) || 2) * 500))));
      continue;
    }

    retryCount = 0;
    const file = path.join(outDir, `第${pageNum}頁.png`);
    const bin = Buffer.from(dataUrl, "base64");
    fs.writeFileSync(file, bin);

    if (pageNum === totalPages) {
      if (!win.isDestroyed()) {
        win.destroy();
      }
      return { ok: true };
    }

    await wc.executeJavaScript("var b=document.getElementById('AftT'); if (b) { b.click(); true } else { false; }", true);
    await new Promise((r) => setTimeout(r, Math.max(500, Number(intervalSeconds || 2) * 1000)));
  }
}

const runner = new BookGetTaskRunner({
  getBinDir: resourceBinDir,
  openLoginPopup,
  ensureCookiesForWindow: async (request) => {
    if (request.mode === "rbook") {
      return scrapeRbookFromWindow(request);
    }
    return { ok: false, error: "unsupported mode" };
  },
});

runner.on("event", ({ type, payload, ts }) => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send("runner:event", { type, payload, ts });
});

function registerIPC() {
  ipcMain.handle("app:bootstrap", async () => {
    const settings = readSettings();
    const supportedSites = loadSupportedSites(appRoot());
    return {
      appName: APP_NAME,
      platform: process.platform,
      defaultOutputDir: app.getPath("downloads"),
      settings,
      supportedSites,
      binDir: resourceBinDir(),
    };
  });

  ipcMain.handle("settings:save", async (_event, settingsPatch) => {
    const current = readSettings();
    const merged = { ...current, ...(settingsPatch || {}) };
    const ok = writeSettings(merged);
    return { ok, settings: merged };
  });

  ipcMain.handle("dialog:pick-directory", async (_event, defaultPath) => {
    const result = await dialog.showOpenDialog(mainWindow || undefined, {
      title: "选择保存目录",
      defaultPath: defaultPath || app.getPath("downloads"),
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths?.length) {
      return "";
    }
    return result.filePaths[0];
  });

  ipcMain.handle("download:start", async (_event, payload) => {
    const options = payload?.options || {};
    const urls = Array.isArray(payload?.urls) ? payload.urls : splitUrls(payload?.urlText || "");
    runner.start({ urls, options });
    return { ok: true };
  });

  ipcMain.handle("download:pause", async () => {
    runner.pause();
    return { ok: true };
  });

  ipcMain.handle("download:resume", async (_event, payload) => {
    runner.resume(payload?.options || null);
    return { ok: true };
  });

  ipcMain.handle("download:stop", async () => {
    runner.stop();
    return { ok: true };
  });

  ipcMain.handle("download:snapshot", async () => {
    return runner.getSnapshot();
  });

  ipcMain.handle("download:export-log", async (_event, targetDir) => {
    const snapshot = runner.getSnapshot();
    const fullLog = runner.currentRun?.fullLog || "";
    if (!fullLog) {
      return { ok: false, error: "当前没有可导出的任务日志。" };
    }
    const outDir = targetDir || app.getPath("downloads");
    const file = path.join(outDir, `bookget_task_${Date.now()}.log`);
    fs.writeFileSync(file, fullLog, "utf8");
    return { ok: true, path: file, snapshot };
  });

  ipcMain.handle("open:external", async (_event, url) => {
    if (!url) return false;
    await shell.openExternal(url);
    return true;
  });
}

app.whenReady().then(() => {
  registerIPC();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
