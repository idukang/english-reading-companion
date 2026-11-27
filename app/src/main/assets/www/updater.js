/* =========================================================
   青鸟 · 英语陪读 —— 应用内更新（前端）
   · 检查、下载、校验、调起安装都在安卓外壳里做（AppUpdater.kt），
     这一层只负责界面、状态和「启动时自动检查」这个开关。
   · 不联网：网页自己不发任何请求，断网时所有功能照常。
   · 界面元素都在 index.html 的「关于与更新」卡片和顶栏横幅里。
   ========================================================= */

(function () {
  "use strict";

  const STORE_KEY = "erc.update";
  const MAX_NOTES = 4000;
  const AUTO_CHECK_DELAY = 1400;

  /* ========================= 小工具 ========================= */

  function el(id) { return document.getElementById(id); }

  function setText(id, v) {
    const n = el(id);
    if (n) n.textContent = String(v == null ? "" : v);
  }

  function toggle(id, cls, on) {
    const n = el(id);
    if (n) n.classList.toggle(cls, !!on);
  }

  function readStore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const o = raw ? JSON.parse(raw) : null;
      return (o && typeof o === "object") ? o : {};
    } catch (e) {
      return {};
    }
  }

  function writeStore(patch) {
    const next = Object.assign({}, readStore(), patch || {});
    try { localStorage.setItem(STORE_KEY, JSON.stringify(next)); } catch (e) {}
    return next;
  }

  /** "v1.6.1" / "1.6" / "1.6.1-beta" → [1,6,1] */
  function parseVersion(v) {
    const s = String(v == null ? "" : v).trim().replace(/^[vV]/, "");
    const core = s.split(/[-+ ]/)[0] || "";
    const out = [];
    core.split(".").forEach(function (p) {
      const digits = p.replace(/[^0-9]/g, "");
      if (digits) out.push(parseInt(digits, 10));
    });
    return out.length ? out : [0];
  }

  /** a 新于 b 返回 1，旧于返回 -1，相同（含 1.6 与 1.6.0）返回 0 */
  function compareVersions(a, b) {
    const pa = parseVersion(a);
    const pb = parseVersion(b);
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
      const x = i < pa.length ? pa[i] : 0;
      const y = i < pb.length ? pb[i] : 0;
      if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
  }

  function normVersion(v) {
    return parseVersion(v).join(".");
  }

  /** Release 说明是 Markdown：在手机小屏上把标题符号、加粗星号和列表符号换成看得懂的纯文本 */
  function plainNotes(md) {
    return String(md == null ? "" : md)
      .replace(/\r\n/g, "\n")
      .replace(/^#{1,6}\s*/gm, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^\s*[-*]\s+/gm, "· ")
      .replace(/^\s*>\s?/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function fmtSize(bytes) {
    const n = Number(bytes) || 0;
    if (n <= 0) return "";
    if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1) + " GB";
    if (n >= 1024 * 1024) return Math.round(n / (1024 * 1024)) + " MB";
    return Math.round(n / 1024) + " KB";
  }

  /** 只认 https + GitHub 官方域名，防止被换成别处的安装包 */
  function safeUrl(u) {
    const s = String(u == null ? "" : u).trim();
    return /^https:\/\/(github\.com|[\w.-]*\.githubusercontent\.com)\//i.test(s);
  }

  /* ========================= 检查结果 ========================= */

  /**
   * 把原生层返回的结果整理成界面能用的对象。
   * 原生层给的是 JSON 字符串：
   *   {"status":"update|latest|error","current":"1.6.0","latest":"1.6.1",
   *    "notes":"…","apkUrl":"https://github.com/…apk","shaUrl":"https://…/SHA256SUMS.txt",
   *    "size":123456789,"error":"…","silent":false}
   */
  function readRelease(payload) {
    let data = payload;
    if (typeof data === "string") {
      try { data = JSON.parse(data); } catch (e) { return { ok: false, reason: "检查结果无法解析" }; }
    }
    if (!data || typeof data !== "object") return { ok: false, reason: "检查结果为空" };

    const status = String(data.status || "");
    if (status === "error") return { ok: false, reason: String(data.error || "检查更新失败") };
    if (status !== "update" && status !== "latest") return { ok: false, reason: "未知的检查结果" };

    if (!/^[vV]?\d+(\.\d+){0,3}$/.test(String(data.latest == null ? "" : data.latest).trim())) {
      return { ok: false, reason: "版本号格式不对" };
    }
    const latest = normVersion(data.latest);
    if (status === "latest") {
      return { ok: true, status: "latest", latest: latest, notes: "", apkUrl: "", shaUrl: "", size: 0 };
    }

    const apkUrl = String(data.apkUrl || "");
    if (!safeUrl(apkUrl)) return { ok: false, reason: "安装包地址不是 GitHub 官方地址，已忽略" };
    const shaRaw = String(data.shaUrl || "");
    const size = Number(data.size) > 0 ? Number(data.size) : 0;
    return {
      ok: true,
      status: "update",
      latest: latest,
      notes: String(data.notes || "").slice(0, MAX_NOTES),
      apkUrl: apkUrl,
      shaUrl: safeUrl(shaRaw) ? shaRaw : "",
      size: size
    };
  }

  /* ========================= 状态 ========================= */

  const S = {
    phase: "idle",      // idle / checking / latest / available / downloading / verifying / need_permission / installing / error
    release: null,
    error: "",
    progress: -1,
    downloaded: 0,
    total: 0,
    silent: false,
    current: ""
  };

  let hooks = { toast: null, openSettings: null };
  let bound = false;
  let checking = false;

  function bridge() { return window.AndroidBridge || null; }

  function currentVersion() {
    const b = bridge();
    if (b) {
      try { if (typeof b.appVersionName === "function") return String(b.appVersionName() || ""); } catch (e) {}
      try { if (typeof b.appVersion === "function") return String(b.appVersion() || ""); } catch (e) {}
    }
    const node = el("aboutVersion");
    const m = node && /v([0-9][0-9.]*)/.exec(node.textContent || "");
    return m ? m[1] : "";
  }

  function currentVersionCode() {
    const b = bridge();
    if (b) {
      try { if (typeof b.appVersionCode === "function") return Number(b.appVersionCode()) || 0; } catch (e) {}
    }
    return 0;
  }

  function autoEnabled() {
    const st = readStore();
    return st.auto !== false;
  }

  function setAuto(on) {
    writeStore({ auto: !!on });
    render();
  }

  function dismiss() {
    if (S.release) writeStore({ dismissed: S.release.latest });
    render();
  }

  function showToast(msg) {
    if (typeof hooks.toast === "function") hooks.toast(msg);
  }

  /* ========================= 动作 ========================= */

  function check(silent) {
    S.silent = !!silent;
    if (checking) return false;
    const b = bridge();
    if (!b || typeof b.checkForUpdate !== "function") {
      S.phase = "error";
      S.error = "这个版本不支持应用内更新，可以到 GitHub Releases 下载新版安装包。";
      render();
      return false;
    }
    checking = true;
    S.phase = "checking";
    S.error = "";
    render();
    try {
      b.checkForUpdate(!!silent);
      return true;
    } catch (e) {
      checking = false;
      S.phase = "error";
      S.error = "检查更新失败：" + (e && e.message ? e.message : "未知错误");
      render();
      return false;
    }
  }

  function install() {
    if (S.phase === "need_permission") {
      const b = bridge();
      if (b && typeof b.openInstallPermissionSettings === "function") {
        try { b.openInstallPermissionSettings(); } catch (e) {}
      }
      return false;
    }
    if (!S.release || S.release.status !== "update") {
      return check(false);
    }
    const b = bridge();
    if (!b || typeof b.downloadAndInstallUpdate !== "function") {
      S.phase = "error";
      S.error = "这个版本不支持应用内安装，请到 GitHub Releases 手动下载。";
      render();
      return false;
    }
    S.phase = "downloading";
    S.progress = 0;
    S.downloaded = 0;
    S.total = S.release.size || 0;
    render();
    try {
      b.downloadAndInstallUpdate(S.release.apkUrl, S.release.shaUrl || "");
      return true;
    } catch (e) {
      S.phase = "error";
      S.error = "下载失败：" + (e && e.message ? e.message : "未知错误");
      render();
      return false;
    }
  }

  /* ========================= 原生层回调 ========================= */

  function onCheckResult(payload) {
    checking = false;
    let data = payload;
    if (typeof data === "string") {
      try { data = JSON.parse(data); } catch (e) { data = null; }
    }
    if (data && typeof data === "object" && typeof data.silent === "boolean") {
      S.silent = !!data.silent;
    }
    const r = readRelease(data);
    S.current = currentVersion();

    if (!r.ok) {
      S.phase = "error";
      S.error = r.reason;
      render();
      if (!S.silent) showToast("检查更新失败：" + r.reason);
      return r;
    }

    if (r.status === "latest" || compareVersions(r.latest, currentVersion()) <= 0) {
      S.phase = "latest";
      S.release = null;
      S.progress = -1;
      writeStore({ lastCheck: Date.now(), checkedVersion: r.latest });
      render();
      if (!S.silent) showToast("已经是最新版本 v" + normVersion(currentVersion()));
      return r;
    }

    S.phase = "available";
    S.release = r;
    S.progress = -1;
    S.error = "";
    writeStore({ lastCheck: Date.now(), lastSeen: r.latest });
    render();
    if (!S.silent) showToast("发现新版本 v" + r.latest);
    return r;
  }

  function onProgress(percent, downloaded, total) {
    const p = Number(percent);
    if (isFinite(p) && p >= 0) S.progress = Math.max(0, Math.min(100, p));
    S.downloaded = Number(downloaded) || 0;
    S.total = Number(total) || S.total || 0;
    if (S.phase === "downloading" || S.phase === "verifying" || S.phase === "need_permission") render();
  }

  function onState(state, message) {
    const st = String(state || "");
    const msg = String(message || "");
    if (st === "downloading") {
      S.phase = "downloading";
    } else if (st === "verifying") {
      S.phase = "verifying";
      S.progress = 100;
    } else if (st === "need_permission") {
      S.phase = "need_permission";
    } else if (st === "installing") {
      S.phase = "installing";
    } else if (st === "error") {
      S.phase = "error";
      S.error = msg || "更新失败，请稍后再试";
      if (!S.silent) showToast(S.error);
    } else if (st === "idle") {
      S.phase = "available";
    }
    render();
  }

  /* ========================= 界面 ========================= */

  function statusText() {
    const cur = currentVersion();
    const curText = cur ? "v" + normVersion(cur) : "";
    switch (S.phase) {
      case "checking":
        return "正在检查 GitHub 上的新版本…";
      case "latest":
        return "已是最新版本" + (curText ? "（" + curText + "）" : "") + "。";
      case "available": {
        const size = S.release && S.release.size ? "，安装包 " + fmtSize(S.release.size) : "";
        return "发现新版本 v" + S.release.latest + size + "。覆盖安装即可，学习记录都会保留。";
      }
      case "downloading":
        return "正在下载" + (S.progress >= 0 ? " " + S.progress + "%" : "") +
          (S.total > 0 ? "（" + fmtSize(S.downloaded) + " / " + fmtSize(S.total) + "）" : "") + "…";
      case "verifying":
        return "下载完成，正在核对 SHA-256 校验值…";
      case "need_permission":
        return "请在系统设置里允许「青鸟 · 英语陪读」安装应用，返回后会自动继续安装。";
      case "installing":
        return "已打开系统安装器，按提示点「安装」即可；装好后打开就是新版本。";
      case "error":
        return S.error || "检查更新失败。";
      default:
        return "检查更新只连接 GitHub 官方接口，不发送任何个人信息；断网时什么也不做。";
    }
  }

  function installLabel() {
    switch (S.phase) {
      case "downloading":
        return S.progress >= 0 ? "下载中 " + S.progress + "%" : "下载中…";
      case "verifying":
        return "正在校验…";
      case "need_permission":
        return "去设置里允许安装";
      case "installing":
        return "等待安装完成";
      case "error":
        return "重新下载";
      default:
        return "立即下载并安装";
    }
  }

  function render() {
    const cur = currentVersion();
    const code = currentVersionCode();
    const verText = cur
      ? "青鸟 · 英语陪读 v" + normVersion(cur) + (code ? "（" + code + "）" : "")
      : "青鸟 · 英语陪读";
    setText("aboutVersion", verText);

    setText("updateStatus", statusText());
    const status = el("updateStatus");
    if (status) {
      status.classList.toggle("upd-warm", S.phase === "available" || S.phase === "downloading" || S.phase === "verifying");
      status.classList.toggle("upd-bad", S.phase === "error");
    }

    const rel = S.release && S.release.status === "update" ? S.release : null;
    const showNotes = !!rel && ["available", "downloading", "verifying", "need_permission", "installing", "error"].indexOf(S.phase) >= 0;
    toggle("updateNotes", "hidden", !showNotes);
    if (rel) {
      setText("updateVer", "v" + rel.latest);
      const body = el("updateNotesBody");
      if (body) {
        const text = rel.notes && rel.notes.trim() ? plainNotes(rel.notes) : "（这个版本没有写更新说明）";
        if (body.textContent !== text) body.textContent = text;
      }
    }

    const showBar = S.phase === "downloading" || S.phase === "verifying" || S.phase === "need_permission";
    toggle("updateBar", "hidden", !showBar);
    const fill = el("updateFill");
    if (fill) {
      const pct = S.phase === "verifying" || S.phase === "need_permission" ? 100 : Math.max(0, S.progress);
      fill.style.width = (pct >= 0 ? pct : 0) + "%";
    }
    if (showBar) {
      const pctText = S.phase === "downloading"
        ? (S.progress >= 0 ? S.progress + "%" : "下载中…")
        : (S.phase === "verifying" ? "校验中…" : "下载完成，等待授权");
      const sizeText = S.total > 0 ? " · " + fmtSize(S.downloaded) + " / " + fmtSize(S.total) : "";
      setText("updatePct", pctText + sizeText);
    } else {
      setText("updatePct", "");
    }

    const inst = el("btnUpdateInstall");
    if (inst) {
      inst.textContent = installLabel();
      inst.disabled = S.phase === "downloading" || S.phase === "verifying" || S.phase === "installing";
    }

    const checkBtn = el("btnCheckUpdate");
    if (checkBtn) {
      checkBtn.textContent = S.phase === "checking" ? "正在检查…" : "检查更新";
      checkBtn.disabled = S.phase === "checking" || S.phase === "downloading" || S.phase === "verifying";
    }

    toggle("setAutoUpdate", "on", autoEnabled());

    const st = readStore();
    const dismissed = st.dismissed === (rel ? rel.latest : null);
    const showBanner = !!rel && !dismissed && (S.phase === "available" || S.phase === "downloading" ||
      S.phase === "verifying" || S.phase === "need_permission");
    toggle("updateBanner", "hidden", !showBanner);
    if (showBanner) {
      setText("updateBannerText", S.phase === "available"
        ? "发现新版本 v" + rel.latest + " · 点这里更新"
        : (S.phase === "downloading" ? "正在下载新版本 " + (S.progress >= 0 ? S.progress + "%" : "") : "新版本待安装 · 点这里继续"));
    }

    const settingsTab = document.querySelector('#tabbar .tab[data-tab="settings"]');
    if (settingsTab) settingsTab.classList.toggle("has-update", !!rel && !dismissed);
  }

  /* ========================= 绑定 ========================= */

  function goSettings() {
    if (typeof hooks.openSettings === "function") hooks.openSettings();
    render();
  }

  function init(opts) {
    const o = opts || {};
    if (typeof o.toast === "function") hooks.toast = o.toast;
    if (typeof o.openSettings === "function") hooks.openSettings = o.openSettings;
    if (bound) { render(); return; }
    bound = true;

    const checkBtn = el("btnCheckUpdate");
    if (checkBtn) checkBtn.addEventListener("click", function () { check(false); });

    const installBtn = el("btnUpdateInstall");
    if (installBtn) installBtn.addEventListener("click", function () { install(); });

    const auto = el("setAutoUpdate");
    if (auto) auto.addEventListener("click", function () {
      const next = !autoEnabled();
      setAuto(next);
      showToast(next ? "启动时会自动检查更新" : "已关闭启动时自动检查");
    });

    const banner = el("btnUpdateBanner");
    if (banner) banner.addEventListener("click", goSettings);

    const close = el("btnUpdateClose");
    if (close) close.addEventListener("click", dismiss);

    render();
  }

  /** 启动后延迟一点再检查：先把书库渲染完，断网也不会拖慢开屏 */
  function autoCheckLater() {
    if (!autoEnabled()) return 0;
    return setTimeout(function () { check(true); }, AUTO_CHECK_DELAY);
  }

  window.Updater = {
    init: init,
    autoCheckLater: autoCheckLater,
    autoEnabled: autoEnabled,
    setAuto: setAuto,
    dismiss: dismiss,
    check: check,
    install: install,
    render: render,
    // 原生层回调
    onCheckResult: onCheckResult,
    onProgress: onProgress,
    onState: onState,
    // 纯函数与只读状态（自动化测试用）
    parseVersion: parseVersion,
    compareVersions: compareVersions,
    normVersion: normVersion,
    readRelease: readRelease,
    fmtSize: fmtSize,
    plainNotes: plainNotes,
    state: function () {
      return {
        phase: S.phase,
        release: S.release,
        error: S.error,
        progress: S.progress,
        downloaded: S.downloaded,
        total: S.total,
        silent: S.silent
      };
    }
  };
})();
