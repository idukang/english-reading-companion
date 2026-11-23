/* ===========================================================
   英语陪读 —— 应用逻辑
   · 全部内容本地运行，不加载任何外部脚本、不发送统计
   · 与安卓外壳通过 window.AndroidBridge 通信（TTS / 录音 / 语音识别 / 联网）
   =========================================================== */

(function () {
  "use strict";

  /* ========================= 工具 ========================= */

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function attr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function norm(s) {
    return (" " + String(s == null ? "" : s)
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/[^a-z0-9' ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() + " ");
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.remove("hidden");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add("hidden"); }, 2600);
  }

  const Bridge = window.AndroidBridge || null;

  const LS = {
    get: function (k, def) {
      try {
        const v = localStorage.getItem(k);
        return v ? JSON.parse(v) : def;
      } catch (e) { return def; }
    },
    set: function (k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
    }
  };

  const DEFAULTS = {
    theme: "light",
    font: "m",
    speed: 1.0,
    accent: "en-US",
    bilingual: true,
    autoPlay: true,
    loop: false,
    notes: true,
    autoTurn: false
  };

  const State = {
    settings: Object.assign({}, DEFAULTS, LS.get("erc.settings", {})),
    vocab: LS.get("erc.vocab", []),
    read: LS.get("erc.read", []),
    custom: LS.get("erc.custom", []),
    done: LS.get("erc.done", {}),
    ai: LS.get("erc.ai", null),
    guideDismissed: LS.get("erc.guide", false),
    showMastered: false
  };
  if (!Array.isArray(State.vocab)) State.vocab = [];
  if (!Array.isArray(State.read)) State.read = [];
  if (!Array.isArray(State.custom)) State.custom = [];

  function saveSettings() { LS.set("erc.settings", State.settings); }
  function saveVocab() { LS.set("erc.vocab", State.vocab); }

  /* ========================= 朗读 ========================= */

  const TTS = {
    seq: 0,
    current: null,
    pending: {},
    queue: [],
    queueOpts: null,
    streamPending: false,

    speak: function (text, opts) {
      opts = opts || {};
      const rate = opts.rate || State.settings.speed || 1.0;
      const lang = opts.lang || State.settings.accent || "en-US";
      const id = "u" + (++this.seq);
      this.current = id;

      if (Bridge) {
        this.pending[id] = opts;
        try {
          Bridge.speak(id, text, rate, lang);
        } catch (e) {
          delete this.pending[id];
          this.fallback(text, opts);
        }
        return id;
      }
      this.fallback(text, opts);
      return id;
    },

    enqueue: function (text, opts) {
      const t = String(text || "").trim();
      if (!t) return;
      if (opts) this.queueOpts = opts;
      if (!this.current && this.queue.length === 0) {
        const qo = this.queueOpts || {};
        this.speak(t, {
          rate: qo.rate,
          lang: qo.lang,
          onStart: qo.onFirstStart,
          onEnd: function () { TTS._drainQueue(); }
        });
      } else {
        this.queue.push(t);
      }
    },

    _drainQueue: function () {
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        const qo = this.queueOpts || {};
        this.speak(next, {
          rate: qo.rate,
          lang: qo.lang,
          onEnd: function () { TTS._drainQueue(); }
        });
        return;
      }
      if (!this.streamPending && this.queueOpts && this.queueOpts.onAllEnd) {
        const done = this.queueOpts.onAllEnd;
        this.queueOpts = null;
        done();
      }
    },

    finishStreamQueue: function () {
      this.streamPending = false;
      if (!this.current && this.queue.length === 0 && this.queueOpts && this.queueOpts.onAllEnd) {
        const done = this.queueOpts.onAllEnd;
        this.queueOpts = null;
        done();
      }
    },

    fallback: function (text, opts) {
      if (window.speechSynthesis) {
        try {
          window.speechSynthesis.cancel();
          const u = new SpeechSynthesisUtterance(text);
          u.lang = State.settings.accent || "en-US";
          u.rate = (opts && opts.rate) || State.settings.speed || 1.0;
          if (opts && opts.onStart) opts.onStart();
          u.onend = function () { if (opts && opts.onEnd) opts.onEnd(); };
          window.speechSynthesis.speak(u);
          return;
        } catch (e) {}
      }
      toast("本机没有可用的语音朗读引擎");
      if (opts && opts.onStart) opts.onStart();
      if (opts && opts.onEnd) setTimeout(opts.onEnd, 10);
    },

    stop: function () {
      this.current = null;
      this.pending = {};
      this.queue = [];
      this.queueOpts = null;
      this.streamPending = false;
      if (Bridge) { try { Bridge.stopSpeak(); } catch (e) {} }
      if (window.speechSynthesis) { try { window.speechSynthesis.cancel(); } catch (e) {} }
    }
  };

  /* ========================= 联网（走原生，避开网页跨域限制） ========================= */

  const Http = {
    seq: 0,
    pending: {},
    streams: {},

    cancelStream: function (id) {
      if (!id) return;
      delete this.streams[id];
      if (Bridge && Bridge.cancelHttp) {
        try { Bridge.cancelHttp(id); } catch (e) {}
      }
    },

    stream: function (method, url, headers, body, handlers) {
      const id = "s" + (++this.seq);
      this.streams[id] = handlers || {};
      if (Bridge && Bridge.httpStream) {
        try {
          Bridge.httpStream(id, method, url, JSON.stringify(headers || {}), body == null ? "" : body);
          return id;
        } catch (e) {
          delete this.streams[id];
        }
      }
      // Fallback to non-streaming request
      this.request(method, url, headers, body).then(function (text) {
        let content = "";
        try {
          const data = JSON.parse(text);
          if (data.error) throw new Error(data.error.message || data.error.code || "接口返回错误");
          if (data.choices && data.choices[0]) {
            const c = data.choices[0];
            content = (c.message && c.message.content) || c.text || "";
          }
        } catch (e) {
          if (handlers && handlers.onError) handlers.onError(0, e.message);
          return;
        }
        if (handlers && handlers.onChunk && content) handlers.onChunk(content, content);
        if (handlers && handlers.onDone) handlers.onDone(content);
      }).catch(function (e) {
        if (handlers && handlers.onError) handlers.onError(0, e.message);
      });
      return id;
    },
    request: function (method, url, headers, body) {
      return new Promise(function (resolve, reject) {
        if (!/^https:\/\//i.test(url || "")) {
          reject(new Error("接口地址必须以 https:// 开头"));
          return;
        }
        const id = "h" + (++Http.seq);
        let done = false;
        const finish = function (fn, arg) {
          if (done) return;
          done = true;
          delete Http.pending[id];
          fn(arg);
        };
        Http.pending[id] = {
          ok: function (code, text) {
            if (code >= 200 && code < 300) finish(resolve, text);
            else finish(reject, new Error("HTTP " + code + "：" + String(text || "").slice(0, 180)));
          },
          fail: function (msg) { finish(reject, new Error(msg || "网络请求失败")); }
        };

        if (Bridge && Bridge.httpRequest) {
          try {
            Bridge.httpRequest(id, method, url, JSON.stringify(headers || {}), body == null ? "" : body);
          } catch (e) {
            Http.pending[id].fail("无法发起请求");
          }
        } else if (window.fetch) {
          fetch(url, { method: method, headers: headers || {}, body: body })
            .then(function (r) { return r.text().then(function (t) { return { c: r.status, t: t }; }); })
            .then(function (o) {
              if (Http.pending[id]) Http.pending[id].ok(o.c, o.t);
            })
            .catch(function (e) {
              if (Http.pending[id]) Http.pending[id].fail(e.message);
            });
        } else {
          Http.pending[id].fail("此环境不支持联网请求");
        }

        setTimeout(function () {
          if (Http.pending[id]) Http.pending[id].fail("请求超时（45 秒），请检查网络或接口地址");
        }, 45000);
      });
    }
  };

  /* ========================= 原生回调 ========================= */

  window.Native = {
    onTtsReady: function () {},

    onTtsUnavailable: function () {
      toast("本机语音引擎不可用，朗读功能可能受限");
    },

    onSpeakStart: function (id) {
      const cb = TTS.pending[id];
      if (TTS.current !== id) return;
      if (cb && cb.onStart) cb.onStart();
    },

    onSpeakEnd: function (id) {
      const cb = TTS.pending[id];
      delete TTS.pending[id];
      if (TTS.current !== id) return;
      TTS.current = null;
      if (cb && cb.onEnd) cb.onEnd();
    },

    onSpeakError: function (id) {
      const cb = TTS.pending[id];
      delete TTS.pending[id];
      if (TTS.current !== id) return;
      TTS.current = null;
      if (cb && cb.onError) cb.onError();
      else if (cb && cb.onEnd) cb.onEnd();
    },

    onRecordState: function (state, info) {
      // 备用条自己结束时停掉的录音，不再弹“录好了”之类的提示
      if (Sf.silent && (state === "recorded" || state === "error" || state === "idle")) {
        Sf.silent = false;
        Sf.recording = false;
        return;
      }
      // 对话页里的录音属于“语音识别不可用”的备用方式，交给 Sf 处理
      if (Sf.active && currentView === "chat") {
        Sf.onState(state, info);
        return;
      }
      Rec.onState(state, info);
    },

    onPlaybackEnd: function () {
      Rec.playbackDone();
    },

    onPermissionResult: function (perm, granted) {
      if (!granted) toast("没有麦克风权限，跟读和语音回答都用不了；可以在系统设置里打开");
      Rec.refresh();
    },

    onSpeechState: function (state, info) {
      ASR.onState(state, info);
    },

    onSpeechResult: function (text, isFinal, lang) {
      ASR.onResult(text, isFinal, lang);
    },

    onSpeechError: function (code, msg) {
      ASR.onError(code, msg);
    },

    onHttpResponse: function (id, code, body) {
      const p = Http.pending[id];
      if (!p) return;
      p.ok(code, body);
    },

    onHttpStreamChunk: function (id, delta, full) {
      const s = Http.streams[id];
      if (s && s.onChunk) s.onChunk(delta, full);
    },

    onHttpStreamDone: function (id, full) {
      const s = Http.streams[id];
      delete Http.streams[id];
      if (s && s.onDone) s.onDone(full);
    },

    onHttpStreamError: function (id, code, msg) {
      const s = Http.streams[id];
      delete Http.streams[id];
      if (s && s.onError) s.onError(code, msg);
    },

    onAsrState: function (state, msg) {
      Ear.onAsr(state, msg);
    },

    onVoiceService: function (state, msg) {
      Ear.onService(state, msg);
    },

    onBargeIn: function (text) {
      Ear.onBargeIn(text);
    },

    onTtsNote: function (code, msg) {
      if (msg) toast(msg);
    }
  };

  /* ========================= 录音跟读 ========================= */

  const Rec = {
    has: false,
    state: "idle",
    sentence: 0,

    start: function (idx) {
      if (!Bridge) { toast("此版本的设备不支持录音"); return; }
      this.sentence = idx;
      TTS.stop();
      if (State.settings.autoPlay) {
        const text = Reader.plain(idx);
        const self = this;
        TTS.speak(text, {
          onEnd: function () {
            setTimeout(function () { self.beginRecord(); }, 260);
          }
        });
      } else {
        this.beginRecord();
      }
    },

    beginRecord: function () {
      try { Bridge.startRecording(); } catch (e) { toast("无法开始录音"); }
    },

    toggle: function () {
      if (this.state === "recording") {
        try { Bridge.stopRecording(); } catch (e) {}
      } else {
        this.start(Reader.activeIdx());
      }
    },

    play: function () {
      if (!this.has) { toast("还没有录音，先按“跟读这句”"); return; }
      try { Bridge.playRecording(); } catch (e) { toast("无法播放录音"); }
    },

    remove: function () {
      if (!Bridge) return;
      try { Bridge.deleteRecording(); } catch (e) {}
    },

    compare: function () {
      if (!this.has) { toast("先说一句，再对比"); return; }
      const text = Reader.plain(this.sentence);
      const self = this;
      toast("先听原文，再听你的录音");
      TTS.speak(text, {
        onEnd: function () {
          setTimeout(function () {
            try { Bridge.playRecording(); } catch (e) {}
          }, 320);
        }
      });
    },

    refresh: function () {
      const btnRec = $("btnRec");
      const rec = this.state === "recording";
      btnRec.textContent = rec ? "⏹ 停止录音" : "🎤 跟读这句";
      btnRec.classList.toggle("primary", !rec);
      $("btnPlayMine").disabled = !this.has;
      $("btnCompare").disabled = !this.has;
      $("btnDelRec").disabled = !this.has;
    },

    onState: function (state, info) {
      if (state === "permission") {
        toast("正在请求麦克风权限…");
      } else if (state === "recording") {
        this.state = "recording";
        this.refresh();
      } else if (state === "recorded") {
        this.state = "idle";
        this.has = true;
        this.refresh();
        const sec = (parseInt(info, 10) || 0) / 1000;
        toast("录好了" + (sec > 0.2 ? "（" + sec.toFixed(1) + " 秒）" : "") + "，点“我的录音”听一遍");
      } else if (state === "playing") {
        toast("正在播放你的录音…");
      } else if (state === "deleted") {
        this.has = false;
        this.state = "idle";
        this.refresh();
        toast("录音已删除");
      } else if (state === "error") {
        this.state = "idle";
        this.refresh();
        const map = {
          empty: "没录到声音，靠近一点再说",
          no_recording: "还没有录音",
          record_failed: "录音失败，请检查麦克风是否被别的应用占用"
        };
        toast(map[info] || "录音出错，请重试");
      } else {
        this.state = "idle";
        this.refresh();
      }
    },

    playbackDone: function () {
      this.refresh();
    }
  };

  /* ============== 语音识别不可用时的备用输入条（对话页） ============== */

  const Sf = {
    active: false,
    recording: false,
    recorded: false,
    silent: false,

    show: function (msg) {
      if (currentView !== "chat") return;
      const box = $("speechFallback");
      if (!box) return;
      this.active = true;
      box.classList.remove("hidden");
      $("sfTitle").textContent = msg || "语音识别在这台手机上不稳定，换一种方式接着说：";
      this.renderChips();
      this.refresh();
      $("chatHintLine").textContent = "点上面的任意一种方式继续，或者直接打字";
    },

    hide: function () {
      if (this.recording && Bridge) {
        this.silent = true;
        try { Bridge.stopRecording(); } catch (e) {}
      }
      this.active = false;
      this.recording = false;
      const box = $("speechFallback");
      if (box) box.classList.add("hidden");
    },

    renderChips: function () {
      const wrap = $("sfChips");
      if (!wrap) return;
      let list = [];
      if (Chat.mode === "ai" || !Chat.scenario) {
        list = ["That sounds great!", "Can you say that again?", "Let me try again."];
      } else {
        const t = Chat.currentTurn();
        if (t) {
          list = (t.chips || []).slice(0, 3);
          if (!list.length && t.model) list = [t.model];
        }
      }
      wrap.innerHTML = list.map(function (c) {
        return '<button class="hint-chip" data-act="use-chip" data-text="' + attr(c) + '">' + esc(c) + "</button>";
      }).join("");
    },

    toggleRecord: function () {
      if (!Bridge) { toast("这个版本不支持录音"); return; }
      if (this.recording) {
        try { Bridge.stopRecording(); } catch (e) {}
        return;
      }
      this.recording = true;
      this.recorded = false;
      this.refresh();
      try {
        Bridge.startRecording();
      } catch (e) {
        this.recording = false;
        this.refresh();
        toast("无法开始录音");
      }
    },

    play: function () {
      if (!this.recorded) { toast("先录一句，再听自己的发音"); return; }
      if (!Bridge) return;
      try { Bridge.playRecording(); } catch (e) { toast("无法播放录音"); }
    },

    done: function () {
      const typed = ($("chatText").value || "").trim();
      if (typed) { Chat.send(typed); return; }
      Chat.sayAloudAndContinue();
    },

    refresh: function () {
      const rec = $("sfRecBtn");
      const play = $("sfPlayBtn");
      if (!rec || !play) return;
      rec.textContent = this.recording ? "⏹ 停止录音" : (this.recorded ? "🔁 重录一句" : "🎙️ 录音口语对比");
      rec.classList.toggle("on", this.recording);
      play.disabled = !this.recorded;
    },

    onState: function (state, info) {
      if (state === "permission") {
        toast("正在请求麦克风权限…");
      } else if (state === "recording") {
        this.recording = true;
        this.recorded = false;
        this.refresh();
      } else if (state === "recorded") {
        this.recording = false;
        this.recorded = true;
        Rec.has = true;
        Rec.state = "idle";
        this.refresh();
        toast("录好了：可以点“听我的录音”对比，或者点“我已说完，继续”");
      } else if (state === "playing") {
        toast("正在播放你的录音…");
      } else if (state === "error") {
        this.recording = false;
        this.refresh();
        toast("录音失败，检查一下麦克风权限，或者有没有被别的应用占用");
      } else {
        this.recording = false;
        this.refresh();
      }
    }
  };

  /* ========================= 语音识别 ========================= */

  function preloadAsr() {
    if (Bridge && Bridge.prepareAsr) {
      try { Bridge.prepareAsr(); } catch (e) {}
    }
  }

  const OfflineASR = {
    available: function () {
      if (!Bridge || !Bridge.hasAsr) return false;
      try { return !!Bridge.hasAsr(); } catch (e) { return false; }
    },
    ready: function () {
      if (!Bridge || !Bridge.isAsrReady) return false;
      try { return !!Bridge.isAsrReady(); } catch (e) { return false; }
    }
  };

  const ASR = {
    cb: null,
    live: null,
    listening: false,
    dialog: false,
    // 本次会话里语音识别已经坏过：不再自动开麦，免得每轮都弹一次提示
    failed: false,
    failMsg: "",

    available: function () {
      if (OfflineASR.available()) return true;
      if (!Bridge) return false;
      try {
        return Bridge.isSpeechAvailable ? !!Bridge.isSpeechAvailable() : true;
      } catch (e) { return false; }
    },

    start: function (opts) {
      opts = opts || {};
      this.dialog = false;
      if (!Bridge) {
        toast("当前环境不支持语音识别，用键盘输入吧");
        return;
      }
      // 优先用打包在安装包里的离线识别（不依赖系统语音服务，中英都能听）
      if (OfflineASR.available()) {
        this.cb = opts.onText || null;
        this.live = opts.input || null;
        this.failed = false;
        this.failMsg = "";
        if (Bridge.prepareAsr) { try { Bridge.prepareAsr(); } catch (e) {} }
        Sf.hide();
        try {
          Bridge.startAsrListen(false);
          this.listening = true;
          this.button(true);
          if (currentView === "chat") {
            Stage.listen();
            $("chatHintLine").textContent = "听着呢——" + Ear.modeTip();
          }
        } catch (e) {
          this.markFailed();
        }
        return;
      }
      if (opts.auto && this.failed) {
        Stage.settle();
        Chat.showFallback(this.failMsg);
        return;
      }
      this.cb = opts.onText || null;
      this.live = opts.input || null;
      try {
        Bridge.startListening();
        this.listening = true;
      } catch (e) {
        this.markFailed();
      }
    },

    stop: function () {
      if (Bridge && Bridge.stopAsrListen) { try { Bridge.stopAsrListen(); } catch (e) {} }
      if (Bridge && Bridge.stopListening) { try { Bridge.stopListening(); } catch (e) {} }
      this.listening = false;
      this.dialog = false;
      this.button(false);
    },

    /** 识别真的用不了：记下状态，并在对话页展示打字/录音的备用方式。 */
    markFailed: function (msg) {
      this.failed = true;
      this.failMsg = msg || "这台手机的语音识别没能启动，先用下面任意一种方式接着说：";
      this.listening = false;
      this.dialog = false;
      this.cb = null;
      this.button(false);
      if (currentView === "chat") {
        Stage.settle();
        Chat.showFallback(this.failMsg);
      } else {
        toast("语音识别用不了，直接在输入框里打字就好");
      }
    },

    onState: function (state, info) {
      if (state === "listening") {
        this.listening = true;
        this.dialog = false;
        this.button(true);
        if (currentView === "chat") Stage.listen();
      } else if (state === "permission") {
        toast("正在请求麦克风权限…");
      } else if (state === "dialog") {
        this.listening = false;
        this.dialog = true;
        this.button(false);
        if (currentView === "chat") {
          Stage.listen();
          $("chatHintLine").textContent = "系统语音输入已打开：说完这句会自动发出去";
        }
      } else if (state === "unavailable") {
        this.markFailed("这台手机没有可用的语音识别，先用下面任意一种方式接着说：");
      } else if (state === "cancelled") {
        this.markFailed("系统语音输入没有结果，先用下面任意一种方式接着说：");
      } else if (state === "processing") {
        this.button(true);
        if (currentView === "chat") Stage.think();
      } else {
        this.listening = false;
        this.button(false);
      }
    },

    onResult: function (text, isFinal, lang) {
      if (!text) return;
      const lg = lang || (/[\u4e00-\u9fff]/.test(text) ? "zh" : "en");
      if (Ear.on) {
        if (isFinal) Ear.onFinal(text, lg);
        else Ear.onPartial(text, lg);
        return;
      }
      if (this.live) this.live.value = text;
      if (isFinal) {
        this.listening = false;
        this.dialog = false;
        this.failed = false;
        this.failMsg = "";
        this.button(false);
        Sf.hide();
        const cb = this.cb;
        this.cb = null;
        if (cb) cb(text);
        else if (currentView === "chat") Chat.send(text, { lang: lg, byVoice: true });
      }
    },

    onError: function (code, msg) {
      if (this.dialog) { this.dialog = false; return; }
      this.listening = false;
      this.button(false);
      this.cb = null;
      const broken = (code === 2 || code === 4 || code === 5 || code === 8);
      if (broken) {
        this.markFailed();
        return;
      }
      if (currentView === "chat") $("chatHintLine").textContent = msg || "没有听清，再点 🎙️ 说一次";
      else toast(msg || "没有听清，再试一次");
    },

    button: function (on) {
      const mic = $("btnMic");
      if (mic) mic.classList.toggle("rec", !!on);
      document.querySelectorAll('[data-act="qa-mic"]').forEach(function (b) {
        b.style.background = on ? "var(--warm)" : "";
        b.style.color = on ? "#fff" : "";
        b.style.borderColor = on ? "var(--warm)" : "";
      });
    }
  };

  /* ================= 耳机后台连麦（SenseVoice + 前台服务） ================= */

  const Ear = {
    on: false,
    starting: false,
    active: false,
    asrReady: false,
    zhReady: false,
    langMode: "auto",
    listening: false,
    interrupted: false,
    onceCb: null,

    LANG_NAMES: { auto: "中英混说", zh: "中文优先", en: "英文优先" },
    LANG_LABEL: { auto: "🌐 中英混说", zh: "🇨🇳 中文", en: "🇺🇸 英文" },
    LANG_TIP: { auto: "中文英文混着说都行", zh: "直接说中文提问", en: "直接说英文就行" },

    modeName: function () { return this.LANG_NAMES[this.langMode] || "中英自动"; },
    modeTip: function () { return this.LANG_TIP[this.langMode] || "中英文都能说"; },

    /** 对话页底部那行提示：把当前语音识别方式写清楚 */
    readyHint: function () {
      if (currentView !== "chat") return;
      const line = $("chatHintLine");
      if (!line) return;
      line.textContent = "🟢 语音已就绪 · " + this.modeName() + " · " + this.modeTip();
    },

    supported: function () {
      if (!Bridge || !Bridge.startVoiceService) return false;
      try { return !!(Bridge.hasAsr && Bridge.hasAsr()); } catch (e) { return false; }
    },

    load: function () {
      const m = LS.get("erc.earLang", "auto");
      this.langMode = (m === "en" || m === "zh") ? m : "auto";
    },

    setLang: function (mode) {
      this.langMode = (mode === "zh" || mode === "en") ? mode : "auto";
      LS.set("erc.earLang", this.langMode);
      // 立刻告诉原生层：选“中文”之后 100% 走中文识别器
      if (Bridge && Bridge.setAsrLanguage) { try { Bridge.setAsrLanguage(this.langMode); } catch (e) {} }
      this.render();
      if (currentView === "chat") {
        $("chatHintLine").textContent = "已切到" + this.modeName() + " · " + this.modeTip();
      }
      toast("语音识别：" + this.modeName());
    },

    /** 底部工具栏那个一键按钮：中英自动 → 中文 → 英文 → 中英自动 */
    cycleLang: function () {
      const order = ["auto", "zh", "en"];
      const i = order.indexOf(this.langMode);
      this.setLang(order[(i + 1) % order.length]);
    },

    render: function () {
      const open = this.on || this.starting;
      const btn = $("btnEar");
      if (btn) {
        btn.classList.toggle("on", open);
        btn.classList.toggle("waiting", this.starting && !this.active);
      }
      const title = $("earTitle");
      if (title) {
        title.textContent = (this.starting && !this.active)
          ? "耳机连麦正在启动…"
          : (this.on ? "耳机连麦已开启" : "🎧 耳机后台连麦");
      }
      const sub = $("earSub");
      if (sub) {
        sub.textContent = this.on
          ? (this.active ? "熄屏也能说 · 开口就能打断 · 中英混说 · 点一下结束" : "正在准备离线语音…")
          : "像打电话一样聊：熄屏、切到别的应用都能说，随时可以打断，中文提问也听得懂";
      }
      const sw = $("earSwitch");
      if (sw) sw.classList.toggle("on", open);
      document.querySelectorAll("[data-lang]").forEach(function (b) {
        b.classList.toggle("on", b.dataset.lang === Ear.langMode);
      });
      const chat = $("btnEarChat");
      if (chat) {
        chat.classList.toggle("on", this.on);
        chat.textContent = this.on ? "🎧 连麦中" : "🎧 耳机连麦";
      }
      document.body.classList.toggle("ear-on", this.on);
      if (typeof Live !== "undefined") Live.render();
    },

    toggle: function () {
      if (this.on || this.starting) this.disable(false);
      else this.enable();
    },

    enable: function () {
      if (this.on || this.starting) return;
      if (!this.supported()) {
        toast("这个安装包没有离线语音模型，先用打字或系统语音");
        return;
      }
      if (Bridge.prepareAsr) { try { Bridge.prepareAsr(); } catch (e) {} }
      this.starting = true;
      this.on = true;
      this.render();
      if (currentView === "chat") $("chatHintLine").textContent = "正在打开耳机连麦…";
      try {
        Bridge.startVoiceService(this.langMode);
      } catch (e) {
        this.starting = false;
        this.on = false;
        this.render();
        toast("无法启动耳机模式");
      }
    },

    disable: function (quiet) {
      this.on = false;
      this.starting = false;
      this.active = false;
      this.listening = false;
      this.onceCb = null;
      this.interrupted = false;
      TTS.stop();
      try { if (Bridge && Bridge.stopAsrListen) Bridge.stopAsrListen(); } catch (e) {}
      try { if (Bridge && Bridge.stopVoiceService) Bridge.stopVoiceService(); } catch (e) {}
      this.render();
      if (!quiet) toast("耳机连麦已关闭");
    },

    // ---------- 原生回调 ----------

    onService: function (state, msg) {
      if (state === "permission") { toast("正在请求麦克风权限…"); return; }
      if (state === "starting") { this.starting = true; this.render(); return; }
      if (state === "active") {
        this.starting = false;
        this.active = true;
        this.render();
        Chat.startEarSession();
        return;
      }
      if (state === "stopped") {
        if (this.on || this.starting) {
          this.on = false;
          this.starting = false;
          this.active = false;
          this.render();
          toast(msg || "耳机连麦已结束");
        }
        return;
      }
      if (state === "error") {
        this.on = false;
        this.starting = false;
        this.active = false;
        this.render();
        toast(msg || "耳机模式启动失败");
        return;
      }
      if (state === "paused" || state === "focus-lost") {
        this.listening = false;
        if (msg) toast(msg);
      }
    },

    onAsr: function (state, msg) {
      if (state === "ready") {
        this.asrReady = true;
        this.readyHint();
        if ($("asrStatus")) $("asrStatus").textContent = "已就绪 · 中英混说";
        Live.render();
      } else if (state === "ready-zh") {
        this.zhReady = true;
        if (currentView === "chat" && this.langMode !== "en") this.readyHint();
      } else if (state === "zh-unavailable") {
        this.zhReady = false;
      } else if (state === "loading") {
        if (currentView === "chat") $("chatHintLine").textContent = "正在准备离线语音…";
        if ($("asrStatus")) $("asrStatus").textContent = "正在准备…";
      } else if (state === "speech") {
        if (currentView === "chat" && !Ear.interrupted) {
          $("chatHintLine").textContent = "在听你说…说完自动接话";
          Stage.listen();
        }
        Live.render();
      } else if (state === "listening") {
        this.listening = true;
        ASR.button(true);
        if (currentView === "chat" && !Ear.interrupted) Stage.listen();
      } else if (state === "stopped") {
        this.listening = false;
        ASR.button(false);
      } else if (state === "error") {
        this.asrReady = false;
        if ($("asrStatus")) $("asrStatus").textContent = "不可用";
        if (this.on) {
          toast(msg || "离线语音出错，先用打字");
        } else if (currentView === "chat") {
          ASR.markFailed(msg || "离线语音没能启动，先用下面任意一种方式接着说：");
        }
      }
      this.render();
    },

    armBargeIn: function (text) {
      if (!this.on) return;
      this.listening = true;
      this.interrupted = false;
      try { if (Bridge && Bridge.startAsrListen) Bridge.startAsrListen(true); } catch (e) {}
    },

    relax: function () {
      if (!this.on) return;
      this.listening = true;
      try { if (Bridge && Bridge.startAsrListen) Bridge.startAsrListen(false); } catch (e) {}
      Stage.listen();
    },

    listenOnce: function (cb) {
      this.onceCb = cb || null;
      try { if (Bridge && Bridge.startAsrListen) Bridge.startAsrListen(false); } catch (e) {}
    },

    onPartial: function (text, lang) {
      if (!text) return;
      this.listening = true;
      if (currentView === "chat") {
        const t = $("chatText");
        if (t && document.activeElement !== t) t.value = text;
        $("chatHintLine").textContent = "你在说：" + text;
        Stage.listen();
      }
    },

    onFinal: function (text, lang) {
      this.listening = false;
      if (!text) return;
      const cb = this.onceCb;
      if (cb) {
        this.onceCb = null;
        cb(text);
        return;
      }
      if (currentView !== "chat") {
        if (!(Chat.scenario || Chat.mode === "ai")) return;
      }
      Chat.send(text, { lang: lang, byVoice: true });
    },

    onBargeIn: function (text) {
      this.interrupted = true;
      TTS.stop();
      Chat.onBargeIn(text);
    }
  };

  /* ================= 对话页顶部那条「现在是什么状态」 ================= */

  const Live = {
    /** 一个清楚的状态胶囊：待命 / 在听 / 正在说 / 后台连麦 */
    pill: function (state) {
      if (Ear.starting && !Ear.active) return "⏳ 连麦启动中…";
      if (state === "speaking") return "🔊 正在说 · 开口可打断";
      if (Ear.on) {
        if (Ear.starting) return "⏳ 连麦启动中…";
        if (Ear.active && !Ear.listening) return "🎧 后台连麦中 · 点一下结束";
        return "👂 在听你说 · 说完自动接话";
      }
      if (state === "listening") return "👂 在听你说 · 中英混说";
      if (state === "thinking") return "💭 正在想…";
      return "🟢 随时开口说（中英混说）";
    },

    render: function () {
      document.querySelectorAll('[data-stage][data-live="1"]').forEach(function (host) {
        const badge = host.querySelector(".badge-text");
        if (badge) badge.textContent = Live.pill((typeof Stage !== "undefined" && Stage.state) || "idle");
      });
    }
  };
  window.Live = Live;

  /* ========================= 句子渲染 ========================= */

  function wordSpans(text) {
    return esc(text).replace(/([A-Za-z]+(?:['’][A-Za-z]+)*)/g, function (m) {
      return '<span class="w" data-w="' + attr(m) + '">' + esc(m) + "</span>";
    });
  }

  function renderEn(raw) {
    const parts = String(raw).split(/\[\[|\]\]/);
    let out = "";
    for (let i = 0; i < parts.length; i++) {
      const inner = wordSpans(parts[i]);
      out += (i % 2 === 1) ? '<span class="kp">' + inner + "</span>" : inner;
    }
    return out;
  }

  function plainSentence(raw) {
    return String(raw).replace(/\[\[|\]\]/g, "");
  }

  /* ========================= 视图切换 ========================= */

  const VIEWS = {
    library: "view-library",
    reader: "view-reader",
    conv: "view-conv",
    chat: "view-chat",
    vocab: "view-vocab",
    settings: "view-settings"
  };
  let currentView = "library";
  let currentTab = "library";

  const HEADS = {
    library: ["英语陪读", "全龄段 · 零花费 · 断网可用"],
    conv: ["对话互动", "9 个真实情景，说完就有中文点评"],
    vocab: ["生词本", "点过的词都收在这里"],
    settings: ["设置", "隐私、字号与可选 AI 接口"]
  };

  function setHead(title, sub) {
    $("pageTitle").textContent = title;
    $("pageSub").textContent = sub || "";
  }

  function show(view, headTitle, headSub) {
    Object.keys(VIEWS).forEach(function (k) {
      $(VIEWS[k]).classList.toggle("active", k === view);
    });
    currentView = view;
    document.body.classList.toggle("in-chat", view === "chat");
    $("main").scrollTop = 0;
    $("btnBack").classList.toggle("hidden", !(view === "reader" || view === "chat"));
    $("shadowBar").classList.toggle("hidden", view !== "reader");
    $(VIEWS.reader).style.paddingBottom = (view === "reader") ? "66px" : "";
    if (headTitle) setHead(headTitle, headSub);
    if (view === "reader" || view === "chat") {
      $("tabbar").querySelectorAll(".tab").forEach(function (b) {
        b.classList.remove("active");
      });
    }
  }

  function switchTab(tab) {
    if (!Ear.on) TTS.stop();
    Rec.state = "idle";
    Stage.settle();
    currentTab = tab;
    $("tabbar").querySelectorAll(".tab").forEach(function (b) {
      b.classList.toggle("active", b.dataset.tab === tab);
    });
    if (tab === "library") {
      show("library");
      setHead(HEADS.library[0], HEADS.library[1]);
      renderLibrary();
    } else if (tab === "conv") {
      show("conv");
      setHead(HEADS.conv[0], HEADS.conv[1]);
      renderScenarios();
      preloadAsr();
    } else if (tab === "vocab") {
      show("vocab");
      setHead(HEADS.vocab[0], HEADS.vocab[1]);
      renderVocab();
    } else {
      show("settings");
      setHead(HEADS.settings[0], HEADS.settings[1]);
      fillSettingsForm();
    }
  }

  /* ========================= 设置 ========================= */

  function applySettings() {
    const s = State.settings;
    document.body.dataset.theme = s.theme;
    document.body.dataset.font = s.font;
    $("btnZh").classList.toggle("on", !!s.bilingual);
    $("btnFont").textContent = s.font === "s" ? "A" : (s.font === "m" ? "A+" : "A++");
    $("btnTheme").textContent = s.theme === "dark" ? "🌙" : (s.theme === "sepia" ? "🌤" : "☀");
    $("btnSpeed").textContent = "语速 " + fmtSpeed(s.speed);
    $("btnAccent").textContent = s.accent === "en-GB" ? "英音" : "美音";
    $("btnLoop").classList.toggle("on", !!s.loop);
    $("btnNotes").classList.toggle("on", !!s.notes);
    if ($("btnAutoTurn")) $("btnAutoTurn").classList.toggle("on", !!s.autoTurn);
    if (Bridge && Bridge.setSystemBars) {
      try { Bridge.setSystemBars(s.theme === "dark"); } catch (e) {}
    }
    saveSettings();
  }

  function fmtSpeed(v) {
    const n = Number(v) || 1;
    return (n === 1 ? "1.0" : String(n)) + "x";
  }

  const SPEEDS = [0.6, 0.75, 0.9, 1.0, 1.2, 1.4];

  function cycleSpeed() {
    const i = SPEEDS.indexOf(Number(State.settings.speed));
    State.settings.speed = SPEEDS[(i + 1) % SPEEDS.length];
    applySettings();
    toast("朗读速度：" + fmtSpeed(State.settings.speed));
  }

  function cycleFont() {
    const order = ["s", "m", "l"];
    const i = order.indexOf(State.settings.font);
    State.settings.font = order[(i + 1) % order.length];
    applySettings();
  }

  function cycleTheme() {
    const order = ["light", "sepia", "dark"];
    const i = order.indexOf(State.settings.theme);
    State.settings.theme = order[(i + 1) % order.length];
    applySettings();
  }

  function fillSettingsForm() {
    const s = State.settings;
    document.querySelectorAll("#setFontSeg button").forEach(function (b) {
      b.classList.toggle("active", b.dataset.font === s.font);
    });
    document.querySelectorAll("#setThemeSeg button").forEach(function (b) {
      b.classList.toggle("active", b.dataset.theme === s.theme);
    });
    document.querySelectorAll("#setSpeedSeg button").forEach(function (b) {
      b.classList.toggle("active", Number(b.dataset.speed) === Number(s.speed));
    });
    document.querySelectorAll("#setAccentSeg button").forEach(function (b) {
      b.classList.toggle("active", b.dataset.accent === s.accent);
    });
    document.querySelectorAll("#setLangSeg button").forEach(function (b) {
      b.classList.toggle("active", b.dataset.asrLang === Ear.langMode);
    });
    if ($("asrStatus")) {
      $("asrStatus").textContent = Ear.asrReady ? "已就绪 · 中英混说" : "正在准备…";
    }
    $("setBilingual").classList.toggle("on", !!s.bilingual);
    $("setAutoPlay").classList.toggle("on", !!s.autoPlay);

    const ai = State.ai || {};
    $("aiProvider").value = ai.provider || "zhipu";
    $("aiEndpoint").value = ai.endpoint || AI_PRESETS[ai.provider || "zhipu"].endpoint;
    $("aiModel").value = ai.model || AI_PRESETS[ai.provider || "zhipu"].model;
    $("aiKey").value = ai.key || "";
    $("aiStatus").textContent = AI.configured()
      ? "已配置：" + (AI_PRESETS[(State.ai || {}).provider] || { name: "自定义" }).name + " · " + State.ai.model
      : "未配置。下方内置功能全部无需联网。";
  }

  /* ========================= 书库 ========================= */

  function tierInfo(id) {
    for (let i = 0; i < TIERS.length; i++) if (TIERS[i].id === id) return TIERS[i];
    return TIERS[0];
  }

  function allItems(tier) {
    if (tier === "custom") return State.custom;
    return (LIBRARY[tier] || []).slice();
  }

  function findItem(id) {
    const tiers = ["kids", "teen", "adult"];
    for (let i = 0; i < tiers.length; i++) {
      const arr = LIBRARY[tiers[i]] || [];
      for (let j = 0; j < arr.length; j++) if (arr[j].id === id) return arr[j];
    }
    for (let k = 0; k < State.custom.length; k++) if (State.custom[k].id === id) return State.custom[k];
    return null;
  }

  function renderLibrary() {
    const list = $("passageList");
    if ($("guideCard")) $("guideCard").classList.toggle("hidden", !!State.guideDismissed);
    const items = allItems(currentTier);
    if (!items.length) {
      list.innerHTML = '<div class="empty">这里还没有文章。<br>点下面的按钮，把你想读的英文粘进来。</div>';
    } else {
      list.innerHTML = items.map(function (it) {
        const read = State.read.indexOf(it.id) !== -1;
        return '<div class="item" data-act="open-passage" data-id="' + attr(it.id) + '">' +
          '<div class="item-emoji">' + (it.emoji || "📄") + "</div>" +
          '<div class="item-main">' +
            '<div class="item-title">' + esc(it.titleZh || it.title) + "</div>" +
            '<div class="item-en">' + esc(it.title) + "</div>" +
            '<div class="item-meta"><span>' + esc(it.level || "自定义") + "</span>" +
            "<span>" + (it.sentences ? it.sentences.length : 0) + " 句 · 约 " + (it.minutes || 3) + " 分钟</span>" +
            (read ? "<span>✓ 已读</span>" : "") + "</div>" +
          "</div>" +
          '<div class="item-go">›</div>' +
        "</div>";
      }).join("");
    }
    $("statRead").textContent = "已读 " + State.read.length + " 篇";
    $("statWords").textContent = "生词 " + State.vocab.length + " 个";
  }

  let currentTier = "kids";

  /* ========================= 阅读器 ========================= */

  const Reader = {
    item: null,

    open: function (item) {
      if (!item) return;
      this.item = item;
      if (State.read.indexOf(item.id) === -1) {
        State.read.push(item.id);
        LS.set("erc.read", State.read);
      }
      $("readerTitle").textContent = item.titleZh || item.title;
      $("readerZh").textContent = item.titleZh ? item.title : "";
      const meta = [item.level || "自定义", (item.sentences || []).length + " 句"];
      if (item.goal) meta.push(item.goal);
      $("readerMeta").innerHTML = meta.map(function (m) { return "<span>" + esc(m) + "</span>"; }).join("");

      this.renderSentences(item);

      renderQA(item);
      Rec.has = false;
      Rec.state = "idle";
      Rec.refresh();
      show("reader", item.titleZh || item.title, item.title);
      resetActive();
      renderLibrary();
    },

    renderSentences: function (item) {
      const wrap = $("sentences");
      wrap.innerHTML = (item.sentences || []).map(function (s, i) {
        const zh = (item.zh && item.zh[i]) ? item.zh[i] : "";
        const note = (item.notes && item.notes[i]) ? item.notes[i] : "";
        return '<div class="sent" data-idx="' + i + '">' +
          '<div class="en"><span class="index">' + (i + 1) + "</span>" + renderEn(s) + "</div>" +
          (State.settings.bilingual && zh ? '<div class="zh">' + esc(zh) + "</div>" : "") +
          (State.settings.notes && note ? '<div class="note">' + esc(note) + "</div>" : "") +
        "</div>";
      }).join("");
    },

    rerender: function () {
      if (!this.item) return;
      const keep = this.idx;
      this.renderSentences(this.item);
      this.setActive(keep || 0);
    },

    close: function () {
      TTS.stop();
      this.item = null;
      switchTab("library");
    },

    width: function () { return (this.item && this.item.sentences) ? this.item.sentences.length : 0; },

    plain: function (idx) {
      if (!this.item || !this.item.sentences[idx]) return "";
      return plainSentence(this.item.sentences[idx]);
    },

    activeIdx: function () {
      const el = document.querySelector("#sentences .sent.active");
      if (el) return parseInt(el.dataset.idx, 10) || 0;
      return 0;
    },

    setActive: function (idx) {
      const nodes = document.querySelectorAll("#sentences .sent");
      nodes.forEach(function (n) {
        n.classList.toggle("active", parseInt(n.dataset.idx, 10) === idx);
      });
      const node = nodes[idx];
      if (node && node.scrollIntoView) {
        try { node.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) {}
      }
    },

    playing: false,
    idx: 0,

    playAll: function () {
      if (!this.width()) return;
      const start = (this.idx < this.width()) ? this.idx : 0;
      this.playFrom(start);
    },

    playFrom: function (idx) {
      if (!this.item) return;
      if (idx >= this.width()) {
        this.playing = false;
        $("btnPlayAll").textContent = "▶ 朗读全篇";
        return;
      }
      this.idx = idx;
      this.playing = true;
      $("btnPlayAll").textContent = "⏸ 暂停";
      this.setActive(idx);
      const self = this;
      const text = plainSentence(this.item.sentences[idx]);
      TTS.speak(text, {
        onEnd: function () {
          if (!self.playing) return;
          if (State.settings.loop) self.playFrom(self.idx);
          else self.playFrom(self.idx + 1);
        },
        onError: function () {
          if (!self.playing) return;
          self.playFrom(self.idx + 1);
        }
      });
    },

    speakOne: function (idx) {
      if (!this.item) return;
      this.idx = idx;
      this.setActive(idx);
      const self = this;
      const text = plainSentence(this.item.sentences[idx]);
      TTS.speak(text, {
        onEnd: function () {
          if (State.settings.loop) self.speakOne(idx);
        }
      });
    },

    stop: function () {
      this.playing = false;
      TTS.stop();
      $("btnPlayAll").textContent = "▶ 朗读全篇";
    }
  };

  function resetActive() {
    Reader.idx = 0;
    const first = document.querySelector("#sentences .sent");
    if (first) first.classList.add("active");
  }

  /* ========================= 读后问答 ========================= */

  function renderQA(item) {
    const wrap = $("qaList");
    if (!item.qa || !item.qa.length) {
      wrap.innerHTML = '<div class="empty">自定义文章没有预设问题。<br>读完后可以点下面的按钮，用英文复述一遍。</div>' +
        '<div style="text-align:center;margin-top:6px"><button class="btn" data-act="ask-ai-reading">🤖 用英文复述给外教听</button></div>';
      return;
    }
    wrap.innerHTML = item.qa.map(function (q, i) {
      return '<div class="qa-item">' +
        '<div class="qa-q">' + (i + 1) + ". " + esc(q.q) + "</div>" +
        '<div class="qa-q-zh">' + esc(q.qZh) + "</div>" +
        '<div class="qa-row">' +
          '<button class="icon-btn" data-act="qa-mic" data-qi="' + i + '" aria-label="语音回答">🎙️</button>' +
          '<input class="qa-input" data-qi="' + i + '" placeholder="用英文回答，也可以说中文">' +
          '<button class="btn small primary" data-act="qa-check" data-qi="' + i + '">回答</button>' +
        "</div>" +
        '<div class="qa-feedback hidden" data-fb="' + i + '"></div>' +
      "</div>";
    }).join("") + '<div class="row" style="margin-top:12px"><button class="btn ghost grow" data-act="ask-ai-reading">🤖 还有疑问？问外教</button></div>';
  }

  function checkQA(i) {
    const item = Reader.item;
    if (!item || !item.qa || !item.qa[i]) return;
    const q = item.qa[i];
    const input = document.querySelector('.qa-input[data-qi="' + i + '"]');
    const ans = input ? input.value.trim() : "";
    if (!ans) { toast("先写一句你的答案"); return; }

    const n = norm(ans);
    let enHit = true;
    if (q.groups && q.groups.length) {
      enHit = q.groups.every(function (g) {
        return g.some(function (k) { return n.indexOf(norm(k).trim()) !== -1; });
      });
    }
    let zhHit = false;
    if (q.zhGroups) {
      zhHit = q.zhGroups.every(function (g) {
        return g.some(function (k) { return ans.indexOf(k) !== -1; });
      });
    }

    const fb = document.querySelector('[data-fb="' + i + '"]');
    if (!fb) return;
    fb.classList.remove("hidden");
    let head = "";
    let cls = "mid";
    if (enHit) {
      head = "✅ 答对了！这就是参考答案里的关键信息。";
      cls = "good";
    } else if (zhHit) {
      head = "✅ 意思对了！用英文可以这样说：";
      cls = "good";
    } else {
      head = "💡 差一点。先看参考答案，再跟着读一遍：";
      cls = "mid";
    }
    fb.className = "qa-feedback " + cls;
    fb.innerHTML = esc(head) +
      '<div class="qa-answer"><b>参考答案：</b>' + esc(q.answer) +
      ' <button class="icon-btn" style="width:26px;height:26px;font-size:12px" data-act="speak-text" data-text="' + attr(q.answer) + '">🔊</button>' +
      "<br><span class=\"tiny\">" + esc(q.answerZh) + "</span></div>";
  }

  /* ========================= 生词 ========================= */

  function isSaved(word) {
    const w = String(word).toLowerCase().replace(/[’]/g, "'");
    return State.vocab.some(function (v) { return v.w === w; });
  }

  function addWord(word, entry) {
    const w = String(word).toLowerCase().replace(/[’]/g, "'");
    if (isSaved(w)) { toast("这个词已经在生词本里了"); return; }
    State.vocab.unshift({
      w: w,
      head: entry ? (entry.matched || w) : w,
      ipa: entry ? (entry.i || "") : "",
      pos: entry ? (entry.p || "") : "",
      zh: entry ? (entry.z || "") : "（暂无中文释义）",
      ex: entry ? (entry.e || "") : "",
      exZh: entry ? (entry.ez || "") : "",
      ts: Date.now(),
      mastered: false
    });
    saveVocab();
    renderLibrary();
    toast("已加入生词本：" + w);
  }

  function renderVocab() {
    const list = $("vocabList");
    const wrap = $("flashWrap");
    if (!State.vocab.length) {
      wrap.classList.add("hidden");
      list.innerHTML = '<div class="empty">生词本还是空的。<br>读书时点一下不认识的单词，就收进来了。</div>';
      $("vocabCount").textContent = "0";
      $("vocabMastered").textContent = "";
      return;
    }
    const mastered = State.vocab.filter(function (v) { return v.mastered; }).length;
    $("vocabCount").textContent = String(State.vocab.length);
    $("vocabMastered").textContent = "（已掌握 " + mastered + "）";

    const items = State.vocab.filter(function (v) { return State.showMastered || !v.mastered; });
    if (!items.length) {
      list.innerHTML = '<div class="empty">没有需要复习的词了。<br>点“显示已掌握”可以看全部。</div>';
      return;
    }
    list.innerHTML = items.map(function (v) {
      return '<div class="vocab-item' + (v.mastered ? " mastered" : "") + '" data-w="' + attr(v.w) + '">' +
        '<div class="v-main">' +
          '<div class="v-word">' + esc(v.w) + (v.ipa ? ' <span class="v-ipa">' + esc(v.ipa) + "</span>" : "") + "</div>" +
          '<div class="v-zh">' + (v.pos ? esc(v.pos) + " " : "") + esc(v.zh) + "</div>" +
        "</div>" +
        '<button class="icon-btn" data-act="vocab-speak" data-w="' + attr(v.w) + '" aria-label="发音">🔊</button>' +
        '<button class="icon-btn" data-act="vocab-del" data-w="' + attr(v.w) + '" aria-label="删除">🗑</button>' +
      "</div>";
    }).join("");
  }

  /* ========================= 卡片复习 ========================= */

  const Flash = {
    list: [],
    i: 0,
    flipped: false,

    open: function () {
      this.list = State.vocab.filter(function (v) { return !v.mastered; });
      if (!this.list.length) { toast("还没有要复习的生词"); return; }
      this.i = 0;
      this.flipped = false;
      $("vocabList").classList.add("hidden");
      $("flashWrap").classList.remove("hidden");
      this.render();
    },

    close: function () {
      $("flashWrap").classList.add("hidden");
      $("vocabList").classList.remove("hidden");
      renderVocab();
    },

    render: function () {
      const v = this.list[this.i];
      if (!v) { this.close(); return; }
      $("flashWord").textContent = v.w;
      $("flashIpa").textContent = v.ipa || "";
      $("flashFront").classList.toggle("hidden", this.flipped);
      $("flashBack").classList.toggle("hidden", !this.flipped);
      $("flashPos").textContent = v.pos || "";
      $("flashZh").textContent = v.zh || "";
      $("flashEx").innerHTML = v.ex ? esc(v.ex) + (v.exZh ? '<div class="ex-zh">' + esc(v.exZh) + "</div>" : "") : "";
    },

    flip: function () {
      this.flipped = !this.flipped;
      this.render();
    },

    next: function () {
      if (!this.list.length) return;
      this.i = (this.i + 1) % this.list.length;
      this.flipped = false;
      this.render();
    },

    prev: function () {
      if (!this.list.length) return;
      this.i = (this.i - 1 + this.list.length) % this.list.length;
      this.flipped = false;
      this.render();
    },

    master: function () {
      const v = this.list[this.i];
      if (!v) return;
      const target = State.vocab.filter(function (x) { return x.w === v.w; })[0];
      if (target) target.mastered = true;
      saveVocab();
      this.list.splice(this.i, 1);
      if (!this.list.length) {
        toast("这一轮都掌握了，真棒");
        this.close();
        return;
      }
      if (this.i >= this.list.length) this.i = 0;
      this.flipped = false;
      this.render();
      toast("已标记为掌握");
    }
  };

  /* ========================= 单词弹层 ========================= */

  let wordCurrent = null;

  function openWord(raw) {
    const w = String(raw).toLowerCase().replace(/[’]/g, "'");
    const entry = dictLookup(raw);
    wordCurrent = { w: w, entry: entry };
    $("wWord").textContent = w;
    $("wIpa").textContent = entry ? (entry.i || "") : "";
    $("wPos").textContent = entry ? (entry.p || "") : "";
    $("wZh").textContent = entry ? (entry.z || "") : "本地词库暂未收录这个词。";
    $("wEx").innerHTML = (entry && entry.e) ? esc(entry.e) + (entry.ez ? '<div class="ex-zh">' + esc(entry.ez) + "</div>" : "") : "";
    $("wSource").textContent = entry
      ? "内置离线词库" + (entry.note ? "（" + entry.note + "，显示原形释义）" : "") + " · 共 " + DICT_COUNT + " 词"
      : "离线词库共 " + DICT_COUNT + " 词，这个词不在其中";

    const saved = isSaved(w);
    $("wAdd").textContent = saved ? "✔️ 已在生词本" : "＋ 加入生词本";
    $("wAdd").disabled = saved;
    $("wOnline").classList.toggle("hidden", !!entry);
    $("wOnlineNote").textContent = entry ? "" : "联网查词会把这个词发送给免费词典服务 dictionaryapi.dev，只在点按钮时才发。";
    $("wordMask").classList.remove("hidden");
  }

  function closeWord() {
    $("wordMask").classList.add("hidden");
  }

  function onlineLookup() {
    if (!wordCurrent) return;
    const w = wordCurrent.w;
    $("wOnlineNote").textContent = "正在联网查询…";
    Http.request("GET", "https://api.dictionaryapi.dev/api/v2/entries/en/" + encodeURIComponent(w), {}, null)
      .then(function (text) {
        let data = null;
        try { data = JSON.parse(text); } catch (e) {}
        if (!data || !data[0]) throw new Error("没有查到这个词");
        const e0 = data[0];
        const ipa = (e0.phonetics || []).map(function (p) { return p.text; }).filter(Boolean)[0] || "";
        const mean = (e0.meanings || [])[0] || {};
        const def = (mean.definitions || [])[0] || {};
        $("wIpa").textContent = ipa;
        $("wPos").textContent = mean.partOfSpeech || "";
        $("wZh").textContent = def.definition || "（无释义）";
        $("wEx").innerHTML = def.example ? esc(def.example) : "";
        $("wSource").textContent = "来源：在线词典 dictionaryapi.dev（英文释义）";
        $("wOnlineNote").textContent = "在线释义是英文的，可对照例句理解。";
      })
      .catch(function (e) {
        $("wOnlineNote").textContent = "联网查询失败：" + e.message + "（国内网络下可能无法访问，离线词库不影响使用）";
      });
  }

  /* ========================= 情景对话 ========================= */

  const ACKS = [
    "Oh, good point!",
    "Sure, let's talk about that!",
    "Got it!",
    "Right, I see what you mean!",
    "That's interesting!"
  ];

  function pickAck() {
    return ACKS[Math.floor(Math.random() * ACKS.length)];
  }

  function hasChinese(s) {
    return /[\u4e00-\u9fff]/.test(String(s || ""));
  }

  const Chat = {
    mode: "scenario",
    scenario: null,
    step: 0,
    finished: false,
    msgs: [],
    zh: false,
    aiHistory: [],
    aiContext: "",
    busy: false,
    fromReader: false,
    // 每次被打断就 +1：所有延迟回调先对一下号，避免“打断后旧台词还在继续说/自动推进”
    token: 0,
    interruptedText: "",

    openScenario: function (sc) {
      this.mode = "scenario";
      this.fromReader = false;
      preloadAsr();
      this.token++;
      this.interruptedText = "";
      Sf.hide();
      const scTier = tierOfScenario(sc.id);
      if (scTier) {
        currentConvTier = scTier;
        Stage.setPersona(scTier);
      }
      Stage.settle();
      this.scenario = sc;
      this.step = 0;
      this.finished = false;
      this.msgs = [];
      this.zh = false;
      $("chatTools").classList.remove("hidden");
      $("btnHint").classList.remove("hidden");
      $("btnRestart").classList.remove("hidden");
      $("chatText").placeholder = "用英文回一句，或点 🎙️ 说出来";
      show("chat", sc.title, (sc.titleEn ? sc.titleEn + " · " : "") + (sc.level || ""));
      $("btnZhChat").classList.toggle("on", this.zh);
      $("btnZhChat").textContent = this.zh ? "中文 ✓" : "译 中文";
      $("chatStream").innerHTML = "";
      $("chatHintLine").textContent = "目标：" + (sc.goal || "用简单的一句英文回答") + " · " + Ear.modeName() + "，中文提问也懂";
      Live.render();
      this.partnerLine(sc.turns[0], true);
    },

    openAI: function (contextTitle, contextText) {
      this.mode = "ai";
      preloadAsr();
      this.token++;
      this.interruptedText = "";
      Sf.hide();
      Stage.listen();
      this.scenario = null;
      this.step = 0;
      this.finished = false;
      this.msgs = [];
      this.aiHistory = [];
      this.aiContext = (contextTitle ? "当前阅读材料：" + contextTitle + "\n" + contextText + "\n\n" : "");
      this.fromReader = !!(contextTitle || contextText);
      $("chatTools").classList.remove("hidden");
      $("btnHint").classList.add("hidden");
      $("btnRestart").classList.remove("hidden");
      $("chatText").placeholder = "想说什么都可以，中文提问也行";
      setHead("AI 自由外教", AI.configured() ? AI.currentName() : "还没配置接口 · 离线功能照常可用");
      show("chat", "AI 自由外教", AI.configured() ? "回复会自动朗读 · 中英混说" : "还没配置接口");
      $("btnZhChat").textContent = this.zh ? "中文 ✓" : "译 中文";
      $("btnZhChat").classList.toggle("on", this.zh);
      $("chatStream").innerHTML = "";
      $("chatHintLine").textContent = AI.configured()
        ? "直接说 Hi 就行；也可以说中文：「这句话什么意思」「怎么用英语说」"
        : "还没有配置接口。到「设置 → AI 自由外教」填入自己的免费接口即可；不配置也能用全部离线功能。";
      Live.render();

      if (!AI.configured()) {
        this.sys("还没有配置 AI 接口。内置的 9 个情景对话完全离线可用，先在那里练也够用。", null);
        return;
      }
      this.sys("已连接你自己的接口：" + AI.currentName() + "。中英文都能聊：说英文练口语，用中文问语法和意思。", null);
    },

    closeChat: function () {
      TTS.stop();
      Sf.hide();
      Stage.settle();
      if (Ear.on) toast("耳机连麦还在后台运行，点通知里的「结束对话」可以关掉");
      if (this.fromReader && Reader.item) {
        this.fromReader = false;
        show("reader", Reader.item.titleZh || Reader.item.title, Reader.item.title);
        return;
      }
      switchTab("conv");
    },

    toggleZh: function () {
      this.zh = !this.zh;
      const btn = $("btnZhChat");
      if (btn) {
        btn.classList.toggle("on", this.zh);
        btn.textContent = this.zh ? "中文 ✓" : "译 中文";
      }
      const zh = this.zh;
      document.querySelectorAll("#chatStream .b-zh").forEach(function (el) {
        el.classList.toggle("hidden", !zh);
      });
      document.querySelectorAll('#chatStream [data-act="bubble-zh"]').forEach(function (el) {
        el.textContent = "译 中文";
      });
      toast(this.zh ? "已显示中文对照" : "已隐藏中文对照");
    },

    addPartner: function (en, zh) {
      const stream = $("chatStream");
      const div = document.createElement("div");
      div.className = "bubble partner";
      div.innerHTML = '<div class="b-en">' + esc(en) + "</div>" +
        (zh ? '<div class="b-zh' + (this.zh ? "" : " hidden") + '">' + esc(zh) + "</div>" : "") +
        '<div class="b-actions">' +
          '<button class="b-act" data-act="speak-text" data-text="' + attr(en) + '">🔊 再听</button>' +
          (zh ? '<button class="b-act" data-act="bubble-zh">译 中文</button>' : "") +
        "</div>";
      stream.appendChild(div);
      stream.scrollTop = stream.scrollHeight;
      return div;
    },

    addMe: function (text) {
      const stream = $("chatStream");
      const div = document.createElement("div");
      div.className = "bubble me";
      div.innerHTML = '<div class="b-tag">我</div><div class="b-en">' + esc(text) + "</div>";
      stream.appendChild(div);
      stream.scrollTop = stream.scrollHeight;
    },

    sys: function (text, model) {
      const stream = $("chatStream");
      const div = document.createElement("div");
      div.className = "bubble sys";
      div.innerHTML = text + (model
        ? ' 你可以这样说：<span class="model" data-act="speak-text" data-text="' + attr(model) + '">' + esc(model) + " 🔊</span>"
        : "");
      stream.appendChild(div);
      stream.scrollTop = stream.scrollHeight;
    },

    persona: function () {
      return PERSONAS[Stage.personaId] || PERSONAS.kids;
    },

    /**
     * 朗读一句 AI 的话。
     * 耳机模式下先开“边说边听”，用户一插话就能立刻打断（token 会变，后面的回调全部作废）。
     */
    speakAs: function (text, onDone) {
      const p = this.persona();
      const self = this;
      const token = this.token;
      Stage.speak();
      if (Ear.on) Ear.armBargeIn(text);
      TTS.speak(text, {
        rate: p.speed,
        onStart: function () { Stage.speak(); },
        onEnd: function () {
          if (token !== self.token) return;
          Stage.settle();
          if (onDone) setTimeout(function () { if (token === self.token) onDone(); }, 220);
        },
        onError: function () {
          if (token !== self.token) return;
          Stage.settle();
          if (onDone) setTimeout(function () { if (token === self.token) onDone(); }, 220);
        }
      });
    },

    partnerLine: function (turn, speak) {
      this.addPartner(turn.en, turn.zh);
      const self = this;
      if (speak !== false) {
        this.speakAs(turn.en, function () { self.afterPartnerSpeak(); });
      } else {
        Stage.listen();
        if (Ear.on) Ear.relax();
      }
      $("chatHintLine").textContent = "提示：" + (turn.tip || "用简单的一句英文回答就好");
    },

    afterPartnerSpeak: function () {
      if (this.mode !== "scenario" || this.finished) {
        Stage.settle();
        if (Ear.on) Ear.relax();
        return;
      }
      Stage.listen();
      if (Ear.on) {
        $("chatHintLine").textContent = "轮到你了——直接说英文，随时可以打断我";
        Ear.relax();
        return;
      }
      if (State.settings.autoTurn && !ASR.failed) {
        $("chatHintLine").textContent = "轮到你了——直接说英文，麦克风已自动打开";
        const self = this;
        setTimeout(function () { self.startListen(); }, 260);
      } else if (State.settings.autoTurn && ASR.failed) {
        this.showFallback(ASR.failMsg);
      } else {
        $("chatHintLine").textContent = "轮到你了：点 🎙️ 开口说，或者直接打字";
      }
    },

    startListen: function () {
      if (Ear.on) { Ear.listenOnce(null); return; }
      if (ASR.failed) {
        Stage.settle();
        this.showFallback(ASR.failMsg);
        return;
      }
      ASR.start({
        input: $("chatText"),
        onText: function (text) {
          $("chatText").value = text;
          Chat.send(text);
        }
      });
    },

    showFallback: function (msg) {
      if (currentView !== "chat") return;
      if (Ear.on) return;
      if (this.mode === "scenario" && this.finished) return;
      Sf.show(msg);
    },

    /** 耳机连麦刚打开：把对话接上（没开对话就开一个），说完自动听 */
    startEarSession: function () {
      if (currentView === "chat" && (this.scenario || this.mode === "ai")) {
        if (this.mode === "ai") {
          if (!this.aiHistory.length) {
            this.speakAs("Hi! I'm here. Say anything in English — or ask me in Chinese.", function () { Ear.relax(); });
          } else {
            Ear.relax();
          }
          return;
        }
        const t = this.currentTurn();
        if (t && !this.finished) this.speakAs(t.en, function () { Ear.relax(); });
        else Ear.relax();
        return;
      }
      if (AI.configured()) {
        this.openAI("", "");
        this.speakAs("Hi! This is hands-free mode. Go ahead — say anything in English.", function () { Ear.relax(); });
        return;
      }
      const sc = (SCENARIOS[currentConvTier] || [])[0];
      if (sc) {
        this.openScenario(sc);
        toast("耳机连麦已开启，先从「" + sc.title + "」开始");
      } else {
        Ear.relax();
      }
    },

    /** 用户打断了 AI：作废所有排队中的台词、取消流式请求和推进 */
    onBargeIn: function (text) {
      this.token++;
      this.busy = false;
      if (this.activeStreamId) {
        Http.cancelStream(this.activeStreamId);
        this.activeStreamId = null;
      }
      this.interruptedText = text || "";
      if (currentView === "chat") {
        $("chatHintLine").textContent = "你打断了 —— 接着说，我听着";
        Stage.listen();
      }
    },

    /** “我已说完，继续”：没识别到文字时，用这一轮的标准说法推进对话。 */
    sayAloudAndContinue: function () {
      if (this.mode === "ai") {
        toast("AI 外教需要一句文字才能接话，先打一句吧");
        try { $("chatText").focus(); } catch (e) {}
        return;
      }
      const turn = this.currentTurn();
      if (!turn || this.finished) {
        toast("这个场景已经结束，可以点“重来”再练一遍");
        return;
      }
      const typed = ($("chatText").value || "").trim();
      const text = typed || turn.model || (turn.chips && turn.chips[0]) || "";
      if (!text) {
        toast("这一轮直接打字也能继续");
        try { $("chatText").focus(); } catch (e) {}
        return;
      }
      this.send(text);
    },

    currentTurn: function () {
      if (!this.scenario) return null;
      return this.scenario.turns[this.step] || null;
    },

    hint: function () {
      if (this.mode === "ai") {
        toast("直接开口说就行，说错了 AI 会提醒你");
        return;
      }
      const t = this.currentTurn();
      if (!t) return;
      const box = document.createElement("div");
      box.className = "hints";
      box.innerHTML = (t.chips || []).map(function (c) {
        return '<button class="hint-chip" data-act="use-chip" data-text="' + attr(c) + '">' + esc(c) + "</button>";
      }).join("");
      const stream = $("chatStream");
      stream.appendChild(box);
      $("main").scrollTop = $("main").scrollHeight;
    },

    restart: function () {
      this.token++;
      this.interruptedText = "";
      if (this.mode === "ai") { this.openAI("", ""); return; }
      if (this.scenario) this.openScenario(this.scenario);
    },

    evaluate: function (reply, turn) {
      const n = norm(reply);
      const groups = turn.expect || [];
      if (!groups.length) return 1;
      let hit = 0;
      groups.forEach(function (g) {
        if (g.some(function (k) { return n.indexOf(norm(k).trim()) !== -1; })) hit++;
      });
      return hit / groups.length;
    },

    /** 在整个情景里找最贴近的一轮（用户可能直接说了后面的台词） */
    bestTurn: function (msg) {
      if (!this.scenario || !this.scenario.turns) return null;
      let best = null;
      for (let i = 0; i < this.scenario.turns.length; i++) {
        const r = this.evaluate(msg, this.scenario.turns[i]);
        if (!best || r > best.ratio) best = { idx: i, ratio: r };
      }
      return best;
    },

    /**
     * 中文提问：离线也能接住。
     * 支持「什么意思 / 怎么说 / 再说一遍 / 慢一点 / 继续」等常见请求，
     * 其它中文就当成问题，用中文解释这一轮，并把英文说法读出来。
     */
    chineseTurn: function (msg, interrupted) {
      const turn = this.currentTurn();
      const self = this;
      if (!turn && !this.finished) return false;
      const m = String(msg).replace(/\s+/g, "");
      const wantRepeat = /再说|重复|没听清|听不清|再读|again/i.test(m);
      const wantSlow = /慢一点|慢点|说慢|太快|slow/i.test(m);
      const wantMean = /什么意思|啥意思|翻译|不懂|不明白|解释|意思/.test(m);
      const wantHelp = /怎么说|怎么回答|怎么用英语|我该说|该说什么|教我|怎么讲/.test(m);
      const wantNext = /下一句|下一个|继续|往下|goon|next/i.test(m);

      if (this.finished) {
        if (wantNext) { this.sys("这个情景已经走完了，可以点“重来”，或者换一个情景。", null); return true; }
        return false;
      }

      if (wantRepeat) {
        this.sys("🔁 再听一遍这一句：", turn.en);
        this.speakAs(turn.en, function () { if (Ear.on) Ear.relax(); });
        return true;
      }
      if (wantSlow) {
        State.settings.speed = Math.max(0.6, Math.round((Number(State.settings.speed || 1) - 0.15) * 100) / 100);
        saveSettings();
        this.sys("🐢 语速已经调慢到 " + fmtSpeed(State.settings.speed) + "，再听一遍：", null);
        this.speakAs(turn.en, function () { if (Ear.on) Ear.relax(); });
        return true;
      }
      if (wantMean) {
        this.sys("📖 对方说的是：「" + esc(turn.en) + "」<br>意思是：" + esc(turn.zh || ""), null);
        this.speakAs((turn.zh || "") + "。英文是：" + turn.en, function () { if (Ear.on) Ear.relax(); });
        return true;
      }
      if (wantHelp) {
        this.sys("🗣️ 这一轮可以这样回答：", turn.model);
        this.speakAs("可以这样回答：" + (turn.model || turn.en), function () { if (Ear.on) Ear.relax(); });
        return true;
      }
      if (wantNext) {
        this.sys("👉 好，我们往下走。", null);
        const token = this.token;
        setTimeout(function () {
          if (token !== self.token) return;
          self.step++;
          const n = self.currentTurn();
          if (n) self.partnerLine(n, true);
          else self.finishScenario();
        }, 320);
        return true;
      }

      // 其它中文：当成提问，用中文解释这一轮 + 英文示范
      this.sys("💬 中文提问我听得懂。对方的意思是：" + esc(turn.zh || "") + " 你可以用英文这样回答：", turn.model);
      this.speakAs("你可以这样回答：" + (turn.model || turn.en), function () { if (Ear.on) Ear.relax(); });
      return true;
    },

    finishScenario: function () {
      if (this.finished) return;
      this.finished = true;
      State.done[this.scenario.id] = true;
      LS.set("erc.done", State.done);
      const self = this;
      const token = this.token;
      const closing = this.scenario.closing;
      setTimeout(function () {
        if (token !== self.token) return;
        if (closing) self.partnerLine({ en: closing.en, zh: closing.zh, tip: "" }, true);
        self.sys("🎉 这个情景走完了。想再来一遍可以点“重来”；打开 🎧 耳机连麦，就能像打电话一样接着聊。", null);
        if (!State.settings.autoTurn && !LS.get("erc.autoTip", false)) {
          LS.set("erc.autoTip", true);
          toast("小提示：打开 🎧 耳机连麦，说完自动接话，还随时能打断");
        }
      }, 420);
    },

    /** 情景走完后用户还在说：自然接一句，别当机 */
    afterEndChatter: function (msg) {
      const self = this;
      const ack = pickAck();
      this.addMe(msg);
      $("chatText").value = "";
      this.sys("👂 " + esc(ack) + "（这个情景已经走完，还可以接着聊）", null);
      this.speakAs(ack + " We finished that scene — tell me anything else, or say “again” to replay it.",
        function () { if (Ear.on) Ear.relax(); });
      this.lastChatter = Date.now();
    },

    send: function (text, opts) {
      opts = opts || {};
      const msg = String(text || "").trim();
      if (!msg || this.busy) return;
      const lang = opts.lang || (hasChinese(msg) ? "zh" : "en");
      const interrupted = this.interruptedText;
      this.interruptedText = "";

      if (this.mode === "ai") {
        this.sendAI(msg, lang, interrupted);
        return;
      }

      // 中文提问 / 学习请求（离线也能答）
      if (lang === "zh" || hasChinese(msg)) {
        if (this.chineseTurn(msg, interrupted)) return;
      }

      const turn = this.currentTurn();
      if (!turn || this.finished) {
        if (this.finished) { this.afterEndChatter(msg); return; }
        toast("这个场景已经结束了，可以点“重来”");
        return;
      }

      this.addMe(msg);
      $("chatText").value = "";
      Sf.hide();
      const self = this;
      const token = this.token;
      const ratio = this.evaluate(msg, turn);
      const best = this.bestTurn(msg);
      let praise = null;
      let jumpTo = -1;
      const ack = pickAck();

      if (interrupted) {
        // 被打断：顺着用户新说的内容接话，绝不重复被打断的旧句
        Stage.setState("thinking");
        if (best && best.ratio >= 0.5 && best.idx >= this.step) {
          jumpTo = best.idx;
          praise = this.scenario.turns[best.idx].model;
          this.sys("👂 接住你的话 —— 这句更自然：", praise);
        } else if (ratio >= 0.4) {
          praise = turn.model;
          this.sys("👂 好，接着聊 —— 这样说更自然：", praise);
        } else {
          praise = ack + " " + (turn.model || "");
          this.sys("👂 我听懂你换了话题：我们接着练这一轮。", turn.model);
        }
      } else if (ratio >= 0.99) {
        this.sys("✅ " + turn.good, null);
        Stage.celebrate();
      } else if (ratio >= 0.5) {
        this.sys("👍 意思到了。" + turn.mid + " 更自然一点：", turn.model);
        Stage.setState("thinking");
        praise = turn.model;
      } else if (best && best.ratio >= 0.5 && best.idx > this.step) {
        // 说了后面某一轮的台词：直接跳过去，不卡在原地
        jumpTo = best.idx;
        praise = this.scenario.turns[best.idx].model;
        this.sys("💬 这句更像后面的情景，我们跳过去 —— 可以这样说：", praise);
      } else {
        praise = ack + " " + (turn.model || "");
        this.sys("💬 先接住你的话：" + esc(ack) + " 这一轮可以这样说：", turn.model);
      }

      const proceed = function () {
        if (token !== self.token) return;
        if (jumpTo >= 0) self.step = jumpTo;
        self.step++;
        const nextTurn = self.currentTurn();
        if (nextTurn) {
          setTimeout(function () {
            if (token !== self.token) return;
            self.partnerLine(nextTurn, true);
          }, 420);
        } else {
          self.finishScenario();
        }
      };

      if (praise) this.speakAs(praise, proceed);
      else setTimeout(proceed, 620);
    },

    sendAI: function (msg, lang, interrupted) {
      this.addMe(msg);
      $("chatText").value = "";
      Sf.hide();
      this.busy = false;
      let content = msg;
      if (interrupted) {
        content = msg + "\n\n[系统提示：用户刚刚打断了你，你被打断时正在说的那句是：「" + interrupted +
          "」。请顺着用户这次新说的内容自然接话，不要重复被打断的旧句子，也不要问“我刚才说到哪了”。]";
      } else if (lang === "zh") {
        content = msg + "\n\n[系统提示：用户这次用中文提问，请用简体中文解释清楚，并给出 1-2 个英文例句，最后用一句英文把对话带回英语。]";
      }
      this.aiHistory.push({ role: "user", content: content });
      this.busy = true;
      const self = this;
      if (!AI.configured()) {
        this.sys("还没配置 AI 接口，先去“设置 → AI 自由外教”填一下。", null);
        this.busy = false;
        if (Ear.on) Ear.relax();
        return;
      }
      $("chatHintLine").textContent = "AI 正在想…";
      Stage.think();
      const myToken = this.token;
      const p = this.persona();
      const bubble = this.addPartner("…", "");
      const enEl = bubble ? bubble.querySelector(".b-en") : null;
      const btnEl = bubble ? bubble.querySelector('[data-act="speak-text"]') : null;
      const streamEl = $("chatStream");
      let spokenOffset = 0;
      let tipCut = false;

      TTS.stop();
      TTS.streamPending = true;
      TTS.queueOpts = {
        rate: Math.max(0.75, Math.min(1.25, (State.settings.speed || 1.0) * p.rate)),
        lang: State.settings.accent || "en-US",
        onFirstStart: function () {
          Stage.speak();
          if (Ear.on) Ear.armBargeIn(enEl ? enEl.textContent : "");
          else if (ASR.available()) ASR.armBargeIn(enEl ? enEl.textContent : "");
        },
        onAllEnd: function () {
          if (myToken !== self.token) return;
          if (Ear.on) Ear.relax();
          else if (State.settings.autoTurn && ASR.available()) self.startListen();
          else Stage.listen();
        }
      };

      const flushSentences = function (fullText, isFinal) {
        if (tipCut) return;
        const tipIdx = fullText.search(/\n\s*(TIP|Tip|tip|提示)\s*[:：]/);
        const speakableEnd = tipIdx >= 0 ? tipIdx : fullText.length;
        if (tipIdx >= 0) tipCut = true;
        const slice = fullText.slice(spokenOffset, speakableEnd);
        if (!slice) return;
        if (isFinal) {
          const tail = slice.trim();
          spokenOffset = speakableEnd;
          if (tail) TTS.enqueue(tail);
          return;
        }
        const re = /[.!?。！？\n]/g;
        let lastCut = -1;
        let m;
        while ((m = re.exec(slice)) !== null) {
          if (m.index + 1 >= 6) lastCut = m.index + 1;
        }
        if (lastCut > 0) {
          const chunk = slice.slice(0, lastCut).trim();
          spokenOffset += lastCut;
          if (chunk) TTS.enqueue(chunk);
        }
      };

      this.activeStreamId = AI.chatStream(this.aiContext, this.aiHistory, {
        onChunk: function (delta, fullText) {
          if (myToken !== self.token) return;
          const parsed = parseAIReply(fullText);
          if (enEl) enEl.textContent = parsed.en || "…";
          if (btnEl) btnEl.setAttribute("data-text", parsed.en || "");
          if (streamEl) streamEl.scrollTop = streamEl.scrollHeight;
          $("chatHintLine").textContent = "正在回复并同步朗读…";
          flushSentences(fullText, false);
        },
        onDone: function (reply) {
          self.activeStreamId = null;
          if (myToken !== self.token) return;
          self.busy = false;
          if (!reply) {
            TTS.finishStreamQueue();
            if (bubble && bubble.parentNode) bubble.parentNode.removeChild(bubble);
            self.sys("请求未返回内容，请稍后再试。", null);
            if (Ear.on) Ear.relax();
            return;
          }
          $("chatHintLine").textContent = "提示：回复会自动朗读；用中文问语法和意思也可以。";
          const parsed = parseAIReply(reply);
          if (enEl) enEl.textContent = parsed.en;
          if (btnEl) btnEl.setAttribute("data-text", parsed.en);
          self.aiHistory.push({ role: "assistant", content: reply });
          if (parsed.tip) self.sys("💡 " + parsed.tip, null);
          flushSentences(reply, true);
          TTS.finishStreamQueue();
        },
        onError: function (code, errMsg) {
          self.activeStreamId = null;
          TTS.stop();
          if (myToken !== self.token) return;
          self.busy = false;
          if (bubble && bubble.parentNode) bubble.parentNode.removeChild(bubble);
          $("chatHintLine").textContent = "";
          Stage.settle();
          self.sys("请求失败（" + esc(String(code || "")) + "）：" + esc(errMsg || "请检查网络或接口配置") + "。", null);
          if (Ear.on) Ear.relax();
        }
      });
    }
  };

  function parseAIReply(text) {
    let raw = String(text || "").trim();
    let tip = "";
    const lines = raw.split(/\n+/);
    const kept = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^\s*(TIP|Tip|tip|提示)\s*[:：]/.test(l)) {
        tip = l.replace(/^\s*(TIP|Tip|tip|提示)\s*[:：]\s*/, "");
      } else {
        kept.push(l);
      }
    }
    let en = kept.join("\n").trim();
    if (!en && tip) { en = ""; }
    return { en: en || raw, tip: tip };
  }

  /* ========================= AI 接口 ========================= */

  const AI_PRESETS = {
    zhipu: { name: "智谱 GLM", endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions", model: "glm-4-flash" },
    deepseek: { name: "DeepSeek", endpoint: "https://api.deepseek.com/chat/completions", model: "deepseek-chat" },
    dashscope: { name: "通义千问", endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", model: "qwen-turbo" },
    siliconflow: { name: "硅基流动", endpoint: "https://api.siliconflow.cn/v1/chat/completions", model: "Qwen/Qwen2.5-7B-Instruct" },
    custom: { name: "自定义", endpoint: "", model: "" }
  };

  const AI = {
    configured: function () {
      const a = State.ai;
      return !!(a && a.endpoint && a.model && a.key);
    },

    currentName: function () {
      const a = State.ai || {};
      const p = AI_PRESETS[a.provider] || AI_PRESETS.custom;
      return (a.provider === "custom" ? "自定义接口" : p.name) + " · " + (a.model || "");
    },

    systemPrompt: function () {
      return "你是一位中英双语的口语陪练老师（可能是 Buddy / Emma / Alex 中的一位），学生是中国学习者，年龄不限，水平从入门到中级。" +
        "规则：" +
        "1) 默认用自然、简短、口语化的英语回应，每次最多 2-3 句，像真人打电话聊天，不要长篇大论，不要用列表；说完主动提一个简单的问题让对话继续。" +
        "2) 如果学生用中文提问（例如“什么意思”“怎么用英语说”“语法解释一下”“帮我纠正”“再说一遍”），就用简体中文清楚解释，给出 1-2 个地道英文例句，最后用一句英文把对话带回英语。" +
        "3) 学生中英文混着说时，顺着他的意思回应，不要说“请说英语”之类的话。" +
        "4) 这是实时语音对话：你随时可能被学生打断。被打断后立刻顺着学生新说的内容接话，不要重复被打断的旧句子，也不要问“我刚才说到哪了”。" +
        "5) 如果对方有明显的语法或用词错误，先自然接住对方的意思，然后在最后单独一行以“TIP: ”开头，用简体中文指出一个最主要的改进点，并给出更地道的说法；只是聊天时不必每次都纠错。" +
        "6) 内容健康、适合青少年；不要索要真实姓名、住址、学校等隐私信息。";
    },

    buildMessages: function (context, history) {
      const msgs = [{ role: "system", content: this.systemPrompt() + (context ? "\n\n" + context : "") }];
      for (let i = 0; i < history.length; i++) msgs.push(history[i]);
      return msgs;
    },

    chatStream: function (context, history, handlers) {
      const a = State.ai;
      const body = JSON.stringify({
        model: a.model,
        messages: this.buildMessages(context, history),
        temperature: 0.7,
        max_tokens: 320,
        stream: true
      });
      return Http.stream("POST", a.endpoint, {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + a.key
      }, body, handlers);
    },

    chat: function (context, history) {
      const a = State.ai;
      const body = JSON.stringify({
        model: a.model,
        messages: this.buildMessages(context, history),
        temperature: 0.7,
        max_tokens: 320,
        stream: false
      });
      return Http.request("POST", a.endpoint, {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + a.key
      }, body).then(function (text) {
        let data = null;
        try { data = JSON.parse(text); } catch (e) {}
        if (!data) throw new Error("接口返回的不是 JSON");
        if (data.error) throw new Error(data.error.message || data.error.code || "接口返回错误");
        let content = "";
        if (data.choices && data.choices[0]) {
          const c = data.choices[0];
          content = (c.message && c.message.content) || c.text || "";
        } else if (data.output && data.output.text) {
          content = data.output.text;
        }
        if (!content) throw new Error("接口没有返回内容");
        return content;
      });
    },

    test: function () {
      if (!State.ai) { $("aiStatus").textContent = "先填好地址、模型和 Key，再点保存。"; return; }
      $("aiStatus").textContent = "正在测试…";
      const a = State.ai;
      const body = JSON.stringify({
        model: a.model,
        messages: [{ role: "user", content: "Say OK in English, one word." }],
        max_tokens: 12,
        stream: false
      });
      Http.request("POST", a.endpoint, {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + a.key
      }, body).then(function (text) {
        let data = null;
        try { data = JSON.parse(text); } catch (e) {}
        const ok = data && data.choices && data.choices[0];
        $("aiStatus").textContent = ok ? "✅ 连接成功，可以开始对话了。" : "接口有响应，但格式不对，检查模型名。";
      }).catch(function (e) {
        $("aiStatus").textContent = "❌ 失败：" + e.message;
      });
    },

    save: function () {
      const provider = $("aiProvider").value;
      const endpoint = $("aiEndpoint").value.trim();
      const model = $("aiModel").value.trim();
      const key = $("aiKey").value.trim();
      if (!endpoint || !model || !key) {
        $("aiStatus").textContent = "地址、模型名、API Key 三项都要填。";
        return;
      }
      if (!/^https:\/\//i.test(endpoint)) {
        $("aiStatus").textContent = "接口地址必须以 https:// 开头。";
        return;
      }
      State.ai = { provider: provider, endpoint: endpoint, model: model, key: key };
      LS.set("erc.ai", State.ai);
      $("aiStatus").textContent = "已保存在本机。只会在你发消息时请求这个地址。";
      toast("AI 接口已保存");
    },

    clear: function () {
      State.ai = null;
      LS.set("erc.ai", null);
      $("aiKey").value = "";
      $("aiStatus").textContent = "已清除。离线功能不受影响。";
      toast("已清除 AI 配置");
    }
  };

  /* ========================= 情景列表 ========================= */

  function renderScenarios() {
    const items = SCENARIOS[currentConvTier] || [];
    Stage.setPersona(currentConvTier);
    document.querySelectorAll("#stageTiers .persona-btn").forEach(function (b) {
      if (b.dataset.tier) b.classList.toggle("on", b.dataset.tier === currentConvTier);
    });
    $("scenarioList").innerHTML = items.map(function (sc) {
      const done = !!State.done[sc.id];
      return '<div class="item" data-act="open-scenario" data-id="' + attr(sc.id) + '">' +
        '<div class="item-emoji">' + (sc.emoji || "💬") + "</div>" +
        '<div class="item-main">' +
          '<div class="item-title">' + esc(sc.title) + "</div>" +
          '<div class="item-en">' + esc(sc.titleEn) + "</div>" +
          '<div class="item-meta"><span>' + esc(sc.level) + "</span><span>" + sc.turns.length + " 轮</span>" + (done ? "<span>✓ 已完成</span>" : "") + "</div>" +
        "</div>" +
        '<div class="item-go">›</div>' +
      "</div>";
    }).join("");

    const ai = AI.configured();
    $("aiCard").innerHTML =
      '<div class="item-title">🤖 AI 自由外教' + (ai ? ' <span class="stat" style="vertical-align:2px">已配置</span>' : "") + "</div>" +
      '<div class="hero-sub" style="margin-top:4px">' +
        (ai
          ? "用你自己填的免费接口练自由对话，回复自动朗读，说错了会用中文提醒。"
          : "可选功能：填入你自己的免费接口（如智谱 GLM-4-Flash），就能不限话题地聊。不填也不影响上面 9 个情景。") +
      "</div>" +
      '<div class="row wrap">' +
        '<button class="btn primary small" data-act="open-ai">' + (ai ? "开始对话" : "试试看") + "</button>" +
        '<button class="btn small" data-act="goto-ai-settings">' + (ai ? "改接口" : "去配置") + "</button>" +
      "</div>";
  }

  let currentConvTier = "kids";

  function findScenario(id) {
    const tiers = ["kids", "teen", "adult"];
    for (let i = 0; i < tiers.length; i++) {
      const arr = SCENARIOS[tiers[i]] || [];
      for (let j = 0; j < arr.length; j++) if (arr[j].id === id) return arr[j];
    }
    return null;
  }

  function tierOfScenario(id) {
    const tiers = ["kids", "teen", "adult"];
    for (let i = 0; i < tiers.length; i++) {
      const arr = SCENARIOS[tiers[i]] || [];
      for (let j = 0; j < arr.length; j++) if (arr[j].id === id) return tiers[i];
    }
    return null;
  }

  /* ========================= 自定义文章 ========================= */

  function splitSentences(text) {
    let t = String(text || "").replace(/\r/g, " ").replace(/\s+/g, " ").trim();
    if (!t) return [];
    const ABBR = ["Mr.", "Mrs.", "Ms.", "Dr.", "Prof.", "St.", "vs.", "etc.", "e.g.", "i.e.", "a.m.", "p.m.", "U.S.", "U.K."];
    ABBR.forEach(function (a, i) { t = t.split(a).join("\u0001" + i + "\u0002"); });
    t = t.replace(/(\d)\.(\d)/g, "$1\u0003$2");
    const parts = t.match(/[^.!?]+[.!?]+["')\]]?|[^.!?]+$/g) || [t];
    return parts.map(function (s) {
      let r = s;
      ABBR.forEach(function (a, i) { r = r.split("\u0001" + i + "\u0002").join(a); });
      return r.replace(/\u0003/g, ".").trim();
    }).filter(function (s) { return /[A-Za-z]/.test(s); });
  }

  function saveCustom() {
    const title = $("cTitle").value.trim();
    const text = $("cText").value.trim();
    const zhRaw = $("cZh").value.trim();
    if (!text) { toast("先把英文正文粘进来"); return; }
    const sentences = splitSentences(text);
    if (!sentences.length) { toast("没读到英文句子，检查一下内容"); return; }

    let zh = [];
    if (zhRaw) {
      const zhParts = zhRaw.split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (zhParts.length === sentences.length) {
        zh = zhParts;
      } else {
        const zhAll = zhRaw.replace(/\s+/g, " ").trim();
        zh = sentences.map(function (_, i) { return i === 0 ? zhAll : ""; });
      }
    }

    const item = {
      id: "custom-" + Date.now(),
      emoji: "📄",
      title: title || "我的文章",
      titleZh: title || "我的文章",
      level: "自定义 · 共 " + sentences.length + " 句",
      minutes: Math.max(1, Math.round(sentences.length / 4)),
      goal: "按句点读，点词查词，读完试着用英文复述",
      sentences: sentences,
      zh: zh,
      notes: sentences.map(function () { return null; }),
      qa: []
    };
    State.custom.unshift(item);
    LS.set("erc.custom", State.custom);
    $("cTitle").value = "";
    $("cText").value = "";
    $("cZh").value = "";
    $("customMask").classList.add("hidden");
    switchTab("library");
    currentTier = "custom";
    document.querySelectorAll("#tierSeg .seg-item").forEach(function (b) {
      b.classList.toggle("active", b.dataset.tier === "custom");
    });
    renderLibrary();
    Reader.open(item);
  }

  /* ========================= 事件分发 ========================= */

  function dispatch(act, data, el) {
    switch (act) {
      case "open-passage": {
        const it = findItem(data.id);
        if (it) Reader.open(it);
        break;
      }
      case "open-scenario": {
        const sc = findScenario(data.id);
        if (sc) Chat.openScenario(sc);
        break;
      }
      case "open-ai": {
        Chat.openAI("", "");
        break;
      }
      case "goto-ai-settings": {
        switchTab("settings");
        setTimeout(function () {
          const el = $("aiSettings");
          if (el && el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "start" });
        }, 80);
        break;
      }
      case "ask-ai-reading": {
        if (!AI.configured()) {
          toast("先到设置里填自己的免费 AI 接口；不填也能用离线问答");
          switchTab("settings");
          return;
        }
        const it = Reader.item;
        if (!it) return;
        Chat.openAI(it.titleZh || it.title, (it.sentences || []).map(plainSentence).join(" "));
        break;
      }
      case "speak-text": {
        const t = data.text || "";
        if (t) TTS.speak(t, {});
        break;
      }
      case "qa-mic": {
        const qi = parseInt(data.qi, 10) || 0;
        const input = document.querySelector('.qa-input[data-qi="' + qi + '"]');
        ASR.start({
          input: input,
          onText: function (text) {
            if (input) input.value = text;
            checkQA(qi);
          }
        });
        break;
      }
      case "qa-check": {
        checkQA(parseInt(data.qi, 10) || 0);
        break;
      }
      case "vocab-speak": {
        TTS.speak(data.w || "", {});
        break;
      }
      case "vocab-del": {
        const w = data.w;
        State.vocab = State.vocab.filter(function (v) { return v.w !== w; });
        saveVocab();
        renderVocab();
        renderLibrary();
        toast("已删除：" + w);
        break;
      }
      case "use-chip": {
        $("chatText").value = data.text || "";
        Chat.send(data.text || "");
        break;
      }
      case "chat-zh": {
        Chat.toggleZh();
        break;
      }
      case "bubble-zh": {
        const bubble = el ? el.closest(".bubble") : null;
        const zh = bubble ? bubble.querySelector(".b-zh") : null;
        if (zh) {
          const show = zh.classList.contains("hidden");
          zh.classList.toggle("hidden", !show);
          if (el) el.textContent = show ? "收起中文" : "译 中文";
        }
        break;
      }
      case "sf-record": {
        Sf.toggleRecord();
        break;
      }
      case "sf-play": {
        Sf.play();
        break;
      }
      case "sf-done": {
        Sf.done();
        break;
      }
      case "open-ai-from-reader": {
        Chat.openAI("", "");
        break;
      }
      case "dismiss-guide": {
        State.guideDismissed = true;
        LS.set("erc.guide", true);
        if ($("guideCard")) $("guideCard").classList.add("hidden");
        toast("已收起引导，点句子就能开始读");
        break;
      }
      default:
        break;
    }
  }

  document.addEventListener("click", function (e) {
    const w = e.target.closest(".w");
    if (w && !e.target.closest("#chatStream")) {
      openWord(w.dataset.w);
      return;
    }
    const t = e.target.closest("[data-act]");
    if (!t) return;
    if (t.tagName === "INPUT") return;
    dispatch(t.dataset.act, t.dataset, t);
  });

  /* ========================= 绑定 ========================= */

  function bind() {
    // 顶栏
    $("btnZh").addEventListener("click", function () {
      State.settings.bilingual = !State.settings.bilingual;
      applySettings();
      if (currentView === "reader") Reader.rerender();
      toast(State.settings.bilingual ? "已显示中文对照" : "已隐藏中文对照");
    });

    $("btnFont").addEventListener("click", cycleFont);
    $("btnTheme").addEventListener("click", cycleTheme);

    $("btnBack").addEventListener("click", function () {
      if (currentView === "reader") Reader.close();
      else if (currentView === "chat") Chat.closeChat();
    });

    // 底栏
    $("tabbar").addEventListener("click", function (e) {
      const b = e.target.closest(".tab");
      if (b) switchTab(b.dataset.tab);
    });

    // 书库分段
    $("tierSeg").addEventListener("click", function (e) {
      const b = e.target.closest(".seg-item");
      if (!b) return;
      currentTier = b.dataset.tier;
      $("tierSeg").querySelectorAll(".seg-item").forEach(function (x) {
        x.classList.toggle("active", x.dataset.tier === currentTier);
      });
      renderLibrary();
    });

    // 角色切换（舞台上的三个陪练 + 连续对话开关）
    $("stageTiers").addEventListener("click", function (e) {
      const b = e.target.closest(".persona-btn");
      if (!b) return;
      if (b.id === "btnAutoTurn") {
        State.settings.autoTurn = !State.settings.autoTurn;
        applySettings();
        toast(State.settings.autoTurn
          ? "连续对话已打开：对方说完会自动打开麦克风"
          : "连续对话已关闭，改用手动点 🎙️ 或打字");
        return;
      }
      if (!b.dataset.tier) return;
      currentConvTier = b.dataset.tier;
      renderScenarios();
      Stage.settle();
    });

    // 阅读工具栏
    $("btnPlayAll").addEventListener("click", function () {
      if (Reader.playing) Reader.stop();
      else Reader.playAll();
    });
    $("btnStop").addEventListener("click", function () { Reader.stop(); });

    $("btnSpeed").addEventListener("click", cycleSpeed);

    $("btnAccent").addEventListener("click", function () {
      State.settings.accent = State.settings.accent === "en-GB" ? "en-US" : "en-GB";
      applySettings();
      toast(State.settings.accent === "en-GB" ? "已切换为英音" : "已切换为美音");
    });

    $("btnLoop").addEventListener("click", function () {
      State.settings.loop = !State.settings.loop;
      applySettings();
      toast(State.settings.loop ? "单句循环已打开" : "单句循环已关闭");
    });

    $("btnNotes").addEventListener("click", function () {
      State.settings.notes = !State.settings.notes;
      applySettings();
      if (currentView === "reader") Reader.rerender();
      toast(State.settings.notes ? "已显示句子讲解" : "已隐藏句子讲解");
    });

    // 句子点击
    $("sentences").addEventListener("click", function (e) {
      const sent = e.target.closest(".sent");
      if (!sent) return;
      if (e.target.closest(".w")) return;
      const idx = parseInt(sent.dataset.idx, 10);
      if (isNaN(idx)) return;
      if (Reader.playing) Reader.playFrom(idx);
      else Reader.speakOne(idx);
    });

    // 跟读
    $("btnRec").addEventListener("click", function () { Rec.toggle(); });
    $("btnPlayMine").addEventListener("click", function () { Rec.play(); });
    $("btnCompare").addEventListener("click", function () { Rec.compare(); });
    $("btnDelRec").addEventListener("click", function () { Rec.remove(); });

    // 单词弹层
    $("wClose").addEventListener("click", closeWord);
    $("wordMask").addEventListener("click", function (e) {
      if (e.target === $("wordMask")) closeWord();
    });
    $("wSpeak").addEventListener("click", function () {
      if (wordCurrent) TTS.speak(wordCurrent.w, {});
    });
    $("wAdd").addEventListener("click", function () {
      if (!wordCurrent) return;
      addWord(wordCurrent.w, wordCurrent.entry);
      $("wAdd").textContent = "✔️ 已在生词本";
      $("wAdd").disabled = true;
    });
    $("wOnline").addEventListener("click", onlineLookup);

    // 自定义文章
    $("btnCustomOpen").addEventListener("click", function () {
      $("customMask").classList.remove("hidden");
    });
    $("cClose").addEventListener("click", function () { $("customMask").classList.add("hidden"); });
    $("cCancel").addEventListener("click", function () { $("customMask").classList.add("hidden"); });
    $("cSave").addEventListener("click", saveCustom);
    $("customMask").addEventListener("click", function (e) {
      if (e.target === $("customMask")) $("customMask").classList.add("hidden");
    });

    // 生词本
    $("btnReview").addEventListener("click", function () { Flash.open(); });
    $("btnShowMastered").addEventListener("click", function () {
      State.showMastered = !State.showMastered;
      $("btnShowMastered").classList.toggle("on", State.showMastered);
      renderVocab();
    });
    $("flashCard").addEventListener("click", function () { Flash.flip(); });
    $("flashNext").addEventListener("click", function (e) { e.stopPropagation(); Flash.next(); });
    $("flashPrev").addEventListener("click", function (e) { e.stopPropagation(); Flash.prev(); });
    $("flashSpeak").addEventListener("click", function (e) {
      e.stopPropagation();
      const v = Flash.list[Flash.i];
      if (v) TTS.speak(v.head || v.w, {});
    });
    $("flashMaster").addEventListener("click", function (e) { e.stopPropagation(); Flash.master(); });
    $("flashClose").addEventListener("click", function (e) { e.stopPropagation(); Flash.close(); });

    // 对话
    $("btnSend").addEventListener("click", function () { Chat.send($("chatText").value); });
    $("chatText").addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        Chat.send($("chatText").value);
      }
    });
    $("btnMic").addEventListener("click", function () {
      if (ASR.listening) { ASR.stop(); return; }
      ASR.start({
        input: $("chatText"),
        onText: function (text) { $("chatText").value = text; Chat.send(text); }
      });
    });
    $("btnHint").addEventListener("click", function () { Chat.hint(); });
    $("btnRestart").addEventListener("click", function () { Chat.restart(); });
    $("btnZhChat").addEventListener("click", function () { Chat.toggleZh(); });
    if ($("btnLangChat")) $("btnLangChat").addEventListener("click", function () { Ear.cycleLang(); });

    // 耳机后台连麦
    if ($("btnEar")) $("btnEar").addEventListener("click", function () { Ear.toggle(); });
    if ($("btnEarChat")) $("btnEarChat").addEventListener("click", function () { Ear.toggle(); });
    document.querySelectorAll("[data-lang]").forEach(function (b) {
      b.addEventListener("click", function () { Ear.setLang(b.dataset.lang); });
    });

    // 设置里的分段
    $("setFontSeg").addEventListener("click", function (e) {
      const b = e.target.closest("button");
      if (!b) return;
      State.settings.font = b.dataset.font;
      applySettings();
      fillSettingsForm();
    });
    $("setThemeSeg").addEventListener("click", function (e) {
      const b = e.target.closest("button");
      if (!b) return;
      State.settings.theme = b.dataset.theme;
      applySettings();
      fillSettingsForm();
    });
    $("setSpeedSeg").addEventListener("click", function (e) {
      const b = e.target.closest("button");
      if (!b) return;
      State.settings.speed = Number(b.dataset.speed);
      applySettings();
      fillSettingsForm();
    });
    $("setAccentSeg").addEventListener("click", function (e) {
      const b = e.target.closest("button");
      if (!b) return;
      State.settings.accent = b.dataset.accent;
      applySettings();
      fillSettingsForm();
    });
    if ($("setLangSeg")) {
      $("setLangSeg").addEventListener("click", function (e) {
        const b = e.target.closest("button");
        if (b) Ear.setLang(b.dataset.asrLang);
      });
    }
    $("setBilingual").addEventListener("click", function () {
      State.settings.bilingual = !State.settings.bilingual;
      applySettings();
      fillSettingsForm();
    });
    $("setAutoPlay").addEventListener("click", function () {
      State.settings.autoPlay = !State.settings.autoPlay;
      applySettings();
      fillSettingsForm();
    });

    // AI 配置
    $("aiProvider").addEventListener("change", function () {
      const p = AI_PRESETS[$("aiProvider").value] || AI_PRESETS.custom;
      $("aiEndpoint").value = p.endpoint;
      $("aiModel").value = p.model;
    });
    $("btnAiSave").addEventListener("click", function () { AI.save(); });
    $("btnAiTest").addEventListener("click", function () {
      if (!State.ai) { AI.save(); if (!State.ai) return; }
      AI.test();
    });
    $("btnAiClear").addEventListener("click", function () { AI.clear(); fillSettingsForm(); });
  }

  /* ========================= 启动 ========================= */

  const App = {
    handleBack: function () {
      if (currentView === "reader") { Reader.close(); return "handled"; }
      if (currentView === "chat") { Chat.closeChat(); return "handled"; }
      if (!$("flashWrap").classList.contains("hidden")) { Flash.close(); return "handled"; }
      if (currentView !== "library") { switchTab("library"); return "handled"; }
      return "exit";
    }
  };
  window.App = App;

  function boot() {
    bind();
    applySettings();
    Stage.personaId = currentConvTier;
    Stage.mount();
    Ear.load();
    Ear.render();
    // 让原生层的识别语言和上次保存的一致（默认中英自动）
    if (Bridge && Bridge.setAsrLanguage) { try { Bridge.setAsrLanguage(Ear.langMode); } catch (e) {} }
    $("btnShowMastered").classList.toggle("on", State.showMastered);
    if (Bridge && Bridge.appVersion) {
      try { $("aboutVersion").textContent = "版本 " + Bridge.appVersion(); } catch (e) {}
    } else {
      $("aboutVersion").textContent = "版本 1.2.0";
    }
    renderLibrary();
    renderScenarios();
    renderVocab();
    Rec.refresh();
    // 顶部栏滚动阴影
    $("main").addEventListener("scroll", function () {
      const t = $("main").scrollTop;
      document.querySelector(".topbar").classList.toggle("scrolled", t > 4);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
