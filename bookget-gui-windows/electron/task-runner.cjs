const { EventEmitter } = require("events");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");

const SPECIAL_RUN_NOT_HANDLED = 111;
const LOGIN_CANCEL_CODE = 130;

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";

function nowStamp() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${y}${m}${dd}_${hh}${mm}${ss}`;
}

function sanitizeFilename(raw, fallback = "item") {
  const s = String(raw || "").trim();
  if (!s) return fallback;
  const mapped = s.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_+/g, "_").replace(/^[_\-.]+|[_\-.]+$/g, "");
  return mapped || fallback;
}

function normalizeIntervalValue(raw) {
  if (raw == null) return "";
  const v = String(raw).trim().replace(/,/g, ".");
  if (!v) return "";
  if (!/^\d+(\.\d+)?$/.test(v)) return "";
  return v;
}

function isTransportErrorLog(logText) {
  const re =
    /(?:dial tcp|no such host|i\/o timeout|context deadline exceeded|tls handshake timeout|connection refused|connection reset|network is unreachable|server misbehaving|\sEOF\b)/i;
  return re.test(logText || "");
}

function isUnsupportedUrlLog(logText) {
  return /unsupported url|处理url失败/i.test(logText || "");
}

function isNameConflictLog(logText) {
  const s = String(logText || "").toLowerCase();
  if (/(已存在|already exists|file exists|同名|重名)/i.test(s)) {
    return true;
  }
  if (s.includes("download complete") && !s.includes("saved") && !s.includes("下载成功")) {
    return true;
  }
  return false;
}

function isUnknownFlagLog(logText, flagName) {
  const s = String(logText || "");
  if (!s) return false;
  const f = String(flagName || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`unknown\\s+shorthand\\s+flag:\\s*'${f}'\\s+in\\s+-${f}`, "i");
  return re.test(s);
}

function splitUrls(urlText) {
  return String(urlText || "")
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function hasNonPortablePathChars(value) {
  const s = String(value || "");
  if (!s) return false;
  return /[\s\u0080-\uffff]/.test(s);
}

function uniqueList(items) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const v = String(item || "").trim();
    if (!v) continue;
    const key = path.resolve(v).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function copyFileIfNeeded(src, dst) {
  if (!fs.existsSync(src)) return false;
  let needCopy = true;
  if (fs.existsSync(dst)) {
    try {
      const a = fs.statSync(src);
      const b = fs.statSync(dst);
      if (a.size === b.size && a.mtimeMs <= b.mtimeMs + 500) {
        needCopy = false;
      }
    } catch {
      needCopy = true;
    }
  }
  if (needCopy) {
    fs.copyFileSync(src, dst);
  }
  return true;
}

function isLikelyHTTP(url) {
  return /^https?:\/\//i.test(url || "");
}

function safeURL(input) {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function hostKeyOf(url) {
  const u = safeURL(url);
  return u ? u.hostname.toLowerCase() : "";
}

function parentDomain(host) {
  if (!host) return "";
  const parts = host.split(".");
  if (parts.length < 3) return "";
  return parts.slice(1).join(".");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeQingDisplayUrl(url) {
  const decoded = String(url || "").replace(/%2F/gi, "/");
  const objectMatch = decoded.match(/[?&]act=display\/(?:image|print)\/([^&#]+)/i);
  const objectCode = objectMatch ? objectMatch[1] : "";
  const hash = decoded.includes("#") ? decoded.split("#")[1] : "";
  const pageCode = (hash || "").replace(/[^A-Za-z0-9].*$/, "");
  return { objectCode, pageCode, entryNoHash: decoded.split("#")[0] };
}

function isQingDisplayUrl(url) {
  const d = String(url || "").replace(/%2F/gi, "/").toLowerCase();
  return d.includes("qingarchives.npm.edu.tw/index.php?act=display/image/") || d.includes("qingarchives.npm.edu.tw/index.php?act=display/print/");
}

function isShanghaiDetailUrl(url) {
  return String(url || "").toLowerCase().includes("gj.library.sh.cn/org/info/shl");
}

function isShanghaiPDFViewUrl(url) {
  const s = String(url || "").toLowerCase();
  return s.includes("dhapi.library.sh.cn/pdfview/") && s.includes("?");
}

function isRbookSearchDetailUrl(url) {
  return String(url || "").toLowerCase().includes("rbook.ncl.edu.tw/nclsearch/search/searchdetail");
}

function isNpmDigitalArchiveDetailUrl(url) {
  return String(url || "").toLowerCase().includes("digitalarchive.npm.gov.tw/collection/detail/");
}

function resolveNpmDigitalArchiveManifest(url) {
  if (!isNpmDigitalArchiveDetailUrl(url)) return url;
  const cid = (String(url).match(/collection\/detail\/(\d+)/i) || [])[1] || "";
  const depRaw = (String(url).match(/[?&]dep=([^&#]+)/i) || [])[1] || "P";
  const dep = depRaw.replace(/[^A-Za-z0-9._-].*$/, "") || "P";
  if (!cid) return url;
  return `https://digitalarchive.npm.gov.tw/Integrate/GetJson?cid=${cid}&dept=${dep}`;
}

function extractManifestCandidateFromPage(html) {
  const text = String(html || "")
    .replace(/\\\//g, "/")
    .replace(/\\u002[Ff]/g, "/")
    .replace(/&amp;/g, "&");

  const direct = text.match(/https?:\/\/[^"'\s]*(?:manifest\.json|\/manifest\b|:MANIFEST)[^"'\s]*/i);
  if (direct) return direct[0];

  const rel = text.match(/(?:href|content|data-iiif-manifest|data-manifest|iiif-manifest)=["']([^"']*(?:manifest\.json|:MANIFEST|\/manifest[^"']*)[^"']*)["']/i);
  if (rel) return rel[1];

  return "";
}

function normalizeCandidateURL(baseURL, candidate) {
  const raw = String(candidate || "")
    .trim()
    .replace(/\\\//g, "/")
    .replace(/\\u002[Ff]/g, "/")
    .replace(/&amp;/g, "&")
    .replace(/^['"]|['"]$/g, "");
  if (!raw) return "";

  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("//")) {
    const bu = safeURL(baseURL);
    const scheme = bu?.protocol || "https:";
    return `${scheme}${raw}`;
  }
  try {
    return new URL(raw, baseURL).toString();
  } catch {
    return "";
  }
}

function manifestLikely(url) {
  const s = String(url || "").toLowerCase();
  return s.includes(":manifest") || s.includes("manifest.json") || s.includes("/manifest") || s.includes("iiif") && s.includes("manifest");
}

function toNetscapeCookieLines(cookies) {
  const header = [
    "# Netscape HTTP Cookie File",
    "# Generated by BookGet GUI (Windows)",
    ""
  ];
  const lines = cookies.map((c) => {
    const domain = c.domain || "";
    const includeSubdomains = domain.startsWith(".") ? "TRUE" : "FALSE";
    const pathValue = c.path || "/";
    const secure = c.secure ? "TRUE" : "FALSE";
    const expires = Number.isFinite(c.expirationDate) ? String(Math.floor(c.expirationDate)) : "0";
    return [domain, includeSubdomains, pathValue, secure, expires, c.name || "", c.value || ""].join("\t");
  });
  return header.concat(lines).join("\n") + "\n";
}

function hostMatchesCookieDomain(host, domainRaw) {
  const h = String(host || "").toLowerCase();
  const d = String(domainRaw || "").toLowerCase().replace(/^\./, "");
  if (!h || !d) return false;
  if (h === d) return true;
  return h.endsWith(`.${d}`);
}

class BookGetTaskRunner extends EventEmitter {
  constructor(options) {
    super();
    this.getBinDir = options.getBinDir;
    this.openLoginPopup = options.openLoginPopup;
    this.ensureCookiesForWindow = options.ensureCookiesForWindow;

    this.state = "idle";
    this.currentChild = null;
    this.currentRun = null;
    this.pauseRequested = false;
    this.stopRequested = false;
    this.logBuffer = "";
    this.loginByHost = new Map();
    this.finalUrlByHost = new Map();
    this.runtimeBinCache = null;
    this.runtimeBinNoticeShown = false;
    this.coreCliStyle = "";
    this.coreCliStyleLogged = false;
  }

  getSnapshot() {
    if (!this.currentRun) {
      return {
        state: this.state,
        queue: [],
        run: null,
      };
    }
    return {
      state: this.state,
      queue: this.currentRun.queue,
      run: {
        id: this.currentRun.id,
        startedAt: this.currentRun.startedAt,
        failCount: this.currentRun.failCount,
        currentIndex: this.currentRun.currentIndex,
        total: this.currentRun.urls.length,
      },
    };
  }

  start(runInput) {
    if (this.state === "running" || this.state === "retrying") {
      throw new Error("任务正在运行，请先暂停或终止。");
    }

    const urls = Array.isArray(runInput.urls) ? runInput.urls.map((u) => String(u).trim()).filter(Boolean) : [];
    if (!urls.length) {
      throw new Error("请至少提供一个网址。");
    }

    this.pauseRequested = false;
    this.stopRequested = false;
    this.logBuffer = "";
    this.runtimeBinCache = null;
    this.runtimeBinNoticeShown = false;
    this.coreCliStyle = "";
    this.coreCliStyleLogged = false;

    this.currentRun = {
      id: randomUUID(),
      startedAt: new Date().toISOString(),
      options: { ...runInput.options },
      urls,
      queue: urls.map((url) => ({ url, state: "waiting", note: "等待中" })),
      failCount: 0,
      currentIndex: 0,
      modeTriedByIndex: {},
      modeOverrideByIndex: {},
      outputOverrideByIndex: {},
      conflictRetriedIndexes: {},
      fullLog: "",
    };

    this.state = "running";
    this.emitState("running", urls.length > 1 ? `任务已启动，准备批量下载 ${urls.length} 个网址...` : "任务已启动，正在下载...");
    this.emitQueue();

    this.runLoop().catch((error) => {
      this.emitLog(`[bookget windows gui] ${error?.message || String(error)}\n`);
      this.state = "failed";
      this.emitState("failed", "任务执行异常终止。请导出日志排查。", true);
    });
  }

  pause() {
    if (!(this.state === "running" || this.state === "retrying")) {
      return;
    }
    this.pauseRequested = true;
    if (this.currentChild) {
      this.currentChild.kill();
    }
  }

  resume(nextOptions) {
    if (this.state !== "paused" || !this.currentRun) {
      return;
    }
    if (nextOptions && typeof nextOptions === "object") {
      this.currentRun.options = { ...this.currentRun.options, ...nextOptions };
    }
    this.pauseRequested = false;
    this.stopRequested = false;
    this.state = "running";
    this.emitState("running", "已继续下载。");
    this.runLoop().catch((error) => {
      this.emitLog(`[bookget windows gui] ${error?.message || String(error)}\n`);
      this.state = "failed";
      this.emitState("failed", "任务执行异常终止。请导出日志排查。", true);
    });
  }

  stop() {
    if (!["running", "retrying", "paused"].includes(this.state)) {
      return;
    }
    this.stopRequested = true;
    this.pauseRequested = false;

    if (this.currentRun) {
      for (let i = this.currentRun.currentIndex; i < this.currentRun.queue.length; i += 1) {
        const item = this.currentRun.queue[i];
        if (["succeeded", "failed", "stopped"].includes(item.state)) {
          continue;
        }
        item.state = "stopped";
        item.note = "已终止";
      }
      this.emitQueue();
    }

    if (this.currentChild) {
      this.currentChild.kill();
      return;
    }

    this.state = "stopped";
    this.emitState("stopped", "任务已终止。", true);
  }

  async runLoop() {
    if (!this.currentRun) return;

    while (this.currentRun && this.currentRun.currentIndex < this.currentRun.urls.length) {
      if (this.stopRequested) {
        this.state = "stopped";
        this.emitState("stopped", "任务已终止。", true);
        return;
      }

      const idx = this.currentRun.currentIndex;
      const url = this.currentRun.urls[idx];
      const queueItem = this.currentRun.queue[idx];
      const itemLabel = `${idx + 1}/${this.currentRun.urls.length}`;

      queueItem.state = this.state === "retrying" ? "retrying" : "running";
      queueItem.note = this.state === "retrying" ? "重试中" : "下载中";
      this.emitQueue();
      this.emitEvent("task-started", { index: idx + 1, total: this.currentRun.urls.length, url });

      const outcome = await this.processURL(url, idx);

      if (this.stopRequested) {
        this.state = "stopped";
        this.emitState("stopped", "任务已终止。", true);
        return;
      }

      if (outcome.code === LOGIN_CANCEL_CODE) {
        queueItem.state = "stopped";
        queueItem.note = "已终止（取消验证）";
        for (let i = idx + 1; i < this.currentRun.queue.length; i += 1) {
          if (!["succeeded", "failed", "stopped"].includes(this.currentRun.queue[i].state)) {
            this.currentRun.queue[i].state = "stopped";
            this.currentRun.queue[i].note = "已终止（取消验证）";
          }
        }
        this.emitQueue();
        this.state = "stopped";
        this.emitState("stopped", "已取消验证，任务已终止。", true);
        return;
      }

      if (this.pauseRequested) {
        queueItem.state = "paused";
        queueItem.note = "已暂停，可继续";
        this.emitQueue();
        this.state = "paused";
        this.emitState("paused", "已暂停。继续时将从当前网址重新开始。", true);
        return;
      }

      if (outcome.code === 0) {
        queueItem.state = "succeeded";
        queueItem.note = "完成";
      } else {
        this.currentRun.failCount += 1;
        queueItem.state = "failed";
        queueItem.note = outcome.note || `失败（返回码 ${outcome.code}）`;
      }

      this.emitQueue();
      this.emitEvent("task-finished", { index: idx + 1, total: this.currentRun.urls.length, status: outcome.code, label: itemLabel });

      this.currentRun.currentIndex += 1;
      this.state = "running";
    }

    if (!this.currentRun) return;
    if (this.currentRun.failCount > 0) {
      this.state = "failed";
      this.emitState("failed", `任务已完成，${this.currentRun.failCount} 个网址失败。`, true);
    } else {
      this.state = "completed";
      this.emitState("completed", "全部任务下载完成。", true);
    }
  }

  async processURL(originalUrl, idx) {
    if (!this.currentRun) {
      return { code: 1, note: "任务上下文丢失" };
    }

    let urlWork = originalUrl;
    const options = this.currentRun.options;

    if (isShanghaiDetailUrl(urlWork)) {
      const pre = await this.preloginIfNeeded(urlWork, options);
      if (pre.cancelled) {
        return { code: LOGIN_CANCEL_CODE, note: "已取消验证" };
      }
      if (pre.cookiePath) {
        this.rememberHostLogin(urlWork, pre.cookiePath, pre.finalUrl || "");
      }
      if (pre.finalUrl) {
        urlWork = pre.finalUrl;
      }
    }

    const firstSpecial = await this.runSpecialAdapterIfNeeded(urlWork, options, true);
    if (firstSpecial.handled) {
      return { code: firstSpecial.code, note: firstSpecial.note || "" };
    }

    urlWork = await this.resolveSpecialEntryUrl(urlWork, options);

    const secondSpecial = await this.runSpecialAdapterIfNeeded(urlWork, options, false);
    if (secondSpecial.handled) {
      return { code: secondSpecial.code, note: secondSpecial.note || "" };
    }

    const prepared = await this.prepareURLIfNeeded(urlWork);
    if (prepared.mode) {
      this.currentRun.modeOverrideByIndex[idx] = prepared.mode;
      this.currentRun.modeTriedByIndex[idx] = this.currentRun.modeTriedByIndex[idx] || [];
      this.currentRun.modeTriedByIndex[idx].push(prepared.mode);
      this.currentRun.queue[idx].note = `已适配链接，a=${prepared.mode}`;
      this.emitQueue();
      this.emitLog(`[bookget gui] 检测到 Harvard 页面结构，已提取 manifest 并使用 a=${prepared.mode}。\n`);
    }

    const appModeExplicit = options.showAdvanced;
    if (!appModeExplicit) {
      for (const mode of ["0", "1", "2"]) {
        const runURL = mode === "2" ? await this.resolveIIIFManifestIfNeeded(prepared.url) : prepared.url;
        if (mode === "2" && runURL !== prepared.url) {
          this.emitLog(`[bookget wrapper] resolved page URL to IIIF manifest: ${runURL}\n`);
        }
        this.emitLog(`[bookget wrapper] auto mode try m=${mode}: ${runURL}\n`);
        const r = await this.runCoreForURL(runURL, options, {
          modeOverride: mode,
          index: idx,
        });
        if (r.code === 0) {
          return { code: 0 };
        }
        if (r.code === LOGIN_CANCEL_CODE) {
          return { code: LOGIN_CANCEL_CODE, note: "已取消验证" };
        }
        if (r.code === 96 || isTransportErrorLog(r.logText)) {
          this.emitLog("[bookget wrapper] detected transport/network errors; skip remaining auto modes\n");
          return { code: 96, note: "网络错误" };
        }
      }
      return { code: 1, note: "自动模式均失败" };
    }

    // Advanced mode path with GUI fallback for unsupported URL.
    let modeOverride = this.currentRun.modeOverrideByIndex[idx] || "";
    let attemptedUnsupportedFallback = false;

    for (;;) {
      const r = await this.runCoreForURL(prepared.url, options, {
        modeOverride,
        index: idx,
      });

      if (r.code === 0) {
        if (isNameConflictLog(r.logText) && !this.currentRun.conflictRetriedIndexes[idx]) {
          this.currentRun.conflictRetriedIndexes[idx] = true;
          const retryDir = this.makeRetryDirectory(originalUrl, idx + 1, options.outputDirectory);
          this.currentRun.outputOverrideByIndex[idx] = retryDir;
          this.state = "retrying";
          this.currentRun.queue[idx].state = "retrying";
          this.currentRun.queue[idx].note = "检测到重名，切换目录重试";
          this.emitQueue();
          this.emitState("retrying", "检测到同名冲突，已切换目录重试。");
          continue;
        }
        return { code: 0 };
      }
      if (r.code === LOGIN_CANCEL_CODE) {
        return { code: LOGIN_CANCEL_CODE, note: "已取消验证" };
      }

      if (isUnsupportedUrlLog(r.logText)) {
        const nextMode = this.nextAppModeFallback(idx, options);
        if (nextMode && !attemptedUnsupportedFallback) {
          attemptedUnsupportedFallback = true;
          modeOverride = nextMode;
          this.currentRun.modeOverrideByIndex[idx] = nextMode;
          this.currentRun.modeTriedByIndex[idx] = this.currentRun.modeTriedByIndex[idx] || [];
          this.currentRun.modeTriedByIndex[idx].push(nextMode);
          this.state = "retrying";
          this.currentRun.queue[idx].state = "retrying";
          this.currentRun.queue[idx].note = `URL 不兼容，切换模式 m=${nextMode} 重试`;
          this.emitQueue();
          this.emitState("retrying", `检测到 Unsupported URL，自动切换识别模式 m=${nextMode} 重试。`);
          continue;
        }
        return { code: 2, note: "不支持该网址" };
      }

      return { code: r.code || 1, note: `失败（返回码 ${r.code || 1}）` };
    }
  }

  nextAppModeFallback(idx, options) {
    const tried = new Set(this.currentRun.modeTriedByIndex[idx] || []);
    const current = this.effectiveAppMode(idx, options);
    for (const mode of ["1", "2"]) {
      if (mode !== current && !tried.has(mode)) {
        return mode;
      }
    }
    return "";
  }

  effectiveAppMode(idx, options) {
    const override = this.currentRun.modeOverrideByIndex[idx];
    if (["0", "1", "2"].includes(override)) {
      return override;
    }
    if (options.showAdvanced && ["0", "1", "2"].includes(String(options.appMode || "").trim())) {
      return String(options.appMode).trim();
    }
    return "0";
  }

  emitState(state, detail, finished = false) {
    this.emitEvent("state", { state, detail, finished, failCount: this.currentRun?.failCount || 0 });
  }

  emitQueue() {
    this.emitEvent("queue", {
      state: this.state,
      queue: this.currentRun?.queue || [],
      currentIndex: this.currentRun?.currentIndex || 0,
      total: this.currentRun?.urls?.length || 0,
      failCount: this.currentRun?.failCount || 0,
    });
  }

  emitEvent(type, payload) {
    this.emit("event", { type, payload, ts: Date.now() });
  }

  emitLog(chunk) {
    const text = String(chunk || "");
    if (!text) return;
    this.logBuffer += text;
    if (this.logBuffer.length > 2_000_000) {
      this.logBuffer = this.logBuffer.slice(-1_500_000);
    }
    if (this.currentRun) {
      this.currentRun.fullLog += text;
      if (this.currentRun.fullLog.length > 6_000_000) {
        this.currentRun.fullLog = this.currentRun.fullLog.slice(-4_500_000);
      }
    }
    this.emitEvent("log", { chunk: text });
  }

  makeRetryDirectory(url, index, baseDir) {
    const host = (hostKeyOf(url) || "task").replace(/:/g, "_");
    const name = `bookget_retry_${index}_${host}_${nowStamp()}`;
    const dir = path.join(baseDir, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  rememberHostLogin(url, cookiePath, finalUrl) {
    const host = hostKeyOf(url);
    if (!host) return;
    this.loginByHost.set(host, cookiePath);
    const parent = parentDomain(host);
    if (parent) {
      this.loginByHost.set(parent, cookiePath);
    }
    if (finalUrl) {
      this.finalUrlByHost.set(host, finalUrl);
      if (parent) {
        this.finalUrlByHost.set(parent, finalUrl);
      }
    }
  }

  loginCookieForURL(url) {
    const host = hostKeyOf(url);
    if (!host) return "";
    const direct = this.loginByHost.get(host);
    if (direct && fs.existsSync(direct)) return direct;
    const parent = parentDomain(host);
    if (!parent) return "";
    const byParent = this.loginByHost.get(parent);
    if (byParent && fs.existsSync(byParent)) return byParent;
    return "";
  }

  async preloginIfNeeded(url, options) {
    if (!options.needLogin) {
      return { cancelled: false, cookiePath: "", finalUrl: "" };
    }
    const existing = this.loginCookieForURL(url);
    if (existing) {
      const host = hostKeyOf(url);
      const finalUrl = this.finalUrlByHost.get(host) || this.finalUrlByHost.get(parentDomain(host)) || "";
      return { cancelled: false, cookiePath: existing, finalUrl };
    }

    const popup = await this.openLoginPopup({
      url,
      title: "弹窗浏览器（BookGet）",
      hint: "完成登录或验证码后按 F8 继续，Esc 取消。",
      mode: "login",
    });

    if (popup.cancelled) {
      return { cancelled: true, cookiePath: "", finalUrl: "" };
    }

    if (popup.cookiePath) {
      this.rememberHostLogin(url, popup.cookiePath, popup.finalUrl || "");
    }

    return {
      cancelled: false,
      cookiePath: popup.cookiePath || "",
      finalUrl: popup.finalUrl || "",
    };
  }

  async prepareURLIfNeeded(rawURL) {
    const url = safeURL(rawURL);
    if (!url) {
      return { url: rawURL, mode: "" };
    }

    const host = url.hostname.toLowerCase();
    if (host !== "curiosity.lib.harvard.edu") {
      return { url: rawURL, mode: "" };
    }

    const pathLower = url.pathname.toLowerCase();
    if (!pathLower.includes("/catalog/") && !pathLower.includes("/lists/")) {
      return { url: rawURL, mode: "" };
    }

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "User-Agent": DEFAULT_UA,
          Accept: "text/html,application/xhtml+xml",
        },
      });
      if (!response.ok) {
        return { url: rawURL, mode: "" };
      }
      const html = await response.text();
      const candidate = extractManifestCandidateFromPage(html);
      if (!candidate) {
        return { url: rawURL, mode: "" };
      }
      const normalized = normalizeCandidateURL(url.toString(), candidate);
      if (!normalized) {
        return { url: rawURL, mode: "" };
      }
      return { url: normalized, mode: "2" };
    } catch {
      return { url: rawURL, mode: "" };
    }
  }

  async resolveIIIFManifestIfNeeded(url) {
    if (!isLikelyHTTP(url) || manifestLikely(url)) {
      return url;
    }
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { "User-Agent": DEFAULT_UA },
      });
      if (!response.ok) {
        return url;
      }
      const html = await response.text();
      const candidate = extractManifestCandidateFromPage(html);
      if (!candidate) {
        return url;
      }
      return normalizeCandidateURL(url, candidate) || url;
    } catch {
      return url;
    }
  }

  async resolveSpecialEntryUrl(url, options) {
    if (isNpmDigitalArchiveDetailUrl(url)) {
      return resolveNpmDigitalArchiveManifest(url);
    }

    if (isRbookSearchDetailUrl(url)) {
      const resolved = await this.resolveRbookEntryUrl(url, options);
      return resolved || url;
    }

    return url;
  }

  async resolveRbookEntryUrl(url, options) {
    const cookiePath = this.loginCookieForURL(url) || (options.cookieFilePath || "");
    const cookieHeader = await this.cookieHeaderFromFile(cookiePath, hostKeyOf(url));

    try {
      const headers = { "User-Agent": options.userAgent?.trim() || DEFAULT_UA };
      if (cookieHeader) {
        headers.Cookie = cookieHeader;
      }
      const response = await fetch(url, { headers });
      if (!response.ok) {
        return "";
      }
      const page = await response.text();

      const absolute = page.match(/https?:\/\/[^"'\s]*taiwanebook\.ncl\.edu\.tw[^"'\s]*book\/book\/view\.do[^"'\s]*/i);
      if (absolute) {
        return absolute[0];
      }

      const rel = page.match(/(?:href|content|data-url|url)=["']([^"']*book\/book\/view\.do[^"']*)["']/i);
      if (rel) {
        return normalizeCandidateURL(url, rel[1]) || "";
      }

      const bare = page.match(/\/(?:zh-tw\/)?book\/book\/view\.do[^"'\s]*/i);
      if (bare) {
        return normalizeCandidateURL("https://taiwanebook.ncl.edu.tw", bare[0]) || "";
      }
    } catch {
      return "";
    }

    return "";
  }

  async cookieHeaderFromFile(cookieFile, hostFilter) {
    if (!cookieFile || !fs.existsSync(cookieFile)) {
      return "";
    }
    const raw = fs.readFileSync(cookieFile, "utf8");
    const pairs = [];

    raw.split(/\r?\n/).forEach((line) => {
      if (!line || line.startsWith("#")) {
        if (!line.startsWith("#HttpOnly_")) {
          return;
        }
      }

      const clean = line.replace(/^#HttpOnly_/, "");
      const parts = clean.split("\t");
      if (parts.length < 7) {
        return;
      }
      const [domain, , , , , name, value] = parts;
      if (hostFilter && !hostMatchesCookieDomain(hostFilter, domain)) {
        return;
      }
      if (name) {
        pairs.push(`${name}=${value}`);
      }
    });

    return pairs.join("; ");
  }

  async runSpecialAdapterIfNeeded(url, options, strictLoginRequired) {
    if (isShanghaiPDFViewUrl(url)) {
      const code = await this.runShanghaiPDFDownload(url, options);
      return { handled: true, code, note: code === 0 ? "" : "上海图书馆 PDF 专用下载失败" };
    }

    if (isQingDisplayUrl(url)) {
      const code = await this.runQingarchivesDownload(url, options);
      return { handled: true, code, note: code === 0 ? "" : "清代档案专用下载失败" };
    }

    if (isRbookSearchDetailUrl(url)) {
      if (!options.needLogin && strictLoginRequired) {
        this.emitLog(`[bookget wrapper] rbook SearchDetail requires login/verification popup; skipping because -login=0: ${url}\n`);
        return { handled: true, code: 95, note: "rbook 需要弹窗登录" };
      }
      if (!options.needLogin && !strictLoginRequired) {
        return { handled: false, code: SPECIAL_RUN_NOT_HANDLED };
      }
      const code = await this.runRbookScrape(url, options);
      return { handled: true, code, note: code === 0 ? "" : "rbook 抓页下载失败" };
    }

    return { handled: false, code: SPECIAL_RUN_NOT_HANDLED };
  }

  async runRbookScrape(url, options) {
    const baseOut = options.outputDirectory;
    const itemMatch = String(url).match(/[?&]item=([^&#]+)/i);
    const short = sanitizeFilename(itemMatch ? decodeURIComponent(itemMatch[1]) : "unknown").slice(0, 12) || "unknown";
    const outDir = path.join(baseOut, `rbook_${short}_${nowStamp()}`);
    fs.mkdirSync(outDir, { recursive: true });

    const intervalRaw = normalizeIntervalValue(options.captureInterval || "5");
    const interval = intervalRaw ? Number(intervalRaw) : 5;

    this.emitLog(`[bookget wrapper] rbook special-case: using popup scrape into: ${outDir} (capture-interval=${interval}s)\n`);

    const popup = await this.openLoginPopup({
      url,
      title: "國圖下載 (BookGet)",
      hint: "进入阅读器页后按 F8 开始抓页下载，Esc 取消。",
      mode: "rbook-scrape",
    });

    if (popup.cancelled || !popup.windowId) {
      return LOGIN_CANCEL_CODE;
    }

    if (popup.cookiePath) {
      this.rememberHostLogin(url, popup.cookiePath, popup.finalUrl || "");
    }

    const scrape = await this.ensureCookiesForWindow({
      windowId: popup.windowId,
      url: popup.finalUrl || url,
      host: hostKeyOf(url),
      outDir,
      intervalSeconds: interval,
      mode: "rbook",
    });

    return scrape.ok ? 0 : 95;
  }

  async runShanghaiPDFDownload(url, options) {
    const outputDir = options.outputDirectory;
    fs.mkdirSync(outputDir, { recursive: true });

    const context = this.parseShanghaiPDFViewContext(url);
    if (!context || !context.token || !context.dbname) {
      this.emitLog("[bookget wrapper] shanghai special-case: invalid pdfview URL\n");
      return 94;
    }

    const headers = {
      "Content-Type": "application/json",
      token: context.token,
      "User-Agent": options.userAgent?.trim() || DEFAULT_UA,
    };

    const infoUrl = new URL("https://dhapi.library.sh.cn/service_pdf/pdf/info");
    infoUrl.searchParams.set("dbname", context.dbname);

    const infoBody = context.doi
      ? { dbname: context.dbname, doi: context.doi }
      : context.type && context.idvalue
      ? { dbname: context.dbname, type: context.type, idvalue: context.idvalue }
      : null;

    if (!infoBody) {
      return 94;
    }

    let infoJson;
    try {
      const infoResp = await fetch(infoUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(infoBody),
      });
      if (!infoResp.ok) {
        return 96;
      }
      infoJson = await infoResp.json();
    } catch {
      return 96;
    }

    if (!infoJson || infoJson.state !== 0 || !infoJson.data || !Array.isArray(infoJson.data.items) || !infoJson.data.items.length) {
      return 95;
    }

    const items = infoJson.data.items;
    this.emitLog(`[bookget-web-login] shl info loaded: ${items.length} item(s)\n`);

    const streamURL = "https://dhapi.library.sh.cn/service_pdf/pdf/stream";
    const safeBase = sanitizeFilename(context.idvalue || context.doi || context.dbname, "item");

    for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
      const item = items[itemIndex] || {};
      const pageCount = Number(item.page_count || item.pageCount || 0);
      if (!pageCount) {
        continue;
      }
      const safeItemName = sanitizeFilename(item.name || `item_${itemIndex + 1}`);
      const fileName = items.length === 1 ? `shl_${safeBase}.pdf` : `shl_${safeBase}_${safeItemName}_${itemIndex + 1}.pdf`;
      const outPath = path.join(outputDir, fileName);
      const pagesDir = path.join(outputDir, fileName.replace(/\.pdf$/i, ".pages"));
      fs.mkdirSync(pagesDir, { recursive: true });

      const parts = [];
      for (let pageNo = 1; pageNo <= pageCount; pageNo += 1) {
        const cacheFile = path.join(pagesDir, `${String(pageNo).padStart(4, "0")}.pdf`);
        if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 0) {
          parts.push(cacheFile);
          this.emitLog(`[bookget-web-login] shl reused ${pageNo}/${pageCount}\n`);
          continue;
        }

        const body = {
          dbname: context.dbname,
          innerflag: context.innerflag || "",
          id: item.value,
          page_no: pageNo,
        };

        try {
          const pageResp = await fetch(streamURL, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
          });
          if (!pageResp.ok) {
            return 95;
          }
          const buf = Buffer.from(await pageResp.arrayBuffer());
          if (!buf.slice(0, 5).equals(Buffer.from("%PDF-"))) {
            return 95;
          }
          fs.writeFileSync(cacheFile, buf);
          parts.push(cacheFile);
          this.emitLog(`[bookget-web-login] shl saved ${pageNo}/${pageCount}\n`);
        } catch {
          return 95;
        }
      }

      // Keep behavior practical on Windows: output page PDFs + merge marker.
      // Core requirement is successful capture. Full merge can be done externally if needed.
      const mergeIndex = path.join(outputDir, fileName.replace(/\.pdf$/i, ".parts.txt"));
      fs.writeFileSync(mergeIndex, parts.map((p) => path.basename(p)).join("\n"), "utf8");
      this.emitLog(`[bookget-web-login] shl output pages: ${path.basename(pagesDir)}\n`);
      this.emitLog(`[bookget-web-login] shl merge index: ${path.basename(mergeIndex)}\n`);

      // If only one page, emit direct PDF for compatibility.
      if (parts.length === 1) {
        fs.copyFileSync(parts[0], outPath);
      }
    }

    return 0;
  }

  parseShanghaiPDFViewContext(urlText) {
    const u = safeURL(urlText);
    if (!u) return null;

    const q = u.searchParams;
    const dbname = q.get("dbname") || "";
    const token = q.get("token") || "";
    const doi = q.get("doi") || "";
    const type = q.get("type") || "";
    const idvalue = q.get("id") || q.get("idvalue") || "";
    const innerflag = q.get("innerflag") || "";

    return { dbname, token, doi, type, idvalue, innerflag };
  }

  async runQingarchivesDownload(entryUrl, options) {
    const { objectCode, pageCode, entryNoHash } = decodeQingDisplayUrl(entryUrl);
    if (!objectCode) {
      this.emitLog("[bookget wrapper] qingarchives special-case: failed to parse object code\n");
      return 94;
    }

    const ua = options.userAgent?.trim() || DEFAULT_UA;
    const baseURL = "https://qingarchives.npm.edu.tw/";
    const landingURL = `${baseURL}index.php?act=Landing/index`;
    const apiURL = `${baseURL}index.php`;

    const cookieHeader = await this.cookieHeaderFromFile(this.loginCookieForURL(entryUrl) || options.cookieFilePath || "", "qingarchives.npm.edu.tw");
    const headers = {
      "User-Agent": ua,
      Referer: entryNoHash,
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    };

    let responseJson;
    try {
      await fetch(landingURL, { headers: { "User-Agent": ua } });
      await fetch(entryNoHash, { headers });

      const body = new URLSearchParams();
      body.set("act", `Display/built/${objectCode}/${pageCode || ""}/jpg`);
      const resp = await fetch(apiURL, {
        method: "POST",
        headers: {
          "User-Agent": ua,
          Referer: entryNoHash,
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
        body,
      });
      if (!resp.ok) {
        this.emitLog("[bookget wrapper] qingarchives special-case: failed to query page list API\n");
        return 96;
      }
      responseJson = await resp.json();
    } catch {
      return 96;
    }

    if (!responseJson || Number(responseJson.action) !== 1) {
      this.emitLog("[bookget wrapper] qingarchives special-case: API rejected access or returned invalid payload\n");
      return 95;
    }

    const pageList = responseJson?.data?.page_list || {};
    const pageThumb = responseJson?.data?.page_thumb || {};
    const pageAccessLock = String(responseJson?.data?.page_access_lock || "0");
    if (pageAccessLock !== "0") {
      this.emitLog("[bookget wrapper] qingarchives special-case: page access is locked by site-side verification\n");
      return 95;
    }

    const tasks = Object.keys(pageList)
      .map((k, idx) => {
        const code = pageList[k];
        const thumbName = pageThumb[k] || "";
        const baseName = sanitizeFilename(thumbName || `${String(idx + 1).padStart(4, "0")}.jpg`, `${String(idx + 1).padStart(4, "0")}.jpg`);
        const finalName = baseName.toLowerCase().endsWith(".jpg") ? baseName : `${baseName}.jpg`;
        return {
          idx: idx + 1,
          code,
          fileName: `${String(idx + 1).padStart(4, "0")}_${finalName}`,
        };
      })
      .filter((t) => t.code);

    if (!tasks.length) {
      this.emitLog("[bookget wrapper] qingarchives special-case: no page codes extracted\n");
      return 98;
    }

    const outRoot = options.outputDirectory || process.cwd();
    const safeObj = sanitizeFilename(objectCode, "obj");
    const outDir = path.join(outRoot, `qingarchives.npm.edu.tw_${safeObj}`);
    fs.mkdirSync(outDir, { recursive: true });
    this.emitLog(`[bookget wrapper] qingarchives special-case: output dir: ${outDir}\n`);

    const retries = Number.isFinite(Number(options.retries)) ? Math.max(0, Math.min(8, Number(options.retries))) : 3;
    const interval = Number(normalizeIntervalValue(options.captureInterval || "")) || 0;

    for (const task of tasks) {
      const finalFile = path.join(outDir, task.fileName);
      if (fs.existsSync(finalFile) && fs.statSync(finalFile).size > 0) {
        continue;
      }

      let ok = false;
      const attempts = retries + 1;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const loadURL = `${baseURL}index.php?act=Display/loadimg/${objectCode}/${task.code}`;
        this.emitLog(`${new Date().toISOString()} Get ${task.idx}/${tasks.length}  ${loadURL}\n`);

        try {
          const imgResp = await fetch(loadURL, {
            headers,
          });
          if (!imgResp.ok) {
            throw new Error(`HTTP ${imgResp.status}`);
          }
          const buf = Buffer.from(await imgResp.arrayBuffer());
          if (buf.length < 4 || !(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) {
            throw new Error("invalid payload");
          }
          fs.writeFileSync(finalFile, buf);
          ok = true;
          break;
        } catch {
          if (attempt < attempts) {
            await wait(1000);
          }
        }
      }

      if (!ok) {
        this.emitLog("[bookget wrapper] qingarchives special-case: failed pages: 1+\n");
        return 95;
      }

      if (interval > 0) {
        await wait(interval * 1000);
      }
    }

    this.emitLog(`${new Date().toISOString()} Download complete.\n`);
    return 0;
  }

  resolveRuntimeBinDir(sourceBinDir) {
    const src = path.resolve(String(sourceBinDir || ""));
    if (this.runtimeBinCache && this.runtimeBinCache.sourceBinDir === src) {
      return this.runtimeBinCache;
    }

    const envOverride = String(process.env.BOOKGET_RUNTIME_BIN_DIR || "").trim();
    const candidatesRaw = uniqueList([
      envOverride,
      path.join(String(process.env.SystemDrive || "C:"), "bookget-runtime", "bin"),
      process.env.ProgramData ? path.join(process.env.ProgramData, "bookget-runtime", "bin") : "",
      process.env.PUBLIC ? path.join(process.env.PUBLIC, "bookget-runtime", "bin") : "",
      process.env.TEMP ? path.join(process.env.TEMP, "bookget-runtime", "bin") : "",
      path.join(os.tmpdir(), "bookget-runtime", "bin"),
      src,
    ]);

    const preferred = candidatesRaw.filter((p) => !hasNonPortablePathChars(p));
    const fallback = candidatesRaw.filter((p) => hasNonPortablePathChars(p));
    const candidates = preferred.concat(fallback);

    let selected = src;
    for (const dir of candidates) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, ".write-probe");
        fs.writeFileSync(probe, "ok", "utf8");
        fs.unlinkSync(probe);
        selected = path.resolve(dir);
        break;
      } catch {
        // Try next candidate.
      }
    }

    if (selected !== src) {
      const filesToStage = ["bookget-core.exe", "dezoomify-rs.exe", "config.ini", "cookie.txt", "header.txt"];
      for (const name of filesToStage) {
        const from = path.join(src, name);
        const to = path.join(selected, name);
        try {
          copyFileIfNeeded(from, to);
        } catch {
          // Ignore optional file copy errors.
        }
      }
    }

    const cache = {
      sourceBinDir: src,
      runtimeBinDir: selected,
      staged: selected !== src,
    };
    this.runtimeBinCache = cache;
    return cache;
  }

  detectCoreCliStyle(corePath, cwd) {
    if (this.coreCliStyle) {
      return this.coreCliStyle;
    }

    let help = "";
    try {
      const r = spawnSync(corePath, ["--help"], {
        cwd,
        windowsHide: true,
        timeout: 8000,
        encoding: "utf8",
      });
      help = `${r?.stdout || ""}\n${r?.stderr || ""}`;
    } catch {
      help = "";
    }

    const style = /--downloader_mode|--dir|--cookies|-\s*O,\s*--dir/i.test(help) ? "modern" : "legacy";
    this.coreCliStyle = style;
    if (!this.coreCliStyleLogged) {
      this.coreCliStyleLogged = true;
      this.emitLog(`[bookget wrapper] detected core CLI style: ${style}\n`);
    }
    return style;
  }

  buildCoreArgs(url, options, runOpts, style) {
    const modeOverride = runOpts.modeOverride || "";
    const idx = runOpts.index;
    const outputOverride = this.currentRun?.outputOverrideByIndex?.[idx] || options.outputDirectory;

    const args = [];
    if (style === "modern") {
      args.push("-O", outputOverride);
    } else {
      args.push("-o", outputOverride);
    }

    if (options.showAdvanced) {
      const mode = modeOverride || String(options.appMode || "").trim();
      if (mode) {
        if (style === "modern") {
          args.push("-m", mode);
        } else {
          args.push("-a", mode);
        }
      }

      if (String(options.concurrency || "").trim()) {
        args.push("-n", String(options.concurrency).trim());
      }

      if (String(options.retries || "").trim()) {
        if (style === "modern") {
          args.push("--retries", String(options.retries).trim());
        } else {
          args.push("-r", String(options.retries).trim());
        }
      }

      if (String(options.seq || "").trim()) {
        if (style === "modern") {
          args.push("-p", String(options.seq).trim());
        } else {
          args.push("-seq", String(options.seq).trim());
        }
      }

      if (String(options.vol || "").trim()) {
        if (style === "modern") {
          args.push("-v", String(options.vol).trim());
        } else {
          args.push("-vol", String(options.vol).trim());
        }
      }

      const interval = normalizeIntervalValue(options.captureInterval || "");
      if (interval) {
        if (style === "modern") {
          args.push("--sleep", String(Math.max(1, Math.round(Number(interval) || 1))));
        } else {
          args.push("-interval", interval, "-speed", interval);
        }
      }

      if (String(options.fileExt || "_").trim() !== "_") {
        args.push("-ext", String(options.fileExt).trim());
      }

      if (String(options.userAgent || "").trim()) {
        if (style === "modern") {
          args.push("-U", String(options.userAgent).trim());
        } else {
          args.push("-ua", String(options.userAgent).trim());
        }
      }

      const cookieOverride = this.loginCookieForURL(url);
      const cookiePath = cookieOverride || String(options.cookieFilePath || "").trim();
      if (cookiePath) {
        if (style === "modern") {
          args.push("-C", cookiePath);
        } else {
          args.push("-c", cookiePath);
        }
      }

      if (String(options.localStorageFilePath || "").trim()) {
        if (style === "modern") {
          this.emitLog("[bookget wrapper] core CLI style modern: localStorage flag is unsupported and was skipped\n");
        } else {
          args.push("-localStorage", String(options.localStorageFilePath).trim());
        }
      }
    } else if (modeOverride) {
      if (style === "modern") {
        args.push("-m", modeOverride);
      } else {
        args.push("-a", modeOverride);
      }
      const cookieOverride = this.loginCookieForURL(url);
      if (cookieOverride) {
        if (style === "modern") {
          args.push("-C", cookieOverride);
        } else {
          args.push("-c", cookieOverride);
        }
      }
    }

    args.push(url);
    return args;
  }

  async runCoreForURL(url, options, runOpts) {
    const sourceBinDir = this.getBinDir();
    const runtime = this.resolveRuntimeBinDir(sourceBinDir);
    const binDir = runtime.runtimeBinDir;
    const corePath = path.join(binDir, "bookget-core.exe");
    if (!fs.existsSync(corePath)) {
      this.emitLog(`[bookget wrapper] missing core binary at ${corePath}\n`);
      return { code: 127, logText: "missing core binary" };
    }

    if (runtime.staged && !this.runtimeBinNoticeShown) {
      this.runtimeBinNoticeShown = true;
      this.emitLog(`[bookget wrapper] runtime bin staged to: ${binDir}\n`);
    }

    const style = this.detectCoreCliStyle(corePath, binDir);
    let args = this.buildCoreArgs(url, options, runOpts, style);
    let log = await this.spawnProcess(corePath, args, binDir);

    if (style === "legacy" && isUnknownFlagLog(log.logText, "o")) {
      args = this.buildCoreArgs(url, options, runOpts, "modern");
      log = await this.spawnProcess(corePath, args, binDir);
      this.coreCliStyle = "modern";
      if (!this.coreCliStyleLogged) {
        this.coreCliStyleLogged = true;
        this.emitLog("[bookget wrapper] switched core CLI style to modern by runtime probe\n");
      }
    } else if (style === "modern" && isUnknownFlagLog(log.logText, "O")) {
      args = this.buildCoreArgs(url, options, runOpts, "legacy");
      log = await this.spawnProcess(corePath, args, binDir);
      this.coreCliStyle = "legacy";
      if (!this.coreCliStyleLogged) {
        this.coreCliStyleLogged = true;
        this.emitLog("[bookget wrapper] switched core CLI style to legacy by runtime probe\n");
      }
    }

    return log;
  }

  spawnProcess(executablePath, args, cwd) {
    return new Promise((resolve) => {
      let logText = "";
      let closed = false;

      const child = spawn(executablePath, args, {
        cwd,
        windowsHide: true,
      });
      this.currentChild = child;

      const onData = (chunk) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        if (!text) return;
        logText += text;
        if (logText.length > 2_000_000) {
          logText = logText.slice(-1_500_000);
        }
        this.emitLog(text);
      };

      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);

      child.on("error", (error) => {
        if (closed) return;
        closed = true;
        this.currentChild = null;
        this.emitLog(`[bookget wrapper] spawn failed: ${error.message}\n`);
        resolve({ code: 1, logText });
      });

      child.on("close", (code) => {
        if (closed) return;
        closed = true;
        this.currentChild = null;
        resolve({ code: code == null ? 1 : code, logText });
      });
    });
  }
}

module.exports = {
  BookGetTaskRunner,
  splitUrls,
  toNetscapeCookieLines,
  hostMatchesCookieDomain,
  hostKeyOf,
};
