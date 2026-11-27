/* =========================================================
   青鸟 · 英语陪读 —— 应用内更新测试（jsdom，不需要安卓设备）
   覆盖：版本比较 / 检查结果解析与来源校验 / 设置页与横幅渲染 /
        自动检查开关 / 下载进度 / 权限与错误状态
   ========================================================= */

const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./harness.js");

/** 关闭启动自动检查，避免定时器干扰断言 */
const NO_AUTO = { storage: { "erc.update": { auto: false } } };

const RELEASE = {
  status: "update",
  current: "1.5.0",
  latest: "v1.6.1",
  notes: "· 统一名称为青鸟 · 英语陪读\n· 新增应用内自动更新",
  apkUrl: "https://github.com/idukang/english-reading-companion/releases/download/v1.6.1/EnglishReadingCompanion-v1.6.1.apk",
  shaUrl: "https://github.com/idukang/english-reading-companion/releases/download/v1.6.1/SHA256SUMS.txt",
  size: 260000000,
  silent: false
};

async function withApp(fn, opts) {
  const app = await h.boot(opts || NO_AUTO);
  try {
    await fn(app);
  } finally {
    app.win.close();
  }
}

function checkResult(win, payload) {
  return win.Updater.onCheckResult(typeof payload === "string" ? payload : JSON.stringify(payload));
}

/* ---------------------------- 纯函数 ---------------------------- */

test("版本比较：新版更大、1.6 与 1.6.0 相同、1.10 比 1.9 新", async function () {
  await withApp(async function ({ win }) {
    const cmp = win.Updater.compareVersions;
    assert.equal(cmp("1.6.1", "1.6.0"), 1);
    assert.equal(cmp("v1.6.1", "1.6.1"), 0);
    assert.equal(cmp("1.6", "1.6.0"), 0);
    assert.equal(cmp("1.10.0", "1.9.9"), 1);
    assert.equal(cmp("2.0", "1.99.99"), 1);
    assert.equal(cmp("1.5.0-test", "1.5.0"), 0);
    assert.equal(cmp("1.4.9", "1.5"), -1);
    assert.equal(win.Updater.parseVersion("v1.6.1-beta").join("."), "1.6.1");
    assert.equal(win.Updater.normVersion("v1.6"), "1.6");
  });
});

test("检查结果解析：合法结果可用，外来地址和缺安装包一律拒绝", async function () {
  await withApp(async function ({ win }) {
    const r = win.Updater.readRelease(JSON.stringify(RELEASE));
    assert.equal(r.ok, true);
    assert.equal(r.status, "update");
    assert.equal(r.latest, "1.6.1");
    assert.match(r.notes, /应用内自动更新/);

    const latest = win.Updater.readRelease({ status: "latest", latest: "1.5.0" });
    assert.equal(latest.ok, true);
    assert.equal(latest.status, "latest");

    const evil = win.Updater.readRelease(Object.assign({}, RELEASE, {
      apkUrl: "https://evil.example.com/app.apk"
    }));
    assert.equal(evil.ok, false);
    assert.match(evil.reason, /GitHub/);

    const httpUrl = win.Updater.readRelease(Object.assign({}, RELEASE, {
      apkUrl: "http://github.com/a/app.apk"
    }));
    assert.equal(httpUrl.ok, false);

    const noApk = win.Updater.readRelease({ status: "update", latest: "1.6.1" });
    assert.equal(noApk.ok, false);

    const badVer = win.Updater.readRelease(Object.assign({}, RELEASE, { latest: "latest" }));
    assert.equal(badVer.ok, false);

    const err = win.Updater.readRelease({ status: "error", error: "没有网络，连不上 GitHub" });
    assert.equal(err.ok, false);
    assert.match(err.reason, /没有网络/);

    const broken = win.Updater.readRelease("not json");
    assert.equal(broken.ok, false);

    assert.equal(win.Updater.plainNotes("## 标题\n- **加粗** 和 `代码`"), "标题\n· 加粗 和 代码");
  });
});

/* ---------------------------- 设置页 ---------------------------- */

test("设置页显示当前版本，默认开启启动自动检查", async function () {
  await withApp(async function ({ win, doc }) {
    const ver = doc.getElementById("aboutVersion").textContent;
    assert.match(ver, /青鸟 · 英语陪读/);
    assert.match(ver, /v1\.5\.0/);
    assert.match(ver, /10/);
    assert.ok(doc.getElementById("setAutoUpdate").classList.contains("on"), "默认应打开自动检查");
    assert.equal(win.Updater.autoEnabled(), true);
    assert.ok(doc.getElementById("updateNotes").classList.contains("hidden"), "没检查前不显示更新日志");
    assert.ok(doc.getElementById("updateBanner").classList.contains("hidden"));
  }, { storage: {} });
});

test("点「检查更新」会让原生层去查，并在界面上显示正在检查", async function () {
  await withApp(async function ({ win, doc, calls }) {
    h.clickSel(win, "#btnCheckUpdate");
    assert.deepEqual(calls.updateChecks, [false]);
    assert.equal(win.Updater.state().phase, "checking");
    assert.match(doc.getElementById("updateStatus").textContent, /正在检查/);
    assert.equal(doc.getElementById("btnCheckUpdate").disabled, true);
  });
});

test("发现新版：横幅、设置红点、更新日志和安装按钮一起出现", async function () {
  await withApp(async function ({ win, doc }) {
    checkResult(win, RELEASE);
    const st = win.Updater.state();
    assert.equal(st.phase, "available");
    assert.equal(st.release.latest, "1.6.1");

    const banner = doc.getElementById("updateBanner");
    assert.equal(banner.classList.contains("hidden"), false);
    assert.match(doc.getElementById("updateBannerText").textContent, /v1\.6\.1/);

    const tab = doc.querySelector('#tabbar .tab[data-tab="settings"]');
    assert.ok(tab.classList.contains("has-update"), "设置页应有红点");

    const notes = doc.getElementById("updateNotes");
    assert.equal(notes.classList.contains("hidden"), false);
    assert.equal(doc.getElementById("updateVer").textContent, "v1.6.1");
    assert.match(doc.getElementById("updateNotesBody").textContent, /统一名称/);
    // Release 说明里的 Markdown 会变成适合手机阅读的纯文本
    assert.equal(doc.getElementById("updateNotesBody").textContent.indexOf("· "), 0);
    assert.equal(/[*#`]/.test(doc.getElementById("updateNotesBody").textContent), false);

    const install = doc.getElementById("btnUpdateInstall");
    assert.equal(install.disabled, false);
    assert.match(install.textContent, /立即下载并安装/);
    assert.match(doc.getElementById("updateStatus").textContent, /发现新版本 v1\.6\.1/);
    assert.match(doc.getElementById("updateStatus").textContent, /248 MB/);
  });
});

test("点横幅跳到设置页；关掉横幅后设置里仍能更新", async function () {
  await withApp(async function ({ win, doc }) {
    checkResult(win, RELEASE);
    h.clickSel(win, "#btnUpdateBanner");
    assert.ok(doc.getElementById("view-settings").classList.contains("active"));

    h.clickSel(win, "#btnUpdateClose");
    assert.ok(doc.getElementById("updateBanner").classList.contains("hidden"));
    const saved = JSON.parse(win.localStorage.getItem("erc.update"));
    assert.equal(saved.dismissed, "1.6.1");
    assert.equal(doc.getElementById("updateNotes").classList.contains("hidden"), false);
    assert.equal(doc.querySelector('#tabbar .tab[data-tab="settings"]').classList.contains("has-update"), false);
  });
});

test("已是最新版本：不显示横幅，状态和红点都清掉", async function () {
  await withApp(async function ({ win, doc }) {
    checkResult(win, RELEASE);
    checkResult(win, { status: "latest", latest: "1.5.0", silent: false });
    assert.equal(win.Updater.state().phase, "latest");
    assert.ok(doc.getElementById("updateBanner").classList.contains("hidden"));
    assert.ok(doc.getElementById("updateNotes").classList.contains("hidden"));
    assert.match(doc.getElementById("updateStatus").textContent, /已是最新版本/);
    assert.equal(doc.querySelector('#tabbar .tab[data-tab="settings"]').classList.contains("has-update"), false);
  });
});

test("原生层说「有 1.5.0」而本机已经 1.5.0：不提示更新", async function () {
  await withApp(async function ({ win, doc }) {
    checkResult(win, { status: "update", latest: "1.5.0", apkUrl: RELEASE.apkUrl, notes: "x", size: 1 });
    assert.equal(win.Updater.state().phase, "latest");
    assert.ok(doc.getElementById("updateBanner").classList.contains("hidden"));
  });
});

test("手动检查失败：说明原因并弹一条提示", async function () {
  await withApp(async function ({ win, doc }) {
    checkResult(win, { status: "error", error: "没有网络，连不上 GitHub", silent: false });
    assert.equal(win.Updater.state().phase, "error");
    assert.match(doc.getElementById("updateStatus").textContent, /没有网络/);
    assert.equal(doc.querySelectorAll("#toast .toast-item").length, 1);
  });
});

test("静默检查失败：只在设置页留原因，不弹提示", async function () {
  await withApp(async function ({ win, doc }) {
    checkResult(win, { status: "error", error: "连接 GitHub 超时，请检查网络", silent: true });
    assert.equal(win.Updater.state().phase, "error");
    assert.match(doc.getElementById("updateStatus").textContent, /超时/);
    assert.equal(doc.querySelectorAll("#toast .toast-item").length, 0);
  });
});

/* ---------------------------- 下载与安装 ---------------------------- */

test("点「立即下载并安装」把官方地址交给原生层", async function () {
  await withApp(async function ({ win, calls }) {
    checkResult(win, RELEASE);
    h.clickSel(win, "#btnUpdateInstall");
    assert.equal(calls.updateDownloads.length, 1);
    assert.equal(calls.updateDownloads[0].apkUrl, RELEASE.apkUrl);
    assert.equal(calls.updateDownloads[0].shaUrl, RELEASE.shaUrl);
    assert.equal(win.Updater.state().phase, "downloading");
  });
});

test("下载进度：百分比和进度条跟着原生层回报走", async function () {
  await withApp(async function ({ win, doc }) {
    checkResult(win, RELEASE);
    h.clickSel(win, "#btnUpdateInstall");
    win.Updater.onProgress(42, 42000000, 100000000);
    assert.equal(doc.getElementById("updateFill").style.width, "42%");
    assert.match(doc.getElementById("updatePct").textContent, /42%/);
    assert.match(doc.getElementById("updatePct").textContent, /40 MB/);
    assert.equal(doc.getElementById("btnUpdateInstall").disabled, true);
    assert.match(doc.getElementById("btnUpdateInstall").textContent, /42%/);

    win.Updater.onState("verifying", "");
    assert.match(doc.getElementById("updateStatus").textContent, /SHA-256/);
    assert.equal(doc.getElementById("updateFill").style.width, "100%");
  });
});

test("没有「安装未知应用」权限：提示去设置，点按钮会打开系统设置", async function () {
  await withApp(async function ({ win, doc, calls }) {
    checkResult(win, RELEASE);
    win.Updater.onState("need_permission", "请在系统设置里允许安装应用");
    assert.equal(win.Updater.state().phase, "need_permission");
    assert.match(doc.getElementById("updateStatus").textContent, /系统设置/);
    const btn = doc.getElementById("btnUpdateInstall");
    assert.match(btn.textContent, /去设置里允许安装/);
    h.click(win, btn);
    assert.equal(calls.openedInstallSettings, 1);
  });
});

test("安装阶段与出错状态：按钮和说明跟着变", async function () {
  await withApp(async function ({ win, doc }) {
    checkResult(win, RELEASE);
    win.Updater.onState("installing", "已打开系统安装器");
    assert.equal(doc.getElementById("btnUpdateInstall").disabled, true);
    assert.match(doc.getElementById("updateStatus").textContent, /系统安装器/);

    win.Updater.onState("error", "安装包校验不一致（可能下载损坏），已删除，请重试");
    assert.equal(win.Updater.state().phase, "error");
    assert.match(doc.getElementById("updateStatus").textContent, /校验不一致/);
    assert.match(doc.getElementById("btnUpdateInstall").textContent, /重新下载/);
    assert.equal(doc.getElementById("btnUpdateInstall").disabled, false);
  });
});

/* ---------------------------- 自动检查开关 ---------------------------- */

test("自动检查开关：关掉后写进本机，重开也只保留选择", async function () {
  await withApp(async function ({ win, doc }) {
    const sw = doc.getElementById("setAutoUpdate");
    assert.ok(sw.classList.contains("on"));
    h.click(win, sw);
    assert.equal(win.Updater.autoEnabled(), false);
    assert.equal(sw.classList.contains("on"), false);
    assert.equal(JSON.parse(win.localStorage.getItem("erc.update")).auto, false);

    h.click(win, sw);
    assert.equal(win.Updater.autoEnabled(), true);
    assert.equal(JSON.parse(win.localStorage.getItem("erc.update")).auto, true);
  }, { storage: {} });
});

test("启动时自动检查：开着才静默查一次，关着完全不联网", async function () {
  await withApp(async function ({ calls }) {
    await h.sleep(1600);
    assert.deepEqual(calls.updateChecks, [true], "自动检查应带 silent=true");
  }, { storage: {} });

  await withApp(async function ({ calls }) {
    await h.sleep(1600);
    assert.deepEqual(calls.updateChecks, [], "关掉自动检查后不应发起任何检查");
  }, { storage: { "erc.update": { auto: false } } });
});

test("网页预览版（没有原生桥）不会假装能更新", async function () {
  await withApp(async function ({ win, doc }) {
    delete win.AndroidBridge.checkForUpdate;
    h.clickSel(win, "#btnCheckUpdate");
    assert.equal(win.Updater.state().phase, "error");
    assert.match(doc.getElementById("updateStatus").textContent, /不支持应用内更新/);
    assert.ok(doc.getElementById("updateBanner").classList.contains("hidden"));
  });
});
