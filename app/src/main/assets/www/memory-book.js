/* =========================================================
   外教「学习记忆小本本」—— 数据与纯函数
   -----------------------------------------------------------
   · 每个学习档案一份记忆：薄弱点 / 兴趣主题 / 口语偏好 / 其他。
   · 存成一个数组（见 app.js 里 ProfileStore.data("memory")），
     这里只做增删改查、去重、上限与两段供提示词使用的文本，
     不碰 DOM、不联网；换档案由调用方换成另一份数组，天然隔离。
   ========================================================= */

const MEMORY_TYPES = [
  { id: "weak", name: "薄弱点", emoji: "🎯" },
  { id: "interest", name: "兴趣主题", emoji: "💡" },
  { id: "style", name: "口语偏好", emoji: "🗣️" },
  { id: "note", name: "其他", emoji: "📌" }
];

const MEMORY_MAX = 60;
const MEMORY_TEXT_MAX = 60;

const MemoryBook = {
  types: MEMORY_TYPES,
  MAX: MEMORY_MAX,

  typeName: function (id) {
    for (let i = 0; i < MEMORY_TYPES.length; i++) {
      if (MEMORY_TYPES[i].id === id) return MEMORY_TYPES[i].name;
    }
    return "其他";
  },

  typeEmoji: function (id) {
    for (let i = 0; i < MEMORY_TYPES.length; i++) {
      if (MEMORY_TYPES[i].id === id) return MEMORY_TYPES[i].emoji;
    }
    return "📌";
  },

  /** 归一化正文：压空白、去首尾、截断 */
  text: function (raw) {
    return String(raw == null ? "" : raw)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MEMORY_TEXT_MAX);
  },

  /** 去重用的比较键 */
  key: function (type, text) {
    return String(type || "note") + "|" + MemoryBook.text(text).toLowerCase();
  },

  /** 把外来的（旧版本 / 手改的）数组洗成合法列表，新的在前，去重，封顶 */
  clean: function (list) {
    const out = [];
    const seen = {};
    (Array.isArray(list) ? list : []).forEach(function (m) {
      if (!m || typeof m !== "object") return;
      const text = MemoryBook.text(m.text || m.t);
      if (!text) return;
      let type = String(m.type || "note");
      if (MEMORY_TYPES.map(function (t) { return t.id; }).indexOf(type) < 0) type = "note";
      const k = MemoryBook.key(type, text);
      if (seen[k]) return;
      seen[k] = true;
      out.push({
        id: typeof m.id === "string" && m.id ? m.id : "m" + (out.length + 1) + Date.now().toString(36),
        type: type,
        text: text,
        src: m.src === "auto" ? "auto" : "manual",
        ts: Number(m.ts) || 0
      });
    });
    out.sort(function (a, b) { return b.ts - a.ts; });
    return out.slice(0, MEMORY_MAX);
  },

  /**
   * 加一条记忆。同类型下正文（忽略大小写）已存在就不重复加。
   * @return { list, item, added, duplicate }
   */
  add: function (list, type, rawText, src) {
    const base = MemoryBook.clean(list);
    const text = MemoryBook.text(rawText);
    if (!text) return { list: base, item: null, added: false, duplicate: false };
    const t = MEMORY_TYPES.map(function (x) { return x.id; }).indexOf(String(type)) >= 0 ? String(type) : "note";
    const k = MemoryBook.key(t, text);
    for (let i = 0; i < base.length; i++) {
      if (MemoryBook.key(base[i].type, base[i].text) === k) {
        return { list: base, item: base[i], added: false, duplicate: true };
      }
    }
    const item = {
      id: "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      type: t,
      text: text,
      src: src === "auto" ? "auto" : "manual",
      ts: Date.now()
    };
    const next = [item].concat(base).slice(0, MEMORY_MAX);
    return { list: next, item: item, added: true, duplicate: false };
  },

  remove: function (list, id) {
    return MemoryBook.clean(list).filter(function (m) { return m.id !== id; });
  },

  update: function (list, id, rawText) {
    const text = MemoryBook.text(rawText);
    if (!text) return MemoryBook.clean(list);
    return MemoryBook.clean(list).map(function (m) {
      if (m.id !== id) return m;
      return Object.assign({}, m, { text: text, src: "manual", ts: Date.now() });
    });
  },

  clear: function () {
    return [];
  },

  /** 按类型分组，新的在前 */
  grouped: function (list) {
    const out = {};
    MEMORY_TYPES.forEach(function (t) { out[t.id] = []; });
    MemoryBook.clean(list).forEach(function (m) {
      (out[m.type] || out.note).push(m);
    });
    return out;
  },

  /**
   * 给界面看的一小段摘要（对话页 / 开聊问候用），最多 n 条。
   * 例："🎯 总是忘记第三人称单数 · 💡 喜欢篮球"
   */
  brief: function (list, n) {
    const items = MemoryBook.clean(list).slice(0, Math.max(1, Number(n) || 3));
    return items.map(function (m) {
      return MemoryBook.typeEmoji(m.type) + " " + m.text;
    }).join(" · ");
  },

  /**
   * 注入外教 System Prompt 的长期记忆块。
   * 没有记忆时返回空串，调用方直接拼在后面，不会多出空行。
   */
  promptBlock: function (list) {
    const items = MemoryBook.clean(list);
    if (!items.length) return "";
    const g = MemoryBook.grouped(items);
    const line = function (type, label, max) {
      const arr = g[type].slice(0, max || 6).map(function (m) { return m.text; });
      return arr.length ? "· " + label + "：" + arr.join("；") : "";
    };
    const rows = [
      line("weak", "薄弱点"),
      line("interest", "兴趣主题"),
      line("style", "口语偏好"),
      line("note", "其他")
    ].filter(Boolean);
    if (!rows.length) return "";
    return "\n\n【外教记忆小本本 · 长期记忆】\n" + rows.join("\n") +
      "\n请在对话里自然地照顾这些点：薄弱处温和地多复现、优先聊有兴趣的话题、按偏好调整语速和解释方式。" +
      "不要逐条复述这张单子，也不要说“根据记录”。";
  },

  /** 从一句用户发言里认兴趣（英文 I like … / 中文 我喜欢…），认不出返回空串 */
  interestFrom: function (text) {
    const s = String(text == null ? "" : text);
    const junk = /^(it|this|that|them|these|those|you|him|her|me|us|one|some|more|so|too|all|both)$/i;
    const en = s.match(/\bI(?:'m| am)?\s+(?:really\s+|also\s+|kind of\s+|a bit\s+)?(?:like|love|enjoy|am into|'m into)\s+([A-Za-z][A-Za-z\s'&/-]{1,40})/i);
    if (en) {
      let topic = en[1]
        .replace(/\b(because|but|and|so|when|if|very|really|too|a lot|as well)\b.*$/i, "")
        .replace(/[.,!?;:].*$/, "")
        .replace(/\s+/g, " ")
        .trim();
      if (topic.length > 1 && topic.length <= 30 && !junk.test(topic)) return topic;
    }
    const zh = s.match(/我(?:很|超|最|特别|也|还)?(?:喜欢|爱|迷上|对)([^，。,.!?！？；;：:]{1,16})/);
    if (zh) {
      const topic = zh[1].replace(/^(了|着|听|看|玩|吃|做)/, "").trim();
      if (topic.length >= 1 && !junk.test(topic)) return topic;
    }
    return "";
  },

  /**
   * 外教点评（TIP）压缩成一条薄弱点：保留最有信息量的一句，去掉客套。
   */
  weakFromTip: function (tip) {
    let s = MemoryBook.text(String(tip || "").replace(/^💡\s*/, ""));
    s = s.replace(/^(你(?:刚才)?(?:说|写)的这句|这句话)\s*/, "").trim();
    if (!s) return "";
    const cut = s.split(/[。；;]/).filter(Boolean)[0] || s;
    return cut.slice(0, MEMORY_TEXT_MAX);
  }
};

if (typeof window !== "undefined") {
  window.MEMORY_TYPES = MEMORY_TYPES;
  window.MemoryBook = MemoryBook;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { MEMORY_TYPES: MEMORY_TYPES, MemoryBook: MemoryBook };
}
