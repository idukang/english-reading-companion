/* =========================================================
   测试用的 jsdom 环境：按 index.html 的顺序加载 www 下的离线页面
   —— 不联网、不启动模拟器，只验证真实的 DOM 交互与本地数据。
   ========================================================= */

const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const WWW = path.join(__dirname, "..", "app", "src", "main", "assets", "www");
const SCRIPTS = ["library.js", "dict.js", "cefr.js", "persona.js", "scenarios.js", "challenge.js", "quiz.js", "memory-book.js", "updater.js", "app.js"];

function read(file) {
  return fs.readFileSync(path.join(WWW, file), "utf8");
}

function makeAudioContext(counts) {
  return class FakeAudioContext {
    constructor() {
      this.state = "running";
      this.currentTime = 0;
      this.destination = {};
      counts.audioContexts++;
    }
    resume() { this.state = "running"; }
    createOscillator() {
      const osc = {
        type: "sine",
        frequency: { value: 0, setValueAtTime(v) { this.value = v; } },
        connect() { return this; },
        start() { counts.oscillators++; },
        stop() {}
      };
      return osc;
    }
    createGain() {
      return {
        gain: {
          value: 0,
          setValueAtTime() {},
          exponentialRampToValueAtTime() {}
        },
        connect() { return this; }
      };
    }
  };
}

/**
 * 启动一个干净的 App 实例。
 * @param {object} opts
 *   storage  预置的 localStorage 内容 {key: value(对象或字符串)}
 */
function boot(opts) {
  const options = opts || {};
  const html = read("index.html").replace(/<script[^>]*><\/script>/g, "");
  const dom = new JSDOM(html, {
    url: "https://app.local/",
    runScripts: "dangerously",
    pretendToBeVisual: true
  });
  const win = dom.window;
  const doc = win.document;

  if (options.storage) {
    Object.keys(options.storage).forEach(function (k) {
      const v = options.storage[k];
      win.localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
    });
  }

  const calls = {
    speak: [],
    stopSpeak: 0,
    recordings: 0,
    audioContexts: 0,
    oscillators: 0,
    muted: false,
    stt: [],
    updateChecks: [],
    updateDownloads: [],
    openedInstallSettings: 0
  };

  // 原生桥：朗读只记录，不真的出声；录音同理
  win.AndroidBridge = {
    appVersion: function () { return "1.5.0-test"; },
    isTtsReady: function () { return true; },
    hasNeuralVoice: function () { return true; },
    voiceEngineState: function () { return "ready"; },
    isMediaMuted: function () { return calls.muted; },
    speak: function (id, text, rate, lang) {
      calls.speak.push({ id: id, text: text, rate: rate, lang: lang });
    },
    stopSpeak: function () { calls.stopSpeak++; },
    setEnglishVoice: function () {},
    setSystemBars: function () {},
    setAsrLanguage: function () {},
    hasAsr: function () { return true; },
    isAsrReady: function () { return true; },
    prepareAsr: function () {},
    hasRecording: function () { return calls.recordings > 0; },
    startRecording: function () { calls.recordings++; },
    stopRecording: function () {},
    playRecording: function () {},
    deleteRecording: function () {},
    isRecording: function () { return false; },
    isSpeechAvailable: function () { return true; },
    canUseVoiceDialog: function () { return false; },
    isVoiceServiceActive: function () { return false; },
    httpRequest: function () {},
    httpStream: function () {},
    cancelHttp: function () {},
    appVersionName: function () { return "1.5.0-test"; },
    appVersionCode: function () { return 10; },
    checkForUpdate: function (silent) { calls.updateChecks.push(!!silent); },
    downloadAndInstallUpdate: function (apkUrl, shaUrl) { calls.updateDownloads.push({ apkUrl: apkUrl, shaUrl: shaUrl }); },
    canInstallPackages: function () { return true; },
    openInstallPermissionSettings: function () { calls.openedInstallSettings++; }
  };

  win.AudioContext = makeAudioContext(calls);
  win.speechSynthesis = {
    cancel: function () {},
    speak: function (u) { calls.stt.push(u); }
  };
  win.SpeechSynthesisUtterance = function (text) { this.text = text; };

  // jsdom 没实现这些排版 / 媒体 API，补上最小实现
  win.Element.prototype.scrollIntoView = function () {};
  win.HTMLElement.prototype.animate = function () { return { cancel: function () {}, finished: Promise.resolve() }; };

  SCRIPTS.forEach(function (file) {
    const el = doc.createElement("script");
    el.textContent = read(file) + "\n//# sourceURL=" + file;
    doc.body.appendChild(el);
  });

  // 等 DOMContentLoaded / load，让 boot() 跑完
  return new Promise(function (resolve, reject) {
    const timer = setTimeout(function () {
      // 有些 jsdom 版本不会替我们补事件，兜底手动触发一次
      try {
        if (!doc.getElementById("passageList").children.length) {
          doc.dispatchEvent(new win.Event("DOMContentLoaded"));
        }
      } catch (e) {}
      setTimeout(finish, 30);
    }, 120);

    function finish() {
      clearTimeout(timer);
      try {
        resolve({ dom: dom, win: win, doc: doc, calls: calls });
      } catch (e) { reject(e); }
    }

    if (doc.readyState === "complete") {
      setTimeout(finish, 30);
    } else {
      win.addEventListener("load", function () { setTimeout(finish, 30); });
    }
    win.addEventListener("error", function (e) { reject(e.error || new Error("window error")); });
  });
}

/** 点击一个元素（走真实的 click 事件，和手指点屏幕一样） */
function click(win, el) {
  if (!el) throw new Error("要点击的元素不存在");
  el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
  return el;
}

/** 按 data-act / data-pz / id 找元素并点击 */
function clickSel(win, selector) {
  const el = win.document.querySelector(selector);
  if (!el) throw new Error("找不到元素：" + selector);
  return click(win, el);
}

/** 直接操作输入框（模拟用户输入） */
function type(win, selector, value) {
  const el = win.document.querySelector(selector);
  if (!el) throw new Error("找不到输入框：" + selector);
  el.value = value;
  el.dispatchEvent(new win.Event("input", { bubbles: true }));
  return el;
}

/** 让经纬度并等待一段真实时间（词块拼满后有个 180ms 的判题延时） */
function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

/** 从 localStorage 取某个档案下的闯关数据 */
function patternData(win, profileId) {
  const raw = win.localStorage.getItem("erc.p." + profileId + ".patterns");
  return raw ? JSON.parse(raw) : null;
}

module.exports = {
  WWW,
  boot,
  click,
  clickSel,
  type,
  sleep,
  patternData
};
