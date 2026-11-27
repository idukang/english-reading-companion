/* ===========================================================
   英语陪读 —— 应用逻辑
   · 全部内容本地运行，不加载任何外部脚本、不发送统计
   · 与安卓外壳通过 window.AndroidBridge 通信（TTS / 录音 / 语音识别 / 联网）
   · 部分交互与动效参考：Lucian UX/UI Prompt（MIT, github.com/Seokwoooo/lucian-uxui-prompt）
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

  let toastSeq = 0;
  /**
   * 轻提示：可堆叠、带细进度条。
   * 保留原来的调用方式 toast("文字")，任何页面都能直接用；最多同时叠 3 条，
   * 新的从下方弹入，旧的到时间自动收走，点一下也能提前关。
   */
  function toast(msg) {
    const host = $("toast");
    if (!host) return;
    const el = document.createElement("div");
    el.className = "toast-item";
    el.dataset.tid = String(++toastSeq);
    el.innerHTML = '<span class="t-ico" aria-hidden="true">✦</span>' +
      '<span class="t-msg"></span><span class="t-bar" aria-hidden="true"><i></i></span>';
    el.querySelector(".t-msg").textContent = String(msg == null ? "" : msg);
    host.appendChild(el);
    while (host.children.length > 3) host.removeChild(host.firstChild);

    const life = Math.max(2400, Math.min(4600, 2200 + String(msg || "").length * 55));
    const bar = el.querySelector(".t-bar i");
    bar.style.animationDuration = life + "ms";

    let closed = false;
    let left = life;
    let started = Date.now();
    let timer = null;
    function close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      el.classList.add("out");
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
    }
    function arm(ms) {
      clearTimeout(timer);
      started = Date.now();
      left = ms;
      timer = setTimeout(close, ms);
    }
    arm(life);
    el.addEventListener("click", close);
    // 手指按住或鼠标悬停时先别消失，松开后接着上一段剩余时间
    el.addEventListener("pointerenter", function () {
      if (closed) return;
      clearTimeout(timer);
      left = Math.max(400, left - (Date.now() - started));
      bar.style.animationPlayState = "paused";
    });
    el.addEventListener("pointerleave", function () {
      if (closed) return;
      bar.style.animationPlayState = "running";
      arm(left);
    });
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
    autoTurn: false,
    // 英文音色：neural = 内置离线神经音色（默认），system = 手机自带语音
    voice: "neural",
    // 句型闯关的过关提示音（手机媒体音量为 0 时也会自动静音）
    sfx: true
  };

  /* ========================= 多人本地学习档案 =========================
     每个家人一个档案：已读、生词、自定义文章、完成记录、连续天数各自独立。
     全部只存在本机 localStorage，不联网、不需要账号。
     从 v1.2.2 及更早版本覆盖升级时，原来的单套数据会原样搬进「默认档案」，
     旧键保留不删，任何记录都不会丢。 */

  const PROFILE_EMOJIS = ["🧸", "🎒", "📰", "🌱", "🚀", "🦊"];
  const PROFILE_MAX = 8;

  const ProfileStore = {
    KEY: "erc.profiles",
    store: null,
    activeId: "",

    load: function () {
      let s = LS.get(this.KEY, null);
      const valid = s && Array.isArray(s.list) && s.list.length > 0;
      if (!valid) {
        const id = "p" + Date.now().toString(36);
        let speed = 1.0;
        const oldSettings = LS.get("erc.settings", null);
        if (oldSettings && typeof oldSettings === "object" && typeof oldSettings.speed === "number") {
          speed = oldSettings.speed;
        }
        s = {
          active: id,
          list: [{ id: id, name: "默认档案", emoji: "🧸", tier: "kids", speed: speed, voice: "neural", created: Date.now() }]
        };
        // 旧版单套学习数据整体搬进默认档案（原键保留，不删任何记录）
        ["read", "vocab", "custom", "done"].forEach(function (k) {
          const v = LS.get("erc." + k, null);
          if (v !== null && v !== undefined) LS.set("erc.p." + id + "." + k, v);
        });
        const streak = LS.get("erc.streak", null);
        if (streak) LS.set("erc.p." + id + ".streak", streak);
        LS.set(this.KEY, s);
      }

      // 兼容早期档案记录，缺什么补什么
      s.list = s.list.filter(function (p) { return p && typeof p.id === "string" && p.id; });
      if (!s.list.length) {
        const id = "p" + Date.now().toString(36);
        s.list = [{ id: id, name: "默认档案", emoji: "🧸", tier: "kids", speed: 1.0, created: Date.now() }];
      }
      s.list.forEach(function (p, i) {
        p.name = String(p.name || ("档案 " + (i + 1))).slice(0, 16);
        p.emoji = PROFILE_EMOJIS.indexOf(p.emoji) >= 0 ? p.emoji : PROFILE_EMOJIS[0];
        p.tier = (p.tier === "teen" || p.tier === "adult") ? p.tier : "kids";
        p.speed = (typeof p.speed === "number" && p.speed > 0) ? p.speed : 1.0;
        p.voice = (p.voice === "system") ? "system" : "neural";
      });
      if (!s.list.some(function (p) { return p.id === s.active; })) s.active = s.list[0].id;

      this.store = s;
      this.activeId = s.active;
      LS.set(this.KEY, s);
      return s;
    },

    profile: function () {
      if (!this.store) this.load();
      for (let i = 0; i < this.store.list.length; i++) {
        if (this.store.list[i].id === this.activeId) return this.store.list[i];
      }
      return this.store.list[0];
    },

    dataKey: function (key) {
      return "erc.p." + this.activeId + "." + key;
    },

    data: function (key, def) {
      return LS.get(this.dataKey(key), def);
    },

    save: function (key, val) {
      LS.set(this.dataKey(key), val);
    },

    saveStore: function () {
      LS.set(this.KEY, this.store);
    },

    setPref: function (patch) {
      const p = this.profile();
      if (!p || !patch) return;
      if (typeof patch.name === "string" && patch.name.trim()) p.name = patch.name.trim().slice(0, 16);
      if (PROFILE_EMOJIS.indexOf(patch.emoji) >= 0) p.emoji = patch.emoji;
      if (patch.tier === "kids" || patch.tier === "teen" || patch.tier === "adult") p.tier = patch.tier;
      if (typeof patch.speed === "number" && patch.speed > 0) p.speed = patch.speed;
      if (patch.voice === "neural" || patch.voice === "system") p.voice = patch.voice;
      this.saveStore();
      return p;
    },

    create: function (name, emoji, tier, speed) {
      if (!this.store) this.load();
      if (this.store.list.length >= PROFILE_MAX) {
        toast("最多 " + PROFILE_MAX + " 个档案；不用的档案可以改名继续用");
        return null;
      }
      const id = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const prof = {
        id: id,
        name: String(name || "新档案").trim().slice(0, 16) || "新档案",
        emoji: PROFILE_EMOJIS.indexOf(emoji) >= 0 ? emoji : "🧸",
        tier: (tier === "teen" || tier === "adult") ? tier : "kids",
        speed: (typeof speed === "number" && speed > 0) ? speed : 1.0,
        voice: "neural",
        created: Date.now()
      };
      this.store.list.push(prof);
      this.saveStore();
      return prof;
    },

    switchTo: function (id) {
      if (!this.store) this.load();
      if (id === this.activeId) return false;
      if (!this.store.list.some(function (p) { return p.id === id; })) return false;
      // 切走前先把当前语速/年龄偏好写回当前档案
      const cur = this.profile();
      if (cur) {
        cur.speed = Number(State.settings.speed) || cur.speed;
        cur.voice = State.settings.voice === "system" ? "system" : "neural";
      }
      this.activeId = id;
      this.store.active = id;
      this.saveStore();
      loadProfileData();
      applyActiveProfile();
      return true;
    }
  };

  ProfileStore.load();

  function profileArr(key) {
    const v = ProfileStore.data(key, []);
    return Array.isArray(v) ? v : [];
  }

  const State = {
    settings: Object.assign({}, DEFAULTS, LS.get("erc.settings", {})),
    vocab: profileArr("vocab"),
    read: profileArr("read"),
    custom: profileArr("custom"),
    done: ProfileStore.data("done", {}) || {},
    ai: LS.get("erc.ai", null),
    guideDismissed: LS.get("erc.guide", false),
    showMastered: false
  };
  if (!Array.isArray(State.vocab)) State.vocab = [];
  if (!Array.isArray(State.read)) State.read = [];
  if (!Array.isArray(State.custom)) State.custom = [];
  if (!State.done || typeof State.done !== "object") State.done = {};

  function saveSettings() {
    LS.set("erc.settings", State.settings);
    if (ProfileStore.store) {
      ProfileStore.setPref({
        speed: Number(State.settings.speed) || 1.0,
        voice: State.settings.voice === "system" ? "system" : "neural"
      });
    }
  }
  function saveVocab() { ProfileStore.save("vocab", State.vocab); }
  function saveRead() { ProfileStore.save("read", State.read); }
  function saveCustomData() { ProfileStore.save("custom", State.custom); }
  function saveDone() { ProfileStore.save("done", State.done); }

  /** 切换档案后把 State 换成新档案的数据（各页面随后重绘） */
  function loadProfileData() {
    State.read = profileArr("read");
    State.vocab = profileArr("vocab");
    State.custom = profileArr("custom");
    State.done = ProfileStore.data("done", {}) || {};
    if (!State.done || typeof State.done !== "object") State.done = {};
    State.vocab.forEach(function (v) { SRS.upgrade(v); });
    saveVocab();
    Streak.load();
  }

  /* ========================= 生词间隔重复（轻量 SRS） =========================
     每个生词记录 reps / intervalDays / dueAt：
       · 「再记一下」→ 半小时后再来（当天还会再遇到）
       · 「记住了」→ 按 1 / 3 / 7 / 15 / 30 / 60 / 120 天逐步拉长
       · 「标记已掌握」→ 30 天后再复查一次
     旧版生词没有这些字段，读取时自动补默认值。 */

  const SRS = {
    LADDER: [1, 3, 7, 15, 30, 60, 120],
    DAY: 86400000,

    upgrade: function (v) {
      if (!v || typeof v !== "object") return v;
      if (typeof v.reps !== "number" || !isFinite(v.reps) || v.reps < 0) v.reps = 0;
      if (typeof v.intervalDays !== "number" || !isFinite(v.intervalDays) || v.intervalDays < 0) v.intervalDays = 0;
      if (typeof v.dueAt !== "number" || !isFinite(v.dueAt) || v.dueAt < 0) v.dueAt = 0;
      if (typeof v.lapses !== "number" || v.lapses < 0) v.lapses = 0;
      if (typeof v.mastered !== "boolean") v.mastered = false;
      return v;
    },

    isDue: function (v) {
      if (!v || v.mastered) return false;
      return !v.dueAt || v.dueAt <= Date.now();
    },

    dueCount: function () {
      return State.vocab.filter(function (v) { return SRS.isDue(v); }).length;
    },

    /** 复习结果：remembered=true 记住了；false 再记一下 */
    review: function (v, remembered) {
      this.upgrade(v);
      v.reps = (v.reps || 0) + 1;
      if (remembered) {
        let idx = 0;
        if (v.intervalDays > 0) {
          for (let i = 0; i < this.LADDER.length; i++) {
            if (v.intervalDays >= this.LADDER[i]) idx = Math.min(i + 1, this.LADDER.length - 1);
          }
        }
        v.intervalDays = this.LADDER[idx];
      } else {
        v.lapses = (v.lapses || 0) + 1;
        v.intervalDays = 0.02; // 约半小时，当天还会再碰到
      }
      v.dueAt = Date.now() + Math.round(v.intervalDays * this.DAY);
      v.lastAt = Date.now();
      return v;
    },

    master: function (v) {
      this.upgrade(v);
      v.mastered = true;
      v.intervalDays = 30;
      v.dueAt = Date.now() + 30 * this.DAY;
      v.lastAt = Date.now();
      return v;
    },

    /** 复习队列排序：到期的最先，其次没复习过的，再其次还没到期的 */
    queue: function (list) {
      const now = Date.now();
      const rank = function (v) {
        if (!v.dueAt) return 1;
        return v.dueAt <= now ? 0 : 2;
      };
      return list.slice().sort(function (a, b) {
        const ra = rank(a), rb = rank(b);
        if (ra !== rb) return ra - rb;
        if ((a.dueAt || 0) !== (b.dueAt || 0)) return (a.dueAt || 0) - (b.dueAt || 0);
        return (a.ts || 0) - (b.ts || 0);
      });
    },

    dueText: function (v) {
      if (!v) return "";
      if (v.mastered) return "已掌握 · 30 天后复查";
      if (!v.dueAt) return "新词 · 第一次复习";
      const left = v.dueAt - Date.now();
      if (left <= 0) return "今天该复习了";
      const days = left / this.DAY;
      if (days < 1) return "约 " + Math.max(1, Math.round(left / 60000)) + " 分钟后再复习";
      return "约 " + Math.round(days) + " 天后再复习";
    },

    /** 开聊时挑最多 3 个到期或未掌握的词，交给外教自然复现 */
    forChat: function (limit) {
      const n = limit || 3;
      const pool = State.vocab.filter(function (v) { return !v.mastered; });
      const sorted = this.queue(pool);
      return sorted.slice(0, n);
    }
  };

  // 旧数据补齐字段（有变化才写回）
  (function () {
    let changed = false;
    State.vocab.forEach(function (v) {
      const before = v.reps + "/" + v.intervalDays + "/" + v.dueAt + "/" + v.mastered;
      SRS.upgrade(v);
      const after = v.reps + "/" + v.intervalDays + "/" + v.dueAt + "/" + v.mastered;
      if (before !== after) changed = true;
    });
    if (changed) saveVocab();
  })();

  /* ========================= 连续学习天数 =========================
     只在 localStorage 里记今天有没有学，不联网、不上报。
     读一篇文章、收一个生词、开始一次对话都算一天。 */

  const Streak = {
    data: { last: "", count: 0 },

    load: function () {
      // 连续天数跟着学习档案走：换档案就是另一个人的打卡记录
      this.data = { last: "", count: 0 };
      const d = ProfileStore.data("streak", null);
      if (d && typeof d === "object" && typeof d.last === "string" && typeof d.count === "number") {
        this.data = { last: d.last, count: Math.max(0, d.count) };
      }
      return this.data;
    },

    dayKey: function (d) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return y + "-" + m + "-" + day;
    },

    // 按“本地日历日”加减一天（走 Date，避开夏令时）
    shiftKey: function (key, delta) {
      const p = String(key).split("-").map(Number);
      if (p.length !== 3) return "";
      const d = new Date(p[0], p[1] - 1, p[2], 12, 0, 0);
      d.setDate(d.getDate() + delta);
      return this.dayKey(d);
    },

    current: function () {
      const today = this.dayKey(new Date());
      if (this.data.last === today) return this.data.count || 0;
      if (this.data.last === this.shiftKey(today, -1)) return this.data.count || 0;
      return 0;
    },

    mark: function () {
      const today = this.dayKey(new Date());
      if (this.data.last === today) {
        this.render(false);
        return;
      }
      const count = this.data.last === this.shiftKey(today, -1) ? (this.data.count || 0) + 1 : 1;
      this.data = { last: today, count: count };
      ProfileStore.save("streak", this.data);
      this.render(true);
    },

    render: function (pop) {
      const box = $("statStreak");
      const txt = $("streakText");
      if (!box || !txt) return;
      const n = this.current();
      txt.textContent = n > 0 ? "连续 " + n + " 天" : "今天开个头";
      box.style.setProperty("--heat", String(Math.min(1, n / 7)));
      box.classList.toggle("hot", n > 0);
      if (pop) {
        box.classList.remove("pop");
        void box.offsetWidth;
        box.classList.add("pop");
      }
    }
  };
  Streak.load();

  /* ========================= 学习档案界面 ========================= */

  function profileById(id) {
    const list = ProfileStore.store ? ProfileStore.store.list : [];
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function tierName(id) {
    for (let i = 0; i < TIERS.length; i++) if (TIERS[i].id === id) return TIERS[i].name.replace(/^[^ ]+ /, "");
    return "少儿启蒙";
  }

  function activeVal(seg, key) {
    if (!seg) return "";
    const b = seg.querySelector(".active");
    return b ? (b.dataset[key] || "") : "";
  }

  function pickInSeg(seg, key, value) {
    if (!seg) return;
    seg.querySelectorAll("button").forEach(function (b) {
      b.classList.toggle("active", String(b.dataset[key]) === String(value));
    });
    syncSeg(seg, false);
  }

  function renderProfiles() {
    const chips = $("profileChips");
    const list = $("profileList");
    const cur = ProfileStore.profile();
    if (chips) {
      chips.innerHTML = ProfileStore.store.list.map(function (p) {
        return '<button class="pr-chip' + (p.id === cur.id ? " on" : "") + '" data-act="profile-switch" data-id="' +
          attr(p.id) + '" title="切换到这个档案">' +
          '<span class="pr-emoji">' + esc(p.emoji) + "</span>" + esc(p.name) + "</button>";
      }).join("") +
        '<button class="pr-chip pr-add" data-act="profile-new" aria-label="新建学习档案" title="新建学习档案">＋</button>';
    }
    if (list) {
      list.innerHTML = ProfileStore.store.list.map(function (p) {
        const readArr = LS.get("erc.p." + p.id + ".read", []);
        const wordArr = LS.get("erc.p." + p.id + ".vocab", []);
        const readN = Array.isArray(readArr) ? readArr.length : 0;
        const wordN = Array.isArray(wordArr) ? wordArr.length : 0;
        const active = p.id === cur.id;
        return '<div class="profile-line' + (active ? " on" : "") + '">' +
          '<button class="pr-pick" data-act="profile-switch" data-id="' + attr(p.id) + '">' +
            '<span class="pr-avatar">' + esc(p.emoji) + "</span>" +
            '<span class="pr-info"><b>' + esc(p.name) + "</b><small>" + esc(tierName(p.tier)) +
              " · 已读 " + readN + " 篇 · 生词 " + wordN + " 个</small></span>" +
            (active ? '<span class="pr-now">当前</span>' : "") +
          "</button>" +
          '<button class="icon-btn pr-edit" data-act="profile-edit" data-id="' + attr(p.id) + '" aria-label="改名与偏好">✎</button>' +
        "</div>";
      }).join("") +
        '<p class="tiny">每个档案的已读、生词、连续天数完全分开；切换不影响别人，也不需要账号。</p>';
    }
  }

  let profileSheetMode = "new";
  let profileSheetId = "";

  function openProfileSheet(mode, id) {
    profileSheetMode = mode === "edit" ? "edit" : "new";
    profileSheetId = id || "";
    const p = (profileSheetMode === "edit" && profileById(id)) || ProfileStore.profile();
    $("profileSheetTitle").textContent = profileSheetMode === "edit" ? "修改学习档案" : "新建学习档案";
    $("pName").value = profileSheetMode === "edit" ? p.name : "";
    pickInSeg($("pEmojiSeg"), "emoji", p.emoji || "🧸");
    pickInSeg($("pTierSeg"), "tier", p.tier || "kids");
    pickInSeg($("pSpeedSeg"), "speed", p.speed || 1.0);
    $("profileMask").classList.remove("hidden");
    $("profileSave").textContent = profileSheetMode === "edit" ? "保存修改" : "建好并切换";
    setTimeout(function () { try { $("pName").focus(); } catch (e) {} }, 140);
  }

  function closeProfileSheet() {
    $("profileMask").classList.add("hidden");
  }

  function saveProfileSheet() {
    const name = ($("pName").value || "").trim();
    if (!name) { toast("先给档案起个名字"); return; }
    const emoji = activeVal($("pEmojiSeg"), "emoji") || "🧸";
    const tier = activeVal($("pTierSeg"), "tier") || "kids";
    const speed = Number(activeVal($("pSpeedSeg"), "speed")) || 1.0;

    if (profileSheetMode === "edit") {
      const p = profileById(profileSheetId);
      if (!p) return;
      p.name = name;
      p.emoji = emoji;
      p.tier = tier;
      p.speed = speed;
      ProfileStore.saveStore();
      if (p.id === ProfileStore.activeId) applyActiveProfile();
      else renderProfiles();
      closeProfileSheet();
      toast("档案已更新：" + name);
      return;
    }

    const prof = ProfileStore.create(name, emoji, tier, speed);
    if (!prof) return;
    closeProfileSheet();
    ProfileStore.switchTo(prof.id);
    renderProfiles();
    toast("已新建档案「" + prof.name + "」，从现在开始记在它名下");
  }

  /** 切换档案后，把界面整体换成新档案的数据与偏好 */
  function applyActiveProfile() {
    const p = ProfileStore.profile();
    currentTier = p.tier || "kids";
    currentConvTier = p.tier || "kids";
    if (typeof p.speed === "number" && p.speed > 0) State.settings.speed = p.speed;
    State.settings.voice = (p.voice === "system") ? "system" : "neural";
    document.querySelectorAll("#tierSeg .seg-item").forEach(function (b) {
      b.classList.toggle("active", b.dataset.tier === currentTier);
    });
    document.querySelectorAll("#stageTiers .persona-btn").forEach(function (b) {
      if (b.dataset.tier) b.classList.toggle("on", b.dataset.tier === currentConvTier);
    });
    Stage.personaId = currentConvTier;
    Stage.mount();
    applySettings();
    renderProfiles();
    renderLibrary();
    renderVocab();
    renderScenarios();
    if (currentView === "settings") fillSettingsForm();
    if (typeof Pattern !== "undefined") Pattern.onProfileChange();
    requestAnimationFrame(function () { syncAllSegs(); });
  }

  /* ========================= 分段控件滑动胶囊 ========================= */

  function syncSeg(seg, animate) {
    if (!seg) return;
    let pill = null;
    for (let i = 0; i < seg.children.length; i++) {
      if (seg.children[i].classList.contains("seg-pill")) { pill = seg.children[i]; break; }
    }
    if (!pill) {
      pill = document.createElement("span");
      pill.className = "seg-pill";
      pill.setAttribute("aria-hidden", "true");
      seg.insertBefore(pill, seg.firstChild);
    }
    seg.classList.add("has-pill");
    const active = seg.querySelector(".active") || seg.querySelector("button");
    const sr = seg.getBoundingClientRect();
    if (!active || !sr.width) { pill.style.opacity = "0"; return; }
    const ar = active.getBoundingClientRect();
    pill.style.opacity = "1";
    if (animate === false) pill.style.transition = "none";
    pill.style.width = ar.width.toFixed(1) + "px";
    pill.style.transform = "translateX(" + (ar.left - sr.left).toFixed(1) + "px)";
    if (animate === false) {
      void pill.offsetWidth;
      pill.style.transition = "";
    }
  }

  function syncAllSegs(animate) {
    document.querySelectorAll(".seg").forEach(function (s) { syncSeg(s, animate); });
  }

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
      toast("手机系统语音引擎不可用：英文仍可用内置神经音色朗读，中文解释会显示成文字");
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
    },

    onVoiceEngine: function (state) {
      neuralVoiceState = state || "idle";
      fillVoiceStatus();
      if (state === "failed") toast("内置神经音色加载失败，已自动用系统语音");
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

    /** 闯关页的「跟读整句」：不属于阅读器，直接读传入的句子 */
    readAlong: function (text) {
      const t = String(text || "").trim();
      if (!t) return;
      if (!Bridge) { toast("此版本的设备不支持录音"); return; }
      this.sentence = -1;
      TTS.stop();
      const self = this;
      if (State.settings.autoPlay) {
        TTS.speak(t, {
          onEnd: function () { setTimeout(function () { self.beginRecord(); }, 260); }
        });
      } else {
        this.beginRecord();
      }
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
      // 闯关页的跟读不属于阅读器，没有原句可对比，直接放录音
      if (this.sentence < 0 || !Reader.item) {
        try { Bridge.playRecording(); } catch (e) { toast("无法播放录音"); }
        return;
      }
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
      if (typeof Pattern !== "undefined" && Pattern.active) Pattern.syncMine();
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
      if (mic) {
        mic.classList.toggle("rec", !!on);
        mic.classList.toggle("mic-listening", !!on);
        mic.setAttribute("aria-pressed", on ? "true" : "false");
      }
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

  /** 离线的“泛词”表：挑关键词时不把 the / is 这类词当生词 */
  const STOP_WORDS = {
    the: 1, a: 1, an: 1, and: 1, or: 1, but: 1, if: 1, so: 1, because: 1, as: 1,
    is: 1, am: 1, are: 1, was: 1, were: 1, be: 1, been: 1, being: 1,
    do: 1, does: 1, did: 1, have: 1, has: 1, had: 1, will: 1, would: 1, can: 1,
    could: 1, should: 1, may: 1, might: 1, must: 1, shall: 1,
    i: 1, you: 1, he: 1, she: 1, it: 1, we: 1, they: 1, me: 1, him: 1, her: 1,
    us: 1, them: 1, my: 1, your: 1, his: 1, its: 1, our: 1, their: 1,
    this: 1, that: 1, these: 1, those: 1, there: 1, here: 1, what: 1, which: 1,
    who: 1, whom: 1, whose: 1, when: 1, where: 1, why: 1, how: 1,
    in: 1, on: 1, at: 1, to: 1, of: 1, for: 1, with: 1, from: 1, by: 1, about: 1,
    into: 1, over: 1, after: 1, before: 1, up: 1, down: 1, out: 1, off: 1,
    not: 1, no: 1, yes: 1, very: 1, too: 1, also: 1, just: 1, only: 1, more: 1,
    most: 1, some: 1, any: 1, all: 1, each: 1, every: 1, other: 1, another: 1,
    than: 1, then: 1, now: 1, well: 1, get: 1, got: 1, go: 1, went: 1, say: 1, said: 1,
    make: 1, made: 1, take: 1, took: 1, come: 1, came: 1, see: 1, saw: 1, like: 1,
    one: 1, two: 1, first: 1, next: 1, last: 1, new: 1, good: 1, big: 1, small: 1
  };

  function plainSentence(raw) {
    return String(raw).replace(/\[\[|\]\]/g, "");
  }

  /** 把一句英文渲染成可点击的单词（对话气泡用），生词本里有的词做轻标记 */
  function wordify(text) {
    const raw = String(text == null ? "" : text);
    let out = "";
    let last = 0;
    const re = /([A-Za-z]+(?:['’][A-Za-z]+)*)/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      out += esc(raw.slice(last, m.index));
      const saved = isSaved(m[1]) ? " v" : "";
      out += '<span class="w' + saved + '" data-w="' + attr(m[1]) + '">' + esc(m[1]) + "</span>";
      last = m.index + m[0].length;
    }
    out += esc(raw.slice(last));
    return out;
  }

  /** 离线也能做的柔和纠错：只挑最常见、最确定的一个点，给更地道的说法 */
  function gentleTry(text) {
    const t = " " + String(text || "").trim() + " ";
    const low = t.toLowerCase();
    if (/i am agree/i.test(low)) return "I agree.";
    if (/i very like/i.test(low)) return "I really like it.";
    if (/\bi very\b/i.test(low)) return "I really ...";
    if (/more better/i.test(low)) return "even better";
    if (/\b(he|she|it) don't\b/i.test(low)) return "He / She doesn't ...";
    if (/\bhow to say\b/i.test(low)) return "How do you say ... in English?";
    if (/\bi go\b[^.]*\byesterday\b/i.test(low)) return "I went ... yesterday.";
    if (/\bvery much like\b/i.test(low)) return "I like it very much.";
    if (/\bi\b/.test(t)) return "I ...（英文的 I 永远大写）";
    return "";
  }

  /* ========================= 视图切换 ========================= */

  const VIEWS = {
    library: "view-library",
    reader: "view-reader",
    conv: "view-conv",
    chat: "view-chat",
    pattern: "view-pattern",
    vocab: "view-vocab",
    settings: "view-settings"
  };
  let currentView = "library";
  let currentTab = "library";

  const HEADS = {
    library: ["英语陪读", "全龄段 · 零花费 · 断网可用"],
    conv: ["对话互动", "9 个真实情景，说完就有中文点评"],
    pattern: ["句型闯关", "看中文拼英文 · 词块与听写 · 全部离线"],
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
    const patternPlay = view === "pattern" && typeof Pattern !== "undefined" && Pattern.inPlay;
    $("btnBack").classList.toggle("hidden", !(view === "reader" || view === "chat" || patternPlay));
    $("shadowBar").classList.toggle("hidden", view !== "reader");
    $(VIEWS.reader).style.paddingBottom = (view === "reader") ? "66px" : "";
    if (headTitle) setHead(headTitle, headSub);
    if (view === "reader" || view === "chat") {
      $("tabbar").querySelectorAll(".tab").forEach(function (b) {
        b.classList.remove("active");
      });
    }
    if (typeof syncAllSegs === "function") {
      requestAnimationFrame(function () { syncAllSegs(); });
    }
  }

  function switchTab(tab) {
    if (!Ear.on) TTS.stop();
    if (tab !== "pattern" && typeof Pattern !== "undefined") Pattern.pause();
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
    } else if (tab === "pattern") {
      Pattern.open();
      show("pattern");
      setHead(HEADS.pattern[0], HEADS.pattern[1]);
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
    document.querySelectorAll("#setVoiceSeg button").forEach(function (b) {
      b.classList.toggle("active", (b.dataset.voice || "neural") === (s.voice === "system" ? "system" : "neural"));
    });
    if ($("setSfx")) $("setSfx").classList.toggle("on", s.sfx !== false);
    fillVoiceStatus();
    if (Bridge && Bridge.setEnglishVoice) {
      try { Bridge.setEnglishVoice(s.voice === "system" ? "system" : "neural"); } catch (e) {}
    }
    if (Bridge && Bridge.setSystemBars) {
      try { Bridge.setSystemBars(s.theme === "dark"); } catch (e) {}
    }
    saveSettings();
    try {
      if (Reader.item) requestAnimationFrame(function () { Reader.placeBar(); });
    } catch (e) {}
  }

  function fmtSpeed(v) {
    const n = Number(v) || 1;
    return (n === 1 ? "1.0" : String(n)) + "x";
  }

  /* 英文音色：内置离线神经音色（Sherpa-ONNX Supertonic）的加载状态
     模型加载在原生层后台做，加载中/失败都会自动用系统英文语音顶上，
     所以这里只需要把状态如实显示出来。 */
  let neuralVoiceState = "idle";
  let neuralVoiceChecked = null;

  function hasNeuralVoice() {
    if (neuralVoiceChecked !== null) return neuralVoiceChecked;
    neuralVoiceChecked = false;
    if (Bridge && Bridge.hasNeuralVoice) {
      try { neuralVoiceChecked = !!Bridge.hasNeuralVoice(); } catch (e) { neuralVoiceChecked = false; }
    }
    return neuralVoiceChecked;
  }

  function fillVoiceStatus() {
    const el = $("voiceStatus");
    if (!el) return;
    const s = State.settings;
    if (s.voice === "system") {
      el.textContent = "用手机自带的英文语音；中文解释仍然用系统中文语音，断网可用。";
      return;
    }
    if (!hasNeuralVoice()) {
      el.textContent = "这台手机用不了内置神经音色（安装包或机型不支持），会自动用系统英文语音，朗读不受影响。";
      return;
    }
    if (neuralVoiceState === "ready") {
      el.textContent = "内置离线神经音色已就绪 · 44.1kHz · 不联网、不上报";
    } else if (neuralVoiceState === "failed") {
      el.textContent = "内置神经音色加载失败，已自动回退系统英文语音（功能不受影响）";
    } else {
      el.textContent = "内置离线神经音色正在加载…（这几句先用系统语音，就绪后自动换成神经音色）";
    }
  }

  function previewVoice() {
    TTS.stop();
    if (State.settings.voice !== "system" && neuralVoiceState !== "ready") {
      toast(neuralVoiceState === "failed"
        ? "神经音色加载失败，现在听到的是系统语音"
        : "神经音色还在加载，这一句先用系统语音，稍后再试");
    }
    TTS.speak("Hello! This is the little fox. Let us read a story together.", {
      rate: Number(State.settings.speed) || 1.0
    });
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
    document.querySelectorAll("#setVoiceSeg button").forEach(function (b) {
      b.classList.toggle("active", (b.dataset.voice || "neural") === (s.voice === "system" ? "system" : "neural"));
    });
    document.querySelectorAll("#setLangSeg button").forEach(function (b) {
      b.classList.toggle("active", b.dataset.asrLang === Ear.langMode);
    });
    if ($("asrStatus")) {
      $("asrStatus").textContent = Ear.asrReady ? "已就绪 · 中英混说" : "正在准备…";
    }
    $("setBilingual").classList.toggle("on", !!s.bilingual);
    $("setAutoPlay").classList.toggle("on", !!s.autoPlay);
    if ($("setSfx")) $("setSfx").classList.toggle("on", s.sfx !== false);

    const ai = State.ai || {};
    $("aiProvider").value = ai.provider || "zhipu";
    $("aiEndpoint").value = ai.endpoint || AI_PRESETS[ai.provider || "zhipu"].endpoint;
    $("aiModel").value = ai.model || AI_PRESETS[ai.provider || "zhipu"].model;
    $("aiKey").value = ai.key || "";
    $("aiStatus").textContent = AI.configured()
      ? "已配置：" + (AI_PRESETS[(State.ai || {}).provider] || { name: "自定义" }).name + " · " + State.ai.model
      : "未配置。下方内置功能全部无需联网。";
    if (typeof syncAllSegs === "function") {
      requestAnimationFrame(function () { syncAllSegs(); });
    }
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
    Streak.render(false);
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
        saveRead();
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
      Streak.mark();
      show("reader", item.titleZh || item.title, item.title);
      resetActive();
      renderLibrary();
    },

    renderSentences: function (item) {
      const wrap = $("sentences");
      wrap.innerHTML = '<span class="focus-bar" aria-hidden="true"></span>' +
        (item.sentences || []).map(function (s, i) {
          const zh = (item.zh && item.zh[i]) ? item.zh[i] : "";
          const note = (item.notes && item.notes[i]) ? item.notes[i] : "";
          return '<div class="sent" data-idx="' + i + '">' +
            '<div class="en"><span class="index">' + (i + 1) + "</span>" + renderEn(s) + "</div>" +
            (State.settings.bilingual && zh ? '<div class="zh">' + esc(zh) + "</div>" : "") +
            (State.settings.notes && note ? '<div class="note">' + esc(note) + "</div>" : "") +
          "</div>";
        }).join("");
      if (this.playing) this.focusOn();
    },

    rerender: function () {
      if (!this.item) return;
      const keep = this.idx;
      this.renderSentences(this.item);
      this.setActive(keep || 0);
    },

    close: function () {
      TTS.stop();
      this.playing = false;
      this.ui(false);
      this.clearFocus();
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
      this.placeBar();
    },

    /** 当前朗读句的聚焦竖条：跟着句子平滑移动，句子多长竖条就多高 */
    placeBar: function () {
      const wrap = $("sentences");
      if (!wrap) return;
      const bar = wrap.querySelector(".focus-bar");
      const node = wrap.querySelector(".sent.active");
      if (!bar || !node) return;
      // 用实际渲染矩形算，字体档位变化、换行多行时都能对准
      const wr = wrap.getBoundingClientRect();
      const nr = node.getBoundingClientRect();
      const top = nr.height ? (nr.top - wr.top) : node.offsetTop;
      const h = nr.height ? nr.height : node.offsetHeight;
      bar.style.height = Math.max(10, h - 14) + "px";
      bar.style.transform = "translateY(" + (top + 7) + "px)";
    },

    focusOn: function () {
      const wrap = $("sentences");
      if (!wrap) return;
      wrap.classList.add("is-focus");
      this.placeBar();
    },

    clearFocus: function () {
      const wrap = $("sentences");
      if (wrap) wrap.classList.remove("is-focus");
    },

    /** 朗读/暂停按钮的图标与文字同步（三角 ↔ 双竖条） */
    ui: function (playing) {
      const btn = $("btnPlayAll");
      if (!btn) return;
      btn.classList.toggle("is-playing", !!playing);
      btn.setAttribute("aria-pressed", playing ? "true" : "false");
      btn.setAttribute("aria-label", playing ? "暂停朗读" : "朗读全篇");
      const label = btn.querySelector(".pb-label");
      if (label) label.textContent = playing ? "暂停" : "朗读全篇";
      else btn.textContent = playing ? "⏸ 暂停" : "▶ 朗读全篇";
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
        this.ui(false);
        this.clearFocus();
        return;
      }
      this.idx = idx;
      this.playing = true;
      this.ui(true);
      this.setActive(idx);
      this.focusOn();
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
      this.focusOn();
      const self = this;
      const text = plainSentence(this.item.sentences[idx]);
      TTS.speak(text, {
        onEnd: function () {
          if (State.settings.loop) self.speakOne(idx);
          else setTimeout(function () { if (!self.playing) self.clearFocus(); }, 520);
        },
        onError: function () {
          if (!State.settings.loop) setTimeout(function () { if (!self.playing) self.clearFocus(); }, 300);
        }
      });
    },

    stop: function () {
      this.playing = false;
      TTS.stop();
      this.ui(false);
      this.clearFocus();
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
      mastered: false,
      reps: 0,
      intervalDays: 0,
      dueAt: 0,
      lapses: 0,
      lastAt: 0
    });
    saveVocab();
    renderLibrary();
    toast("已加入生词本：" + w);
    Streak.mark();
  }

  function renderVocab() {
    const list = $("vocabList");
    const wrap = $("flashWrap");
    const dueBox = $("vocabDue");
    if (!State.vocab.length) {
      wrap.classList.add("hidden");
      list.innerHTML = '<div class="empty">生词本还是空的。<br>读书时点一下不认识的单词，就收进来了。</div>';
      $("vocabCount").textContent = "0";
      $("vocabMastered").textContent = "";
      if (dueBox) { dueBox.textContent = ""; dueBox.classList.add("hidden"); }
      return;
    }
    State.vocab.forEach(function (v) { SRS.upgrade(v); });
    const mastered = State.vocab.filter(function (v) { return v.mastered; }).length;
    $("vocabCount").textContent = String(State.vocab.length);
    $("vocabMastered").textContent = "（已掌握 " + mastered + "）";
    if (dueBox) {
      const due = SRS.dueCount();
      dueBox.textContent = due > 0 ? "今天到期 " + due + " 个" : "今天的复习都做完了";
      dueBox.classList.remove("hidden");
      dueBox.classList.toggle("hot", due > 0);
    }

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
          (v.mastered ? "" : '<div class="v-due' + (SRS.isDue(v) ? " hot" : "") + '">' + esc(SRS.dueText(v)) + "</div>") +
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
    suppressClick: false,
    swiping: false,
    bound: false,

    open: function () {
      const pool = State.vocab.filter(function (v) { return !v.mastered; });
      pool.forEach(function (v) { SRS.upgrade(v); });
      // 到期的最先复习，然后是没复习过的，最后是还没到期的
      this.list = SRS.queue(pool);
      if (!this.list.length) { toast("还没有要复习的生词"); return; }
      this.i = 0;
      this.flipped = false;
      $("vocabList").classList.add("hidden");
      $("flashWrap").classList.remove("hidden");
      this.bindSwipe();
      this.render();
      Streak.mark();
    },

    close: function () {
      $("flashWrap").classList.add("hidden");
      $("vocabList").classList.remove("hidden");
      renderVocab();
    },

    render: function () {
      const v = this.list[this.i];
      if (!v) { this.close(); return; }
      this.resetCard();
      $("flashWord").textContent = v.w;
      $("flashIpa").textContent = v.ipa || "";
      $("flashFront").classList.toggle("hidden", this.flipped);
      $("flashBack").classList.toggle("hidden", !this.flipped);
      $("flashPos").textContent = v.pos || "";
      $("flashZh").textContent = v.zh || "";
      $("flashEx").innerHTML = v.ex ? esc(v.ex) + (v.exZh ? '<div class="ex-zh">' + esc(v.exZh) + "</div>" : "") : "";
      if ($("flashMeta")) {
        $("flashMeta").textContent = "第 " + (v.reps || 0) + " 次复习 · " + SRS.dueText(v);
        $("flashMeta").classList.toggle("hot", SRS.isDue(v));
      }
    },

    resetCard: function () {
      const card = $("flashCard");
      if (!card) return;
      card.classList.remove("dragging", "swipe-out");
      card.style.transform = "";
      card.style.opacity = "";
      card.querySelectorAll(".fc-stamp").forEach(function (s) { s.classList.remove("on"); });
    },

    /** 左滑：再记一下（半个多小时后再来）；右滑：已掌握。动作与下面按钮完全一致。 */
    slide: function (dir) {
      const card = $("flashCard");
      if (!card || this.swiping) return;
      this.swiping = true;
      card.classList.add("swipe-out");
      card.style.transform = "translate(" + (dir * (card.offsetWidth + 120)) + "px,-14px) rotate(" + (dir * 16) + "deg)";
      card.style.opacity = "0";
      const self = this;
      setTimeout(function () {
        self.swiping = false;
        self.resetCard();
        if (dir > 0) self.master();
        else self.again();
      }, 240);
    },

    bindSwipe: function () {
      if (this.bound) return;
      const card = $("flashCard");
      if (!card) return;
      this.bound = true;
      const yes = card.querySelector(".fc-yes");
      const no = card.querySelector(".fc-no");
      const stamps = function (x) {
        if (yes) yes.classList.toggle("on", x > 18);
        if (no) no.classList.toggle("on", x < -18);
      };
      let active = false, moved = false, sx = 0, sy = 0, dx = 0, dy = 0;
      let lastX = 0, lastT = 0, vx = 0;

      card.addEventListener("pointerdown", function (e) {
        if (e.button !== 0 || Flash.swiping) return;
        active = true;
        moved = false;
        sx = lastX = e.clientX;
        sy = e.clientY;
        dx = dy = vx = 0;
        lastT = e.timeStamp;
        card.classList.add("dragging");
        try { card.setPointerCapture(e.pointerId); } catch (err) {}
      });

      card.addEventListener("pointermove", function (e) {
        if (!active) return;
        dx = e.clientX - sx;
        dy = e.clientY - sy;
        if (!moved && Math.abs(dx) > 7 && Math.abs(dx) > Math.abs(dy)) moved = true;
        if (!moved) return;
        vx = (e.clientX - lastX) / Math.max(1, e.timeStamp - lastT);
        lastX = e.clientX;
        lastT = e.timeStamp;
        card.style.transform = "translate(" + dx + "px," + (dy * 0.18).toFixed(1) + "px) rotate(" + (dx * 0.055).toFixed(2) + "deg)";
        stamps(dx);
      });

      const end = function () {
        if (!active) return;
        active = false;
        card.classList.remove("dragging");
        if (!moved) { stamps(0); return; }
        Flash.suppressClick = true;
        setTimeout(function () { Flash.suppressClick = false; }, 420);
        if (Math.abs(dx) > 90 || Math.abs(vx) > 0.6) {
          Flash.slide(dx > 0 || (dx === 0 && vx > 0) ? 1 : -1);
        } else {
          card.style.transform = "";
          stamps(0);
        }
      };
      card.addEventListener("pointerup", end);
      card.addEventListener("pointercancel", end);
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

    /** 再记一下：半小时后再来，卡片留在队列里 */
    again: function () {
      const v = this.list[this.i];
      if (!v) return;
      SRS.review(v, false);
      saveVocab();
      toast("好，半小时后再遇到它");
      this.next();
      renderVocab();
    },

    /** 记住了：下次复习时间往后拉长（1 → 3 → 7 …天） */
    know: function () {
      const v = this.list[this.i];
      if (!v) return;
      SRS.review(v, true);
      saveVocab();
      toast("记住了，" + SRS.dueText(v));
      this.next();
      renderVocab();
    },

    master: function () {
      const v = this.list[this.i];
      if (!v) return;
      const target = State.vocab.filter(function (x) { return x.w === v.w; })[0];
      if (target) SRS.master(target);
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
      renderVocab();
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
      this.aiContext = (contextTitle ? "当前阅读材料：" + contextTitle + "\n" + contextText + "\n\n" : "") + AI.wordsHint();
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

    /** 「🎙️ 问外教这篇」：带着标题、正文开头和当前选中句开聊。
     *  配了接口就用 BYOK 外教（上下文里带文章），没配就走离线模板，一样能答疑/考词/讨论。 */
    openReading: function (item, idx) {
      if (!item) return;
      this.mode = "reading";
      preloadAsr();
      this.token++;
      this.interruptedText = "";
      Sf.hide();
      this.scenario = null;
      this.step = 0;
      this.finished = false;
      this.msgs = [];
      this.aiHistory = [];
      this.readerItem = item;
      this.readerIdx = Math.max(0, parseInt(idx, 10) || 0);
      const sentences = item.sentences || [];
      const sel = plainSentence(sentences[this.readerIdx] || "");
      const selZh = (item.zh && item.zh[this.readerIdx]) ? item.zh[this.readerIdx] : "";
      const summary = sentences.slice(0, 4).map(plainSentence).join(" ").slice(0, 600);
      this.readerSel = sel;
      this.readerSelZh = selZh;
      this.aiContext = "当前阅读材料：《" + (item.titleZh || item.title) + "》（" + item.title + "）\n" +
        "正文开头：" + summary + "\n" +
        "学生当前选中第 " + (this.readerIdx + 1) + " 句：“" + sel + "”" +
        (selZh ? "（中文：" + selZh + "）" : "") + "\n" +
        "请围绕这篇材料答疑、考词或讨论内容；学生用中文提问就用简体中文解释。" +
        AI.wordsHint();
      this.fromReader = true;
      $("chatTools").classList.remove("hidden");
      $("btnHint").classList.remove("hidden");
      $("btnRestart").classList.remove("hidden");
      $("chatText").placeholder = "问这句什么意思，或让外教考你单词、聊聊文章";
      $("btnZhChat").textContent = this.zh ? "中文 ✓" : "译 中文";
      $("btnZhChat").classList.toggle("on", this.zh);
      show("chat", "和外教聊这篇", (item.titleZh || item.title) + " · 第 " + (this.readerIdx + 1) + " 句");
      $("chatStream").innerHTML = "";
      $("chatHintLine").textContent = AI.configured()
        ? "已带着标题、正文开头和选中句开聊 · 直接问就行"
        : "离线外教：这句什么意思 / 考我单词 / 总结这篇，都能答";
      Live.render();

      const greeting = "Let's talk about this article. Ask me anything about it — or say quiz me.";
      this.addPartner(greeting, "我们聊聊这篇。可以问“这句什么意思”、让我考你单词，或者说 “quiz me”。");
      const self = this;
      this.speakAs(greeting, function () {
        if (Ear.on) Ear.relax();
        else Stage.listen();
      });
    },

    /** 离线也能用的文章答疑（没配置接口时） */
    readingTurn: function (msg) {
      const item = this.readerItem;
      if (!item) return false;
      const m = String(msg || "").replace(/\s+/g, " ");
      const sel = this.readerSel || "";
      const selZh = this.readerSelZh || "";
      const wantAdd = /生词本|收藏|记下|加进/.test(m);
      const wantRead = /读一遍|怎么读|再读|发音|朗读|听一遍|慢一点/.test(m);
      const wantMean = /什么意思|啥意思|翻译|不懂|不明白|解释|意思/.test(m);
      const wantQuiz = /考我|考考|提问|问我|测试|quiz|出题/i.test(m);
      const wantSum = /总结|讲了什么|大意|概括|主要内容|summary/i.test(m);
      const wantWord = /生词|单词|词汇|关键词|word/i.test(m);
      const self = this;
      const after = function () { if (Ear.on) Ear.relax(); else Stage.listen(); };

      this.addMe(msg);
      $("chatText").value = "";
      Sf.hide();
      Streak.mark();

      if (wantAdd) {
        const words = this.keyWords(sel);
        let added = 0;
        words.forEach(function (wd) {
          if (!isSaved(wd) && dictLookup(wd) && added < 5) {
            addWord(wd, dictLookup(wd));
            added++;
          }
        });
        this.sys(added ? "📒 已把这句里的 " + added + " 个词收进生词本，复习卡片里会排队出现。" : "这句里的词已经在生词本里了，点一下词就能再看释义。", null);
        return true;
      }
      if (wantMean) {
        this.sys("📖 这一句：「" + esc(sel) + "」" + (selZh ? "<br>中文：" + esc(selZh) : "<br>点句子里的单词可以看释义。"), null);
        this.speakAs(sel, after);
        return true;
      }
      if (wantRead) {
        this.sys("🔊 好，这一句我再读一遍：", sel);
        this.speakAs(sel, after);
        return true;
      }
      if (wantQuiz) {
        const q = (item.qa && item.qa.length) ? item.qa[0] : null;
        const qText = q ? q.q : "Quick check: can you say the main idea of this sentence in your own words?";
        this.sys("🧠 考考你：" + esc(qText) + (q && q.qZh ? "<br><span class=\"tiny\">" + esc(q.qZh) + "</span>" : ""), null);
        this.speakAs(qText, after);
        return true;
      }
      if (wantSum) {
        const zhAll = (item.zh || []).filter(Boolean).slice(0, 3).join("");
        this.sys("📝 《" + esc(item.titleZh || item.title) + "》" + (zhAll ? "大意是：" + esc(zhAll) : "讲的是：" + esc(sel)), null);
        this.speakAs("In short, this article is about " + (item.title || "this topic") + ". What do you think about it?", after);
        return true;
      }
      if (wantWord) {
        const words = this.keyWords(sel);
        if (!words.length) {
          this.sys("这句里没有特别难的词。想背单词的话，可以读书时点一下不认识的词，就收进生词本了。", null);
          return true;
        }
        this.sys("🔍 这句里的关键词（点一下就查、可以收进生词本）：<br>" + words.map(function (wd) {
          const e = dictLookup(wd);
          return '<span class="w" data-w="' + attr(wd) + '">' + esc(wd) + "</span>" +
            (e && e.z ? ' <span class="tiny">' + esc(e.z.split(/[；;]/)[0]) + "</span>" : "");
        }).join(" · "), null);
        return true;
      }

      // 其它：先接住，再追问一句；有把握的地方给 Try saying
      const ack = pickAck();
      const reply = ack + " Can you tell me in English what this sentence is about?";
      const bubble = this.addPartner(reply, "说得好。再用英文说说这句在讲什么？也可以问“这句什么意思”。");
      const tryText = hasChinese(msg) ? "" : gentleTry(msg);
      if (tryText) this.tryLine(bubble, tryText);
      this.speakAs(reply, after);
      return true;
    },

    /** 取一句话里最值得学的词（词典里有、长度大于 2、去掉重复） */
    keyWords: function (text) {
      const seen = {};
      const out = [];
      String(text || "").replace(/[A-Za-z]+(?:['’][A-Za-z]+)*/g, function (m) {
        const w = m.toLowerCase();
        if (w.length > 2 && !seen[w] && !STOP_WORDS[w] && dictLookup(w)) {
          seen[w] = 1;
          out.push(w);
        }
        return m;
      });
      return out.slice(0, 8);
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
      div.innerHTML = '<div class="b-en">' + wordify(en) + "</div>" +
        (zh ? '<div class="b-zh' + (this.zh ? "" : " hidden") + '">' + esc(zh) + "</div>" : "") +
        '<div class="b-actions">' +
          '<button class="b-act" data-act="speak-text" data-text="' + attr(en) + '">🔊 再听</button>' +
          (zh ? '<button class="b-act" data-act="bubble-zh">译 中文</button>' : "") +
        "</div>";
      stream.appendChild(div);
      stream.scrollTop = stream.scrollHeight;
      return div;
    },

    /** 气泡下方的柔和纠错条：只展示与朗读，不打断对话 */
    tryLine: function (bubble, text) {
      if (!bubble || !text) {
        return;
      }
      const old = bubble.querySelector(".try-line");
      if (old && old.parentNode) old.parentNode.removeChild(old);
      const bar = document.createElement("div");
      bar.className = "try-line";
      bar.innerHTML = '<span class="try-ico" aria-hidden="true">💡</span>' +
        '<span class="try-body"><b>Try saying</b><span class="try-text"></span></span>' +
        '<button class="b-act try-speak" data-act="speak-text" aria-label="听这句更自然的说法">🔊</button>';
      bar.querySelector(".try-text").textContent = text;
      bar.querySelector(".try-speak").setAttribute("data-text", text);
      bubble.appendChild(bar);
      const stream = $("chatStream");
      if (stream) stream.scrollTop = stream.scrollHeight;
    },

    /** 首包到达前的“正在思考…”微光占位条 */
    addThinking: function () {
      const stream = $("chatStream");
      const div = document.createElement("div");
      div.className = "bubble partner think-bubble";
      div.innerHTML = '<span class="think-spark" aria-hidden="true">' +
          '<svg viewBox="0 0 24 24"><path d="M12 1.6c.8 5.3 5.1 9.6 10.4 10.4-5.3.8-9.6 5.1-10.4 10.4C11.2 17.1 6.9 12.8 1.6 12 6.9 11.2 11.2 6.9 12 1.6Z"/></svg></span>' +
        '<span class="think-text">正在思考…</span>';
      stream.appendChild(div);
      stream.scrollTop = stream.scrollHeight;
      return div;
    },

    addMe: function (text) {
      const stream = $("chatStream");
      const div = document.createElement("div");
      div.className = "bubble me";
      div.innerHTML = '<div class="b-tag">我</div><div class="b-en">' + wordify(text) + "</div>";
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
      if (currentView === "chat" && (this.scenario || this.mode === "ai" || this.mode === "reading")) {
        if (this.mode === "ai" || this.mode === "reading") {
          if (!this.aiHistory.length && this.mode === "ai") {
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
      if (this.mode === "reading") {
        const box = document.createElement("div");
        box.className = "hints";
        box.innerHTML = ["这句什么意思", "考我单词", "总结这篇", "用英文问我一个问题"].map(function (c) {
          return '<button class="hint-chip" data-act="use-chip" data-text="' + attr(c) + '">' + esc(c) + "</button>";
        }).join("");
        $("chatStream").appendChild(box);
        $("chatStream").scrollTop = $("chatStream").scrollHeight;
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
      if (this.mode === "reading" && this.readerItem) {
        this.openReading(this.readerItem, this.readerIdx);
        return;
      }
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
      saveDone();
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
      Streak.mark();

      if (this.mode === "ai") {
        this.sendAI(msg, lang, interrupted);
        return;
      }

      // 「问外教这篇」：配了接口就走 BYOK（上下文带文章），没配就用离线模板
      if (this.mode === "reading") {
        if (AI.configured()) this.sendAI(msg, lang, interrupted);
        else this.readingTurn(msg);
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
      if (bubble) bubble.classList.add("is-draft");
      const thinkEl = this.addThinking();
      let revealed = false;
      const removeThink = function () {
        if (thinkEl && thinkEl.parentNode) thinkEl.parentNode.removeChild(thinkEl);
      };
      const reveal = function () {
        if (revealed) return;
        revealed = true;
        if (thinkEl && thinkEl.parentNode) {
          thinkEl.classList.add("out");
          setTimeout(function () { if (thinkEl.parentNode) thinkEl.parentNode.removeChild(thinkEl); }, 240);
        }
        if (bubble) {
          bubble.classList.remove("is-draft");
          bubble.classList.add("enter");
        }
      };
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
        const tipIdx = fullText.search(/\n\s*[\[【]?\s*(TIP|Tip|tip|TRY|Try|try|提示)\s*[:：]/);
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
          reveal();
          const parsed = parseAIReply(fullText);
          if (enEl) enEl.innerHTML = wordify(parsed.en || "…");
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
            removeThink();
            if (bubble && bubble.parentNode) bubble.parentNode.removeChild(bubble);
            self.sys("请求未返回内容，请稍后再试。", null);
            if (Ear.on) Ear.relax();
            return;
          }
          reveal();
          $("chatHintLine").textContent = "提示：回复会自动朗读；用中文问语法和意思也可以。";
          const parsed = parseAIReply(reply);
          if (enEl) enEl.innerHTML = wordify(parsed.en);
          if (btnEl) btnEl.setAttribute("data-text", parsed.en);
          if (parsed.tryText && bubble) self.tryLine(bubble, parsed.tryText);
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
          removeThink();
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
    const raw = String(text || "").trim();
    let tip = "";
    const tries = [];
    const lines = raw.split(/\n+/);
    const kept = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const mTip = l.match(/^\s*(TIP|Tip|tip|提示)\s*[:：]\s*([\s\S]*)$/);
      const mTry = l.match(/^\s*[\[【]?\s*(TRY|Try|try)\s*[:：]\s*([\s\S]*?)\s*[\]】]?\s*$/);
      if (mTip) {
        tip = mTip[2];
      } else if (mTry) {
        if (mTry[2]) tries.push(mTry[2]);
      } else {
        kept.push(l);
      }
    }
    const en = kept.join("\n").trim();
    return { en: en, tip: tip, tryText: tries[0] || "" };
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
        "5) 如果对方有明显的语法或用词错误，先自然接住对方的意思，然后在最后单独一行以“TIP: ”开头，用简体中文指出一个最主要的改进点。" +
        "6) 如果对方的表达语法没错但不够地道，可以在最后单独一行以“[TRY: 更自然的英文说法]”的形式给一个更地道的英文句子（一行一个，最多一个）；正文里不要提这件事，也不要打断聊天节奏。没有可改进的就不加这一行。" +
        "7) 如果提示里给了学生正在学的生词，请在对话里自然地用上 1-2 个，不要罗列或解释。" +
        "8) 内容健康、适合青少年；不要索要真实姓名、住址、学校等隐私信息。";
    },

    /** 把到期/未掌握的生词带进开场上下文，让外教自然复现（最多 3 个） */
    wordsHint: function () {
      const list = SRS.forChat(3);
      if (!list.length) return "";
      return "\n\n学生本机生词本里这几个词还没掌握，请在对话里自然地用上 1-2 个（不要罗列、不要说你在复习）：" +
        list.map(function (v) {
          const zh = String(v.zh || "").replace(/（[^）]*）/g, "").slice(0, 16);
          return v.w + (zh ? "（" + zh + "）" : "");
        }).join("、") + "。";
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
    saveCustomData();
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

  /* ========================= 句型闯关 =========================
     玩法：看中文提示 → 听发音 → 把打散的词块按语序拼回去（或写听写）。
     · 全部离线：句库在 challenge.js，提示音用 Web Audio 现场合成，没有音频文件
     · 进度 / 正确率 / 连对 / 循环与盲听偏好都按学习档案存本机
     · 句库与代码 100% 原创，只借鉴“整句主动回忆”的产品思路，不抄任何源码或数据 */

  const Sfx = {
    ctx: null,

    /** 静音：设置里关掉，或手机媒体音量为 0（由原生桥告知） */
    muted: function () {
      if (State.settings.sfx === false) return true;
      if (Bridge && Bridge.isMediaMuted) {
        try { if (Bridge.isMediaMuted()) return true; } catch (e) {}
      }
      return false;
    },

    context: function () {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!this.ctx) {
        try { this.ctx = new AC(); } catch (e) { this.ctx = null; }
      }
      return this.ctx;
    },

    note: function (freq, delay, dur, vol, type) {
      const ctx = this.context();
      if (!ctx) return;
      try {
        if (ctx.state === "suspended" && ctx.resume) ctx.resume();
        const t0 = ctx.currentTime + delay;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type || "sine";
        osc.frequency.setValueAtTime(freq, t0);
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(vol || 0.09, t0 + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + dur + 0.03);
      } catch (e) {}
    },

    /** 拼对：三个上行音，轻快但不刺耳 */
    correct: function () {
      if (this.muted()) return;
      this.note(523.25, 0, 0.2, 0.08);
      this.note(659.25, 0.075, 0.2, 0.08);
      this.note(783.99, 0.15, 0.28, 0.075);
    },

    /** 还差一点：两个下行低音 */
    soft: function () {
      if (this.muted()) return;
      this.note(329.63, 0, 0.16, 0.055, "triangle");
      this.note(261.63, 0.12, 0.22, 0.05, "triangle");
    },

    /** 本关完成：四个音的小旋律 */
    level: function () {
      if (this.muted()) return;
      const notes = [523.25, 659.25, 783.99, 1046.5];
      for (let i = 0; i < notes.length; i++) this.note(notes[i], i * 0.1, 0.26, 0.075);
    }
  };

  const Pattern = {
    KEY: "patterns",
    levelId: "",
    level: null,
    items: [],
    idx: 0,
    mode: "build",
    loop: false,
    blind: false,
    answer: [],
    pool: [],
    tokens: [],
    item: null,
    solved: false,
    inPlay: false,
    isDone: false,
    active: false,
    data: null,
    uid: 0,
    hintUid: 0,
    loopTimer: null,
    autoTimer: null,
    checkTimer: null,
    loopGap: 700,
    nextGap: 4500,
    continueId: "",

    blank: function () {
      return {
        levels: {},
        stats: { attempts: 0, correct: 0, streak: 0, best: 0 },
        last: "",
        mode: "build",
        loop: false,
        blind: false
      };
    },

    load: function () {
      const raw = ProfileStore.data(this.KEY, null);
      const d = this.blank();
      if (raw && typeof raw === "object") {
        if (raw.levels && typeof raw.levels === "object") d.levels = raw.levels;
        if (raw.stats && typeof raw.stats === "object") {
          d.stats.attempts = Number(raw.stats.attempts) || 0;
          d.stats.correct = Number(raw.stats.correct) || 0;
          d.stats.streak = Number(raw.stats.streak) || 0;
          d.stats.best = Number(raw.stats.best) || 0;
        }
        if (typeof raw.last === "string") d.last = raw.last;
        d.mode = raw.mode === "dictate" ? "dictate" : "build";
        d.loop = !!raw.loop;
        d.blind = !!raw.blind;
      }
      Object.keys(d.levels).forEach(function (k) {
        const l = d.levels[k];
        if (!l || typeof l !== "object") { delete d.levels[k]; return; }
        if (!Array.isArray(l.done)) l.done = [];
        l.done = l.done.filter(function (n) { return typeof n === "number" && n >= 0; });
        l.idx = (typeof l.idx === "number" && l.idx >= 0) ? Math.floor(l.idx) : 0;
        l.attempts = Number(l.attempts) || 0;
        l.correct = Number(l.correct) || 0;
      });
      this.data = d;
      return d;
    },

    save: function () {
      if (this.data) ProfileStore.save(this.KEY, this.data);
    },

    lev: function (id) {
      if (!this.data) this.load();
      if (!this.data.levels[id]) {
        this.data.levels[id] = { done: [], idx: 0, attempts: 0, correct: 0 };
      }
      return this.data.levels[id];
    },

    findLevel: function (id) {
      for (let i = 0; i < CHALLENGE_LEVELS.length; i++) {
        if (CHALLENGE_LEVELS[i].id === id) return CHALLENGE_LEVELS[i];
      }
      return null;
    },

    isLevelComplete: function (id) {
      const lv = this.findLevel(id);
      if (!lv) return false;
      return this.lev(id).done.length >= lv.sentences.length;
    },

    isLocked: function (id) {
      for (let i = 1; i < CHALLENGE_LEVELS.length; i++) {
        if (CHALLENGE_LEVELS[i].id === id) return !this.isLevelComplete(CHALLENGE_LEVELS[i - 1].id);
      }
      return false;
    },

    accuracy: function () {
      const d = this.data || this.load();
      return d.stats.attempts ? Math.round(d.stats.correct * 100 / d.stats.attempts) : 0;
    },

    /* ---------------- 首页 ---------------- */

    open: function () {
      this.active = true;
      this.load();
      if (this.inPlay && this.level) {
        $("pzHome").classList.add("hidden");
        $("pzPlay").classList.remove("hidden");
        $("pzDone").classList.toggle("hidden", !this.isDone);
        $("pzCard").classList.toggle("hidden", !!this.isDone);
        return;
      }
      this.inPlay = false;
      $("pzHome").classList.remove("hidden");
      $("pzPlay").classList.add("hidden");
      this.renderHome();
    },

    renderHome: function () {
      const self = this;
      const d = this.load();
      const acc = this.accuracy();
      $("pzStats").innerHTML =
        '<span class="pz-stat">🔥 当前连对 <b>' + d.stats.streak + '</b></span>' +
        '<span class="pz-stat">正确率 <b>' + acc + '%</b></span>' +
        '<span class="pz-stat">最长连对 <b>' + d.stats.best + '</b></span>';

      let nextId = "";
      const cards = CHALLENGE_LEVELS.map(function (lv) {
        const rec = self.lev(lv.id);
        const total = lv.sentences.length;
        const done = Math.min(rec.done.length, total);
        const locked = self.isLocked(lv.id);
        const complete = done >= total;
        if (!locked && !complete && !nextId) nextId = lv.id;
        return '<button class="pz-level' + (locked ? " is-locked" : " is-open") + '" data-pz="level" data-id="' + attr(lv.id) + '"' +
          (locked ? ' aria-disabled="true"' : '') + '>' +
          '<span class="pz-level-emoji" aria-hidden="true">' + lv.emoji + '</span>' +
          '<span class="pz-level-main">' +
            '<span class="pz-level-name">' + esc(lv.name) + '</span>' +
            '<span class="pz-level-sub">' + esc(lv.sub) + ' · 共 ' + total + ' 句</span>' +
            '<span class="pz-level-prog"><i style="width:' + Math.round(done * 100 / total) + '%"></i></span>' +
          '</span>' +
          '<span class="pz-level-side">' +
            (locked
              ? '🔒<b>先完成上一关</b>'
              : (complete
                ? '<b class="pz-level-done">✓ 已完成</b>' + done + "/" + total
                : '<b>' + done + "/" + total + '</b>' + (rec.idx > 0 ? "进行中" : "未开始"))) +
          '</span>' +
        '</button>';
      });
      $("pzLevels").innerHTML = cards.join("");

      if (nextId) {
        this.continueId = nextId;
      } else {
        const last = this.findLevel(d.last);
        this.continueId = last ? last.id : CHALLENGE_LEVELS[0].id;
      }
      $("btnPzContinue").textContent = nextId ? "▶ 接着闯" : "▶ 再练一遍";
    },

    /* ---------------- 进入关卡 ---------------- */

    startLevel: function (id) {
      const lv = this.findLevel(id);
      if (!lv) return;
      if (this.isLocked(id)) { toast("先完成上一关，再闯这一关"); return; }
      this.levelId = id;
      this.level = { id: id, name: lv.name, emoji: lv.emoji, sub: lv.sub, isArticle: false };
      this.items = lv.sentences.map(function (s) {
        return { en: s.en, zh: s.zh, hint: s.hint, tag: s.tag };
      });
      const rec = this.lev(id);
      this.idx = (rec.idx >= 0 && rec.idx < this.items.length) ? rec.idx : 0;
      this.inPlay = true;
      this.isDone = false;
      this.enter();
    },

    startFromArticle: function (item) {
      const sents = PatternCore.pickFromArticle(item, 12);
      if (sents.length < 3) {
        toast("这篇文章里适合拼句的句子不到 3 句，换一篇试试");
        return;
      }
      this.levelId = "art:" + item.id;
      this.level = {
        id: this.levelId,
        name: "文章闯关",
        emoji: "📖",
        sub: item.titleZh || item.title || "自定义文章",
        isArticle: true
      };
      this.items = sents;
      this.idx = 0;
      this.inPlay = true;
      this.isDone = false;
      this.enter();
      toast("从这篇文章抽出 " + sents.length + " 句来闯关");
    },

    startLastArticle: function () {
      let item = Reader.item;
      for (let i = State.read.length - 1; i >= 0 && !item; i--) item = findItem(State.read[i]);
      if (!item) {
        toast("先去书库读一篇文章，再从里面抽句闯关");
        switchTab("library");
        return;
      }
      this.startFromArticle(item);
    },

    enter: function () {
      this.active = true;
      this.data = this.load();
      this.loop = !!this.data.loop;
      this.blind = !!this.data.blind;
      this.mode = this.data.mode === "dictate" ? "dictate" : "build";
      $("pzHome").classList.add("hidden");
      $("pzPlay").classList.remove("hidden");
      $("pzDone").classList.add("hidden");
      $("pzCard").classList.remove("hidden");
      if (currentView === "pattern") $("btnBack").classList.remove("hidden");
      this.newSentence();
    },

    /* ---------------- 一句一句来 ---------------- */

    newSentence: function () {
      this.cancelTimers();
      if (this.idx >= this.items.length) { this.finish(); return; }
      const self = this;
      this.item = this.items[this.idx];
      this.solved = false;
      this.isDone = false;
      this.answer = [];
      this.hintUid = 0;
      this.tokens = PatternCore.tokenize(this.item.en);
      this.pool = PatternCore.shuffle(this.tokens.map(function (text) {
        self.uid++;
        return { uid: self.uid, text: text };
      }));
      $("pzDone").classList.add("hidden");
      $("pzCard").classList.remove("hidden", "shake");
      $("pzFeedback").classList.add("hidden");
      $("pzFeedback").innerHTML = "";
      $("pzInput").value = "";
      $("pzHintLine").textContent = this.blind
        ? "盲听模式：先听一遍发音，再凭记忆拼出整句。"
        : "拼对以后，点整句里的任意单词可以查词、收进生词本。";
      this.renderTop();
      this.renderPrompt();
      this.renderMode();
      this.renderAnswer();
      if (this.blind || this.loop) this.speak();
    },

    renderTop: function () {
      if (!this.level) return;
      $("pzLevelName").textContent = this.level.emoji + " " + this.level.name;
      $("pzProgress").textContent = "第 " + Math.min(this.idx + 1, this.items.length) + " / " + this.items.length + " 句" +
        (this.level.sub ? " · " + this.level.sub : "");
      $("pzStreak").textContent = "🔥 " + (this.data ? this.data.stats.streak : 0);
      $("pzBar").style.width = Math.round(this.idx * 100 / Math.max(1, this.items.length)) + "%";
    },

    renderPrompt: function () {
      const it = this.item;
      if (!it) return;
      const zh = $("pzZh");
      if (this.blind) {
        zh.textContent = "盲听模式：先听发音，再凭记忆拼出这句话";
        zh.classList.add("is-blind");
      } else {
        zh.textContent = it.zh || "这篇文章没有中文译文，听懂意思后把它拼出来";
        zh.classList.remove("is-blind");
      }
      const loopBtn = $("pzLoopBtn");
      loopBtn.classList.toggle("on", this.loop);
      loopBtn.setAttribute("aria-pressed", this.loop ? "true" : "false");
      const blindBtn = $("pzBlindBtn");
      blindBtn.classList.toggle("on", this.blind);
      blindBtn.setAttribute("aria-pressed", this.blind ? "true" : "false");
      $("pzCount").innerHTML =
        (it.tag ? '<span class="pz-tag">' + esc(it.tag) + '</span>' : "") +
        "<span>" + (this.blind ? "盲听中 · 词数已隐藏" : this.tokens.length + " 个词块") + "</span>";
    },

    renderMode: function () {
      const build = this.mode !== "dictate";
      $("pzBuild").classList.toggle("hidden", !build);
      $("pzDictate").classList.toggle("hidden", build);
      document.querySelectorAll("#pzModeSeg button").forEach(function (b) {
        b.classList.toggle("active", b.dataset.mode === (build ? "build" : "dictate"));
      });
    },

    renderAnswer: function () {
      const self = this;
      const chip = function (c, inAns) {
        return '<button class="pz-chunk' + (inAns ? " in-ans" : "") +
          (self.hintUid === c.uid ? " hint" : "") + '" data-pz="chunk" data-side="' +
          (inAns ? "answer" : "pool") + '" data-uid="' + c.uid + '">' + esc(c.text) + "</button>";
      };
      const ans = $("pzAnswer");
      ans.classList.toggle("has-items", this.answer.length > 0);
      ans.classList.toggle("ok", this.solved);
      ans.innerHTML = this.answer.length
        ? this.answer.map(function (c) { return chip(c, true); }).join("")
        : '<span class="pz-ph">点下面的词块，按顺序拼成一句话</span>';
      $("pzPool").innerHTML = this.pool.map(function (c) { return chip(c, false); }).join("");
    },

    place: function (uid) {
      if (this.solved) return;
      let i = -1;
      for (let k = 0; k < this.pool.length; k++) if (this.pool[k].uid === uid) { i = k; break; }
      if (i < 0) return;
      this.answer.push(this.pool.splice(i, 1)[0]);
      this.hintUid = 0;
      this.hideFeedback();
      this.renderAnswer();
      if (this.answer.length === this.tokens.length) {
        const self = this;
        clearTimeout(this.checkTimer);
        this.checkTimer = setTimeout(function () { self.checkBuild(); }, 180);
      }
    },

    unplace: function (uid) {
      if (this.solved) return;
      let i = -1;
      for (let k = 0; k < this.answer.length; k++) if (this.answer[k].uid === uid) { i = k; break; }
      if (i < 0) return;
      this.pool.push(this.answer.splice(i, 1)[0]);
      this.hintUid = 0;
      clearTimeout(this.checkTimer);
      this.hideFeedback();
      this.renderAnswer();
    },

    clearAnswer: function () {
      if (this.solved) return;
      const self = this;
      this.answer.forEach(function (c) { self.pool.push(c); });
      this.answer = [];
      this.hintUid = 0;
      clearTimeout(this.checkTimer);
      this.hideFeedback();
      this.renderAnswer();
    },

    hideFeedback: function () {
      if (this.solved) return;
      this.cancelAuto();
      $("pzFeedback").classList.add("hidden");
      $("pzFeedback").innerHTML = "";
    },

    hint: function () {
      if (this.solved || !this.item) return;
      if (this.mode === "dictate") { this.dictHint(); return; }
      const next = PatternCore.nextWord(this.answer.map(function (c) { return c.text; }), this.tokens);
      if (!next) { toast("词块已经拼满了，检查一下顺序"); return; }
      const core = PatternCore.core(next);
      this.hintUid = 0;
      for (let i = 0; i < this.pool.length; i++) {
        if (PatternCore.core(this.pool[i].text) === core) { this.hintUid = this.pool[i].uid; break; }
      }
      this.renderAnswer();
      $("pzHintLine").textContent = "下一个词： " + next;
    },

    dictHint: function () {
      if (this.solved || !this.item) return;
      const w = PatternCore.dictationHint($("pzInput").value, this.item.en);
      $("pzHintLine").textContent = w ? "下一个该写的词是：“" + w + "”" : "词都写上了，检查一下拼写和顺序。";
    },

    /* ---------------- 朗读与开关 ---------------- */

    speak: function () {
      if (!this.item) return;
      this.cancelLoop();
      const self = this;
      const btn = $("pzSpeak");
      btn.classList.add("is-playing");
      TTS.speak(this.item.en, {
        onEnd: function () {
          btn.classList.remove("is-playing");
          if (self.loop && self.inPlay) {
            self.loopTimer = setTimeout(function () { self.speak(); }, self.loopGap);
          }
        },
        onError: function () { btn.classList.remove("is-playing"); }
      });
    },

    cancelLoop: function () {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    },

    toggleLoop: function () {
      this.loop = !this.loop;
      if (this.data) { this.data.loop = this.loop; this.save(); }
      this.renderPrompt();
      if (this.loop) this.speak();
      else this.cancelLoop();
      toast(this.loop ? "单句循环已打开，会一直重复这句" : "单句循环已关闭");
    },

    toggleBlind: function () {
      this.blind = !this.blind;
      if (this.data) { this.data.blind = this.blind; this.save(); }
      this.renderPrompt();
      $("pzHintLine").textContent = this.blind
        ? "盲听模式：先听一遍发音，再凭记忆拼出整句。"
        : "拼对以后，点整句里的任意单词可以查词、收进生词本。";
      if (this.blind) this.speak();
      toast(this.blind ? "盲听模式：中文和词数已隐藏" : "已显示中文提示");
    },

    setMode: function (mode) {
      if (this.solved) { toast("这句已经拼对了，下一句再换模式"); return; }
      this.mode = mode === "dictate" ? "dictate" : "build";
      if (this.data) { this.data.mode = this.mode; this.save(); }
      this.renderMode();
      if (this.mode === "dictate") {
        setTimeout(function () { try { $("pzInput").focus(); } catch (e) {} }, 60);
      }
    },

    /* ---------------- 判对错 ---------------- */

    countAttempt: function (ok) {
      const d = this.data || this.load();
      const rec = this.lev(this.levelId);
      d.stats.attempts++;
      rec.attempts++;
      if (ok) {
        d.stats.correct++;
        rec.correct++;
        d.stats.streak++;
        if (d.stats.streak > d.stats.best) d.stats.best = d.stats.streak;
      } else {
        d.stats.streak = 0;
      }
      this.save();
      $("pzStreak").textContent = "🔥 " + d.stats.streak;
    },

    checkBuild: function () {
      if (this.solved || !this.item) return;
      if (this.answer.length !== this.tokens.length) return;
      const res = PatternCore.checkOrder(this.answer.map(function (c) { return c.text; }), this.tokens);
      this.countAttempt(res.ok);
      if (res.ok) { this.win(); return; }
      this.loseBuild(res);
    },

    loseBuild: function (res) {
      Sfx.soft();
      const card = $("pzCard");
      card.classList.remove("shake");
      void card.offsetWidth;
      card.classList.add("shake");
      const fb = $("pzFeedback");
      fb.classList.remove("hidden");
      fb.innerHTML =
        '<div class="pz-win soft"><div class="pz-win-badge">↻</div>' +
          '<div class="pz-win-text"><b>顺序还差一点</b><span>第 ' + (res.firstBad + 1) + ' 个词再看一眼</span></div>' +
        '</div>' +
        '<div class="pz-acts">' +
          '<button class="btn small" data-pz="speaksentence">🔊 再听一遍</button>' +
          '<button class="btn small" data-pz="hint">💡 提示下一个词</button>' +
        '</div>';
    },

    submitDictation: function () {
      if (this.solved || !this.item) return;
      const text = $("pzInput").value;
      if (!String(text || "").trim()) { toast("先写一句再检查"); return; }
      const res = PatternCore.diff(text, this.item.en);
      this.countAttempt(res.ok);
      if (res.ok) { this.win(); return; }
      Sfx.soft();
      const card = $("pzCard");
      card.classList.remove("shake");
      void card.offsetWidth;
      card.classList.add("shake");
      this.renderDiff(res);
    },

    renderDiff: function (res) {
      const parts = res.cells.map(function (c) {
        if (c.s === "same") return "<span>" + esc(c.t) + "</span>";
        if (c.s === "missing") return '<span class="df-miss">' + esc(c.t) + "</span>";
        if (c.s === "changed") {
          return '<span class="df-wrong">' + esc(c.a) + '</span><span class="df-fix">' + esc(c.t) + "</span>";
        }
        return '<span class="df-extra">' + esc(c.a) + "</span>";
      });
      const sum = [];
      if (res.missing) sum.push("漏了 " + res.missing + " 个词");
      if (res.extra) sum.push("多了 " + res.extra + " 个词");
      if (res.changed) sum.push("拼错 " + res.changed + " 个词");
      const fb = $("pzFeedback");
      fb.classList.remove("hidden");
      fb.innerHTML =
        '<div class="pz-win soft"><div class="pz-win-badge">⌨</div>' +
          '<div class="pz-win-text"><b>再对一下</b><span>黄色是没对上或拼错的地方</span></div>' +
        "</div>" +
        '<div class="pz-diff">' + parts.join(" ") + "</div>" +
        '<div class="pz-diff-sum">' + sum.map(function (s) { return "<span>" + esc(s) + "</span>"; }).join("") + "</div>" +
        '<div class="pz-acts">' +
          '<button class="btn small" data-pz="speaksentence">🔊 再听一遍</button>' +
          '<button class="btn small" data-pz="hint">💡 下一个词</button>' +
        "</div>";
    },

    win: function () {
      const self = this;
      this.solved = true;
      this.cancelLoop();
      TTS.stop();
      $("pzSpeak").classList.remove("is-playing");
      const rec = this.lev(this.levelId);
      if (rec.done.indexOf(this.idx) === -1) rec.done.push(this.idx);
      let next = -1;
      for (let i = 0; i < this.items.length; i++) {
        if (rec.done.indexOf(i) === -1) { next = i; break; }
      }
      rec.idx = next < 0 ? this.items.length : next;
      if (!this.level.isArticle) this.data.last = this.levelId;
      this.save();
      Sfx.correct();
      this.renderAnswer();
      this.showSuccess();
      this.autoTimer = setTimeout(function () { self.advance(); }, this.nextGap);
    },

    showSuccess: function () {
      const it = this.item;
      const fb = $("pzFeedback");
      const last = this.idx + 1 >= this.items.length;
      fb.classList.remove("hidden");
      fb.innerHTML =
        '<div class="pz-win"><div class="pz-win-badge">✓</div>' +
          '<div class="pz-win-text"><b>拼对了！</b><span>连对 ' + this.data.stats.streak + ' 句</span></div>' +
        "</div>" +
        '<div class="pz-full">' + renderEn(it.en) + "</div>" +
        (it.zh ? '<div class="pz-full-zh">' + esc(it.zh) + "</div>" : "") +
        (it.hint ? '<div class="pz-note">💡 ' + esc(it.hint) + "</div>" : "") +
        '<div class="pz-acts">' +
          '<button class="btn small" data-pz="speaksentence">🔊 整句</button>' +
          '<button class="btn small" data-pz="read">🎤 跟读</button>' +
          '<button class="btn small" data-pz="mine"' + (Rec.has ? "" : " disabled") + '>▶ 听我的</button>' +
        "</div>" +
        '<button class="btn primary pz-next" data-pz="next">' + (last ? "看本关成绩" : "下一句") +
          ' ›<i class="pz-next-bar" aria-hidden="true"></i></button>';
      $("pzHintLine").textContent = "点整句里的任意单词可以查词、收进生词本。";
    },

    syncMine: function () {
      const b = $("pzFeedback").querySelector('[data-pz="mine"]');
      if (b) b.disabled = !Rec.has;
    },

    /* ---------------- 下一步 ---------------- */

    cancelAuto: function () {
      clearTimeout(this.autoTimer);
      this.autoTimer = null;
    },

    advance: function () {
      if (!this.inPlay || !this.solved) return;
      const mask = $("wordMask");
      if (mask && !mask.classList.contains("hidden")) {
        const self = this;
        this.cancelAuto();
        this.autoTimer = setTimeout(function () { self.advance(); }, 2200);
        return;
      }
      this.cancelTimers();
      if (this.idx + 1 >= this.items.length) { this.finish(); return; }
      this.idx++;
      this.newSentence();
    },

    finish: function () {
      this.cancelTimers();
      this.isDone = true;
      $("pzCard").classList.add("hidden");
      $("pzFeedback").classList.add("hidden");
      $("pzDone").classList.remove("hidden");
      const rec = this.lev(this.levelId);
      const total = this.items.length;
      const done = Math.min(rec.done.length, total);
      const acc = rec.attempts ? Math.round(rec.correct * 100 / rec.attempts) : 0;
      $("pzDoneSub").textContent = this.level ? (this.level.name + (this.level.sub ? " · " + this.level.sub : "")) : "";
      $("pzDoneStats").innerHTML =
        '<span class="pz-stat">完成 <b>' + done + "/" + total + "</b></span>" +
        '<span class="pz-stat">本关正确率 <b>' + acc + "%</b></span>" +
        '<span class="pz-stat">最长连对 <b>' + this.data.stats.best + "</b></span>";
      const pos = CHALLENGE_LEVELS.indexOf(this.findLevel(this.levelId));
      const nextLv = pos >= 0 ? CHALLENGE_LEVELS[pos + 1] : null;
      $("pzNextLevel").classList.toggle("hidden", !nextLv || this.isLocked(nextLv.id));
      $("pzNextLevel").dataset.id = nextLv ? nextLv.id : "";
      $("pzProgress").textContent = "已完成 " + total + " 句";
      $("pzBar").style.width = "100%";
      $("pzHintLine").textContent = "这一关的进度已经记在当前学习档案里。";
      Sfx.level();
    },

    again: function () {
      this.idx = 0;
      this.isDone = false;
      $("pzDone").classList.add("hidden");
      $("pzCard").classList.remove("hidden");
      this.newSentence();
    },

    nextLevel: function () {
      const id = $("pzNextLevel").dataset.id;
      if (!id) return;
      this.startLevel(id);
    },

    toHome: function () {
      this.cancelTimers();
      this.inPlay = false;
      this.isDone = false;
      this.level = null;
      this.items = [];
      this.item = null;
      this.solved = false;
      $("pzHome").classList.remove("hidden");
      $("pzPlay").classList.add("hidden");
      if (currentView === "pattern") $("btnBack").classList.add("hidden");
      this.renderHome();
    },

    pause: function () {
      this.cancelTimers();
    },

    cancelTimers: function () {
      this.cancelAuto();
      this.cancelLoop();
      clearTimeout(this.checkTimer);
      this.checkTimer = null;
      TTS.stop();
      const b = $("pzSpeak");
      if (b) b.classList.remove("is-playing");
    },

    onProfileChange: function () {
      this.cancelTimers();
      this.data = null;
      this.inPlay = false;
      this.isDone = false;
      this.level = null;
      this.items = [];
      this.item = null;
      this.solved = false;
      this.loop = false;
      this.blind = false;
      this.mode = "build";
      if (currentView === "pattern") {
        $("pzHome").classList.remove("hidden");
        $("pzPlay").classList.add("hidden");
        $("btnBack").classList.add("hidden");
        this.renderHome();
      }
    },

    action: function (kind, el) {
      switch (kind) {
        case "level":
          this.startLevel(el.dataset.id);
          break;
        case "chunk":
          if (el.dataset.side === "answer") this.unplace(Number(el.dataset.uid));
          else this.place(Number(el.dataset.uid));
          break;
        case "loop":
          this.toggleLoop();
          break;
        case "blind":
          this.toggleBlind();
          break;
        case "hint":
          this.cancelAuto();
          this.hint();
          break;
        case "next":
          this.advance();
          break;
        case "speaksentence":
          this.cancelAuto();
          if (this.item) TTS.speak(this.item.en, {});
          break;
        case "read":
          this.cancelAuto();
          if (this.item) Rec.readAlong(this.item.en);
          break;
        case "mine":
          this.cancelAuto();
          Rec.play();
          break;
        default:
          break;
      }
    }
  };

  /* ========================= 事件分发 ========================= */

  function dispatch(act, data, el) {
    switch (act) {
      case "open-passage": {
        const it = findItem(data.id);
        if (it) Reader.open(it);
        break;
      }
      case "goto-pattern": {
        switchTab("pattern");
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
        const it = Reader.item;
        if (!it) return;
        Reader.stop();
        Chat.openReading(it, Reader.activeIdx());
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
      case "profile-switch": {
        const id = data.id || "";
        if (ProfileStore.switchTo(id)) {
          toast("已切换到「" + ProfileStore.profile().name + "」");
        }
        break;
      }
      case "profile-new": {
        openProfileSheet("new", "");
        break;
      }
      case "profile-edit": {
        openProfileSheet("edit", data.id || "");
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
    if (w) {
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
      else if (currentView === "pattern") Pattern.toHome();
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
      if (currentTier !== "custom") ProfileStore.setPref({ tier: currentTier });
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
      ProfileStore.setPref({ tier: currentConvTier });
      renderScenarios();
      Stage.settle();
    });

    // 阅读工具栏
    $("btnPlayAll").addEventListener("click", function () {
      if (Reader.playing) Reader.stop();
      else Reader.playAll();
    });
    $("btnStop").addEventListener("click", function () { Reader.stop(); });

    // 带着这篇文章和当前选中句去问外教
    if ($("btnAskTutor")) {
      $("btnAskTutor").addEventListener("click", function () {
        if (!Reader.item) return;
        Reader.stop();
        Chat.openReading(Reader.item, Reader.activeIdx());
      });
    }

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
    $("btnReview").addEventListener("click", function () { Flash.open(); });    $("btnShowMastered").addEventListener("click", function () {
      State.showMastered = !State.showMastered;
      $("btnShowMastered").classList.toggle("on", State.showMastered);
      renderVocab();
    });
    $("flashCard").addEventListener("click", function () {
      if (Flash.suppressClick) { Flash.suppressClick = false; return; }
      Flash.flip();
    });
    $("flashNext").addEventListener("click", function (e) { e.stopPropagation(); Flash.next(); });
    $("flashPrev").addEventListener("click", function (e) { e.stopPropagation(); Flash.prev(); });
    if ($("flashAgain")) $("flashAgain").addEventListener("click", function (e) { e.stopPropagation(); Flash.again(); });
    if ($("flashKnow")) $("flashKnow").addEventListener("click", function (e) { e.stopPropagation(); Flash.know(); });
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
    if ($("setVoiceSeg")) {
      $("setVoiceSeg").addEventListener("click", function (e) {
        const b = e.target.closest("button");
        if (!b) return;
        State.settings.voice = b.dataset.voice === "system" ? "system" : "neural";
        applySettings();
        fillSettingsForm();
        TTS.stop();
        toast(State.settings.voice === "system" ? "英文改用系统语音" : "英文改用内置神经音色");
      });
    }
    if ($("btnVoicePreview")) {
      $("btnVoicePreview").addEventListener("click", function () { previewVoice(); });
    }
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

    // 学习档案弹层
    if ($("btnProfileNew")) $("btnProfileNew").addEventListener("click", function () { openProfileSheet("new", ""); });
    if ($("pClose")) $("pClose").addEventListener("click", closeProfileSheet);
    if ($("pCancel")) $("pCancel").addEventListener("click", closeProfileSheet);
    if ($("profileSave")) $("profileSave").addEventListener("click", saveProfileSheet);
    if ($("profileMask")) $("profileMask").addEventListener("click", function (e) {
      if (e.target === $("profileMask")) closeProfileSheet();
    });
    ["pEmojiSeg", "pTierSeg", "pSpeedSeg"].forEach(function (id) {
      const seg = $(id);
      if (!seg) return;
      seg.addEventListener("click", function (e) {
        const b = e.target.closest("button");
        if (!b) return;
        seg.querySelectorAll("button").forEach(function (x) { x.classList.toggle("active", x === b); });
        setTimeout(function () { syncSeg(seg, true); }, 0);
      });
    });

    // 句型闯关
    if ($("view-pattern")) {
      $("view-pattern").addEventListener("click", function (e) {
        const t = e.target.closest("[data-pz]");
        if (!t) return;
        Pattern.action(t.dataset.pz, t);
      });
      $("pzSpeak").addEventListener("click", function () { Pattern.speak(); });
      $("pzClear").addEventListener("click", function () { Pattern.clearAnswer(); });
      $("pzHint").addEventListener("click", function () { Pattern.hint(); });
      $("pzDictHint").addEventListener("click", function () { Pattern.dictHint(); });
      $("pzSubmit").addEventListener("click", function () { Pattern.submitDictation(); });
      $("pzInput").addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          Pattern.submitDictation();
        }
      });
      $("pzModeSeg").addEventListener("click", function (e) {
        const b = e.target.closest("button");
        if (b && b.dataset.mode) Pattern.setMode(b.dataset.mode);
      });
      $("pzBack").addEventListener("click", function () { Pattern.toHome(); });
      $("btnPzContinue").addEventListener("click", function () { Pattern.startLevel(Pattern.continueId); });
      $("btnPzArticle").addEventListener("click", function () { Pattern.startLastArticle(); });
      $("pzAgain").addEventListener("click", function () { Pattern.again(); });
      $("pzNextLevel").addEventListener("click", function () { Pattern.nextLevel(); });
      $("pzDoneHome").addEventListener("click", function () { Pattern.toHome(); });
      if ($("btnPatternFromReader")) {
        $("btnPatternFromReader").addEventListener("click", function () {
          if (!Reader.item) return;
          const item = Reader.item;
          Reader.stop();
          Pattern.startFromArticle(item);
          switchTab("pattern");
        });
      }
    }

    // 设置里的过关提示音
    if ($("setSfx")) {
      $("setSfx").addEventListener("click", function () {
        State.settings.sfx = State.settings.sfx === false;
        applySettings();
        fillSettingsForm();
        toast(State.settings.sfx ? "过关提示音已打开" : "过关提示音已关闭");
      });
    }

    // 分段控件：点完以后让胶囊滑到新位置（等各页面自己的 active 逻辑先跑完）
    document.addEventListener("click", function (e) {
      const b = e.target.closest(".seg button, .seg .seg-item");
      if (!b) return;
      const seg = b.closest(".seg");
      if (!seg) return;
      setTimeout(function () { syncSeg(seg, true); }, 0);
    });
    window.addEventListener("resize", function () {
      requestAnimationFrame(function () { syncAllSegs(); });
    });
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) requestAnimationFrame(function () { syncAllSegs(); });
    });
  }

  /* ========================= 启动 ========================= */

  const App = {
    handleBack: function () {
      if (currentView === "reader") { Reader.close(); return "handled"; }
      if (currentView === "chat") { Chat.closeChat(); return "handled"; }
      if (currentView === "pattern" && Pattern.inPlay) { Pattern.toHome(); return "handled"; }
      if (!$("flashWrap").classList.contains("hidden")) { Flash.close(); return "handled"; }
      if (currentView !== "library") { switchTab("library"); return "handled"; }
      return "exit";
    }
  };
  window.App = App;

  function boot() {
    // 先把当前档案的偏好（默认年龄段 / 语速）放进去，再应用设置
    const activeProfile = ProfileStore.profile();
    if (activeProfile) {
      currentTier = activeProfile.tier || currentTier;
      currentConvTier = activeProfile.tier || currentConvTier;
      if (typeof activeProfile.speed === "number" && activeProfile.speed > 0) {
        State.settings.speed = activeProfile.speed;
      }
    }
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
      $("aboutVersion").textContent = "版本 1.5.0";
    }
    document.querySelectorAll("#tierSeg .seg-item").forEach(function (b) {
      b.classList.toggle("active", b.dataset.tier === currentTier);
    });
    renderProfiles();
    renderLibrary();
    renderScenarios();
    renderVocab();
    Streak.render(false);
    Rec.refresh();
    syncAllSegs(false);
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
