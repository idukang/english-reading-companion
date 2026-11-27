/* =========================================================
   主动回忆 + 错因分诊（纯函数）
   -----------------------------------------------------------
   方法论参考：byoungd/up《词汇篇》
   —— 卡片正面要求「回忆」而不是重新阅读答案；失败时先分类缺口
      （看不出词形 / 听不出 / 义项误判），再进下一次最小修复。

   翻卡自评三档：想起来了 / 模糊 / 没记住
   错因三类：词形陌生 / 听音辨识弱 / 义项混淆

   本文件不碰 DOM、不联网、不读存储，方便自动化测试。
   ========================================================= */

const RECALL_RATINGS = [
  { id: "got", label: "想起来了", emoji: "😀", quality: "good", hint: "下次间隔往后拉长" },
  { id: "fuzzy", label: "模糊", emoji: "🤔", quality: "fuzzy", hint: "明天再遇到它一次" },
  { id: "miss", label: "没记住", emoji: "😵", quality: "miss", hint: "半小时后再来，并记下错因" }
];

const ERROR_CAUSES = [
  {
    id: "form",
    label: "词形陌生",
    emoji: "🔤",
    tip: "看得出大概、拼不准：抄一遍原词，再放进一个新句子里读出来。"
  },
  {
    id: "sound",
    label: "听音辨识弱",
    emoji: "👂",
    tip: "看得懂却听不出：先只听 3–5 秒，再打开文字对照重听。"
  },
  {
    id: "meaning",
    label: "义项混淆",
    emoji: "🔀",
    tip: "认识却选错意思：把近义的两个词放一起，各造一句对比。"
  }
];

const Recall = {
  ratings: RECALL_RATINGS,
  causes: ERROR_CAUSES,

  rating: function (id) {
    for (let i = 0; i < RECALL_RATINGS.length; i++) {
      if (RECALL_RATINGS[i].id === id) return RECALL_RATINGS[i];
    }
    return null;
  },

  cause: function (id) {
    for (let i = 0; i < ERROR_CAUSES.length; i++) {
      if (ERROR_CAUSES[i].id === id) return ERROR_CAUSES[i];
    }
    return null;
  },

  causeLabel: function (id) {
    const c = Recall.cause(id);
    return c ? c.label : "";
  },

  causeTip: function (id) {
    const c = Recall.cause(id);
    return c ? c.tip : "";
  },

  /** 归一化一个英文句子：小写、去掉标点、压空白 */
  words: function (text) {
    return String(text == null ? "" : text)
      .toLowerCase()
      .replace(/[’']/g, "'")
      .replace(/[^a-z' ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  },

  /** 编辑距离（只用于判断“拼错还是完全没听出来”，输入很短） */
  distance: function (a, b) {
    const s = Recall.words(a), t = Recall.words(b);
    if (!s.length) return t.length;
    if (!t.length) return s.length;
    let prev = [];
    for (let j = 0; j <= t.length; j++) prev[j] = j;
    for (let i = 1; i <= s.length; i++) {
      const cur = [i];
      for (let j = 1; j <= t.length; j++) {
        const cost = s.charAt(i - 1) === t.charAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      prev = cur;
    }
    return prev[t.length];
  },

  /** 0–1 的相似度：1 = 完全一样 */
  similarity: function (a, b) {
    const s = Recall.words(a), t = Recall.words(b);
    const max = Math.max(s.length, t.length);
    if (!max) return 1;
    return Math.max(0, 1 - Recall.distance(s, t) / max);
  },

  /**
   * 错因分诊。
   * kind：
   *   "recall-text"  翻卡看了英文想不起意思（detail: "fuzzy" / "miss"）
   *   "recall-audio" 只听读音没想起来
   *   "dictation"    听写错了（detail: { written, target }）
   *   "blank"        选词填空选错
   *   "match"        英汉配对配错
   * @return 错因 id："form" / "sound" / "meaning"
   */
  classify: function (kind, detail) {
    const k = String(kind || "");
    if (k === "recall-audio") return "sound";
    if (k === "recall-text") {
      return detail === "fuzzy" ? "meaning" : "form";
    }
    if (k === "dictation") {
      const d = detail && typeof detail === "object" ? detail : {};
      const written = String(d.written || "");
      const target = String(d.target || "");
      if (!Recall.words(written)) return "sound";
      const ratio = target ? Recall.similarity(written, target) : 0;
      // 拼得像（首字母对、差距小）算词形问题；差得远说明声音没切出来
      if (ratio >= 0.55) return "form";
      if (ratio >= 0.3 && Recall.words(written).charAt(0) === Recall.words(target).charAt(0)) return "form";
      return "sound";
    }
    if (k === "blank" || k === "match") return "meaning";
    return "meaning";
  },

  /**
   * 生成一条写进「外教记忆小本本 · 薄弱点」的文字（≤60 字，MemoryBook 会再截断）。
   * 例：词形陌生：“schedule”（日程安排）看了也想不起意思（主动回忆）
   */
  weakText: function (word, zh, kind, detail) {
    const w = String(word == null ? "" : word).trim().slice(0, 24);
    if (!w) return "";
    const causeId = Recall.classify(kind, detail);
    const label = Recall.causeLabel(causeId);
    const hint = String(zh || "").replace(/（[^）]*）/g, "").split(/[；;]/)[0].trim().slice(0, 14);
    const where = {
      "recall-text": "主动回忆",
      "recall-audio": "只听读音",
      "dictation": "听写",
      "blank": "选词填空",
      "match": "英汉配对"
    }[String(kind || "")] || "练习";
    return label + "：“" + w + "”" + (hint ? "（" + hint + "）" : "") + "还不太熟（" + where + "）";
  },

  /** 给练习结果一句可执行的下一步（按错因） */
  nextStep: function (causeId) {
    const tip = Recall.causeTip(causeId);
    return tip || "再遇到它一次，先想意思，再看答案。";
  }
};

if (typeof window !== "undefined") {
  window.RECALL_RATINGS = RECALL_RATINGS;
  window.ERROR_CAUSES = ERROR_CAUSES;
  window.Recall = Recall;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { RECALL_RATINGS: RECALL_RATINGS, ERROR_CAUSES: ERROR_CAUSES, Recall: Recall };
}
