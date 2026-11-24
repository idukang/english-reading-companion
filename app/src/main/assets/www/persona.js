/* ===========================================================
   面对面互动陪练舞台（Live Companion Stage）
   -----------------------------------------------------------
   · 三个分人群角色，全部是内联 SVG，无外部图片/视频依赖
   · 状态：idle 待命 / speaking 说话 / listening 倾听 / thinking 思考 / happy 庆祝
   · 说话时嘴型动、波形环脉冲；答得好会弹跳并撒星星
   · 状态光晕与声波点参考：Lucian UX/UI Prompt（MIT, github.com/Seokwoooo/lucian-uxui-prompt）
   =========================================================== */

const PERSONAS = {
  kids: {
    id: "kids",
    name: "Buddy",
    cn: "卡通伙伴",
    emoji: "🧸",
    role: "少儿陪练 · 0.75x 慢速 · 多鼓励",
    speed: 0.75,
    color: "#f0a45e",
    soft: "rgba(240,164,94,.18)",
    status: {
      idle: "准备好啦，选一个情景开始",
      speaking: "Buddy 正在说话…",
      listening: "Buddy 在听你说…",
      thinking: "Buddy 想一想…",
      happy: "太棒了！给你一颗小星星 ⭐",
      nudge: "慢慢说，说错也没关系"
    },
    praise: ["太棒了！", "说得真好！", "就是这样，继续说！"],
    svg:
      '<svg class="avatar-svg" viewBox="0 0 200 200" aria-hidden="true">' +
      '<ellipse cx="100" cy="196" rx="62" ry="14" fill="rgba(0,0,0,.06)"/>' +
      '<path d="M56 196 q4 -44 44 -44 q40 0 44 44 z" fill="#7fbfa4"/>' +
      '<circle cx="62" cy="62" r="23" fill="#f3b26b"/>' +
      '<circle cx="138" cy="62" r="23" fill="#f3b26b"/>' +
      '<circle cx="62" cy="62" r="12" fill="#e0914a"/>' +
      '<circle cx="138" cy="62" r="12" fill="#e0914a"/>' +
      '<circle cx="100" cy="108" r="62" fill="#f7c082"/>' +
      '<ellipse cx="100" cy="130" rx="38" ry="28" fill="#fde8cd"/>' +
      '<g class="eye-group"><ellipse class="eye" cx="79" cy="102" rx="7.5" ry="9.5" fill="#3a2a1c"/></g>' +
      '<g class="eye-group"><ellipse class="eye" cx="121" cy="102" rx="7.5" ry="9.5" fill="#3a2a1c"/></g>' +
      '<ellipse class="eye-shine" cx="81.5" cy="98" rx="2.4" ry="2.8" fill="#fff" opacity=".9"/>' +
      '<ellipse class="eye-shine" cx="123.5" cy="98" rx="2.4" ry="2.8" fill="#fff" opacity=".9"/>' +
      '<ellipse cx="100" cy="120" rx="8.5" ry="6.5" fill="#3a2a1c"/>' +
      '<path class="mouth-closed" d="M88 136 q12 11 24 0" stroke="#3a2a1c" stroke-width="4.5" fill="none" stroke-linecap="round"/>' +
      '<ellipse class="mouth-open" cx="100" cy="139" rx="12" ry="9" fill="#3a2a1c"/>' +
      '<ellipse class="mouth-open" cx="100" cy="142" rx="7" ry="4" fill="#e07a7a"/>' +
      '<circle cx="64" cy="124" r="7.5" fill="#f2948f" opacity=".5"/>' +
      '<circle cx="136" cy="124" r="7.5" fill="#f2948f" opacity=".5"/>' +
      "</svg>"
  },

  teen: {
    id: "teen",
    name: "Emma",
    cn: "外教 Emma",
    emoji: "🎒",
    role: "校园外教 · 0.95x · 发音与句式纠错",
    speed: 0.95,
    color: "#6f9bd1",
    soft: "rgba(111,155,209,.18)",
    status: {
      idle: "准备好了吗？我们开始聊天",
      speaking: "Emma 正在说话…",
      listening: "Emma 在认真听你说…",
      thinking: "Emma 在组织更地道的说法…",
      happy: "答得漂亮！这个表达很地道",
      nudge: "别急，先想一个最简单的句子"
    },
    praise: ["答得漂亮！", "这个说法很地道！", "就是这样，继续保持！"],
    svg:
      '<svg class="avatar-svg" viewBox="0 0 200 200" aria-hidden="true">' +
      '<ellipse cx="100" cy="196" rx="58" ry="13" fill="rgba(0,0,0,.06)"/>' +
      '<path d="M46 200 q6 -48 54 -48 q48 0 54 48 z" fill="#5d7fa8"/>' +
      '<path d="M86 150 h28 v20 l-14 10 -14 -10 z" fill="#f2c9a8"/>' +
      '<circle cx="100" cy="96" r="52" fill="#f7d3b3"/>' +
      '<path d="M48 96 q-4 -54 52 -54 q56 0 52 54 q-6 -30 -52 -32 q-46 2 -52 32 z" fill="#5b3b2e"/>' +
      '<circle cx="100" cy="34" r="18" fill="#5b3b2e"/>' +
      '<path d="M48 92 q-8 34 4 52 q6 -28 2 -52 z" fill="#5b3b2e"/>' +
      '<path d="M152 92 q8 34 -4 52 q-6 -28 -2 -52 z" fill="#5b3b2e"/>' +
      '<g class="eye-group"><ellipse class="eye" cx="80" cy="94" rx="7" ry="9" fill="#2f3b4a"/></g>' +
      '<g class="eye-group"><ellipse class="eye" cx="120" cy="94" rx="7" ry="9" fill="#2f3b4a"/></g>' +
      '<ellipse class="eye-shine" cx="82" cy="90" rx="2.2" ry="2.6" fill="#fff" opacity=".9"/>' +
      '<ellipse class="eye-shine" cx="122" cy="90" rx="2.2" ry="2.6" fill="#fff" opacity=".9"/>' +
      '<path d="M70 78 q10 -7 20 -2" stroke="#5b3b2e" stroke-width="3.5" fill="none" stroke-linecap="round"/>' +
      '<path d="M110 76 q10 -5 20 2" stroke="#5b3b2e" stroke-width="3.5" fill="none" stroke-linecap="round"/>' +
      '<path d="M100 100 q-5 12 0 16" stroke="#e3b092" stroke-width="3" fill="none" stroke-linecap="round"/>' +
      '<path class="mouth-closed" d="M88 124 q12 10 24 0" stroke="#c2554f" stroke-width="4.5" fill="none" stroke-linecap="round"/>' +
      '<ellipse class="mouth-open" cx="100" cy="127" rx="11" ry="8" fill="#b8494a"/>' +
      '<circle cx="66" cy="116" r="7" fill="#f2a2a2" opacity=".45"/>' +
      '<circle cx="134" cy="116" r="7" fill="#f2a2a2" opacity=".45"/>' +
      '<circle cx="46" cy="104" r="3.4" fill="#ffd66e"/>' +
      '<circle cx="154" cy="104" r="3.4" fill="#ffd66e"/>' +
      "</svg>"
  },

  adult: {
    id: "adult",
    name: "Alex",
    cn: "商务教练",
    emoji: "📰",
    role: "商务教练 · 1.0x · 真实职场追问与地道表达",
    speed: 1.0,
    color: "#4f7c6a",
    soft: "rgba(79,124,106,.18)",
    status: {
      idle: "随时开始，我会像真实场景那样追问",
      speaking: "Alex 正在说话…",
      listening: "Alex 在听你说…",
      thinking: "Alex 在斟酌更专业的说法…",
      happy: "这个回答很专业，可以这么说",
      nudge: "先给出结论，再补一句原因"
    },
    praise: ["很专业！", "这个表达可以直接用在会议上", "答得清楚有力"],
    svg:
      '<svg class="avatar-svg" viewBox="0 0 200 200" aria-hidden="true">' +
      '<ellipse cx="100" cy="196" rx="56" ry="13" fill="rgba(0,0,0,.06)"/>' +
      '<path d="M44 200 q6 -50 56 -50 q50 0 56 50 z" fill="#2f4858"/>' +
      '<path d="M86 152 h28 v22 l-14 12 -14 -12 z" fill="#f0c8a8"/>' +
      '<path d="M100 186 l16 -14 -4 -10 -12 6 -12 -6 -4 10 z" fill="#e8eef2"/>' +
      '<path d="M100 158 l7 14 -7 8 -7 -8 z" fill="#9b2f3a"/>' +
      '<circle cx="100" cy="98" r="52" fill="#f2cbb0"/>' +
      '<path d="M50 92 q-2 -46 50 -46 q52 0 50 46 q-10 -26 -50 -26 q-40 0 -50 26 z" fill="#2b2b30"/>' +
      '<path d="M64 62 q16 -18 36 -18 q20 0 36 18 q-18 -10 -36 -10 q-18 0 -36 10 z" fill="#3a3a42"/>' +
      '<g class="eye-group"><ellipse class="eye" cx="80" cy="98" rx="6.6" ry="8.6" fill="#2b3340"/></g>' +
      '<g class="eye-group"><ellipse class="eye" cx="120" cy="98" rx="6.6" ry="8.6" fill="#2b3340"/></g>' +
      '<ellipse class="eye-shine" cx="82" cy="94" rx="2" ry="2.4" fill="#fff" opacity=".9"/>' +
      '<ellipse class="eye-shine" cx="122" cy="94" rx="2" ry="2.4" fill="#fff" opacity=".9"/>' +
      '<path d="M68 84 q12 -6 22 -1" stroke="#2b2b30" stroke-width="3.6" fill="none" stroke-linecap="round"/>' +
      '<path d="M110 83 q10 -5 22 1" stroke="#2b2b30" stroke-width="3.6" fill="none" stroke-linecap="round"/>' +
      '<path d="M100 102 q-5 12 0 16" stroke="#dfae90" stroke-width="3" fill="none" stroke-linecap="round"/>' +
      '<path class="mouth-closed" d="M88 126 q12 8 24 0" stroke="#a4564f" stroke-width="4.5" fill="none" stroke-linecap="round"/>' +
      '<ellipse class="mouth-open" cx="100" cy="129" rx="10.5" ry="7.5" fill="#8f4640"/>' +
      '<path d="M72 118 q28 24 56 0" stroke="rgba(43,43,48,.18)" stroke-width="2" fill="none"/>' +
      "</svg>"
  }
};

const STAGE_ORDER = ["kids", "teen", "adult"];

const Stage = {
  personaId: "kids",
  state: "idle",
  hosts: [],

  persona: function () {
    return PERSONAS[this.personaId] || PERSONAS.kids;
  },

  html: function (compact, slim) {
    const p = this.persona();
    if (slim) {
      return '<span class="stage-halo" aria-hidden="true"><i></i><i></i><i></i></span>' +
        '<div class="stage-face">' + p.svg + "</div>" +
        '<div class="stage-meta">' +
          '<div class="stage-badge"><i class="dot"></i><span class="badge-text"></span></div>' +
          '<div class="stage-dots" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>' +
          '<div class="stage-live-note">SenseVoice 离线识别 · 中英混说 · 说完自动接话</div>' +
        "</div>" +
        '<div class="stage-confetti"></div>';
    }
    return '<div class="stage-arm">' +
        '<span class="wave w1"></span><span class="wave w2"></span><span class="wave w3"></span>' +
      "</div>" +
      '<span class="stage-halo" aria-hidden="true"><i></i><i></i><i></i></span>' +
      '<div class="stage-face">' + p.svg + "</div>" +
      '<div class="stage-meta">' +
        '<div class="stage-name">' + p.name +
          '<span class="stage-cn">' + p.cn + "</span></div>" +
        '<div class="stage-badge"><i class="dot"></i><span class="badge-text">' +
          (p.status[this.state] || p.status.idle) + "</span></div>" +
        '<div class="stage-dots" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>' +
        '<div class="stage-role">' + p.role + "</div>" +
      "</div>" +
      '<div class="stage-confetti"></div>';
  },

  mount: function () {
    const self = this;
    this.hosts = [];
    document.querySelectorAll("[data-stage]").forEach(function (host) {
      host.classList.add("stage");
      host.setAttribute("data-persona", self.personaId);
      if (host.dataset.compact === "1") host.classList.add("compact");
      if (host.dataset.slim === "1") host.classList.add("slim");
      host.style.setProperty("--persona", self.persona().color);
      host.style.setProperty("--persona-soft", self.persona().soft);
      host.innerHTML = self.html(host.dataset.compact === "1", host.dataset.slim === "1");
      self.hosts.push(host);
    });
    this.applyState(this.state);
  },

  setPersona: function (id) {
    if (!PERSONAS[id] || id === this.personaId) return;
    this.personaId = id;
    this.mount();
  },

  setState: function (state, text) {
    this.state = state || "idle";
    this.applyState(state, text);
  },

  applyState: function (state, text) {
    const self = this;
    this.hosts.forEach(function (host) {
      host.classList.remove("state-idle", "state-speaking", "state-listening", "state-thinking", "state-happy");
      host.classList.add("state-" + (state || "idle"));
      host.classList.toggle("talking", state === "speaking");
      const badge = host.querySelector(".badge-text");
      if (badge) {
        const p = self.persona();
        const live = host.dataset.live === "1" && window.Live;
        badge.textContent = text || (live ? window.Live.pill(state) : (p.status[state] || p.status.idle));
      }
      if (state === "happy") self.burst(host);
    });
    // 对话输入框的麦克风：思考 / 说话时也有对应反馈（“在听”由识别状态控制）
    const mic = document.getElementById("btnMic");
    if (mic) {
      mic.classList.toggle("mic-thinking", state === "thinking");
      mic.classList.toggle("mic-speaking", state === "speaking");
    }
  },

  burst: function (host) {
    const box = host.querySelector(".stage-confetti");
    if (!box) return;
    box.innerHTML = "";
    for (let i = 0; i < 10; i++) {
      const s = document.createElement("span");
      s.className = "confetti";
      s.style.left = (20 + Math.random() * 60) + "%";
      s.style.animationDelay = (i * 40) + "ms";
      s.style.setProperty("--dx", (Math.random() * 70 - 35) + "px");
      s.style.setProperty("--dy", (-40 - Math.random() * 50) + "px");
      s.textContent = ["⭐", "✨", "🎉", "💫"][i % 4];
      box.appendChild(s);
    }
    setTimeout(function () { if (box) box.innerHTML = ""; }, 1600);
  },

  speak: function () { this.setState("speaking"); },
  listen: function () { this.setState("listening"); },
  think: function () { this.setState("thinking"); },
  settle: function () { this.setState("idle"); },

  celebrate: function (text) {
    const p = this.persona();
    const praise = p.praise[Math.floor(Math.random() * p.praise.length)];
    this.setState("happy", text || praise);
  }
};
