/* =========================================================
   卡壳修复（Repair）—— 外教怎么接住说不上来的学生（纯函数）
   -----------------------------------------------------------
   方法论参考：byoungd/up《口语篇》「互动修复不是补救，是能力」
   —— 没听清 / 范围不明 / 表达失败时，用确认、换说法、拆句
      把共同理解接回来；不是一次扔一段标准答案。

   这里提供三样东西：
   1. promptBlock()：追加到 AI.systemPrompt() 的修复指令
   2. isStuck()：离线兜底时判断「这句像卡住了」
   3. chunks() / offlineLine()：把一句话拆成两小步带读

   本文件不碰 DOM、不联网、不读存储，方便自动化测试。
   ========================================================= */

const REPAIR_FILLERS = /^(um+|uh+|er+|erm+|hmm+|hm+|i don'?t know|i dont know|dunno|not sure|no idea|help|sorry|wait|eh+)[\s.!?,…]*$/i;

const Repair = {
  /** 追加到 System Prompt 的「卡壳修复」规则 */
  promptBlock: function () {
    return "\n\n【卡壳修复（Repair）· 对话规则】\n" +
      "学生卡壳、拼写混乱、突然说中文求助，或只回一个很短的词（um / I don't know / 不会）时，不要直接给一段长标准答案，也不要一次纠正多处。按这个顺序做：\n" +
      "1) 先用一句鼓励接住（No problem / That's okay — you're close），不要让学生觉得说错很丢脸；\n" +
      "2) 用更简单的话把他的意思复述确认（So you mean …?），让他只需回答 yes / no；\n" +
      "3) 如果他要说的是一个句子，把它拆成两个短句块，先带他说前半句，再带他说后半句，等他跟读或复述后再继续；\n" +
      "4) 如果他是没听清你，就放慢一点、只重复关键词块，或换个更简单的说法，而不是整段重说；\n" +
      "5) 修复完成后回到原来的话题，不要停在纠错上；一次只修一个最影响沟通的点。";
  },

  /** 只判断英文（或中英混说）里像不像卡住；中文学习请求交给现有分支 */
  isStuck: function (text) {
    const s = String(text == null ? "" : text).trim();
    if (!s) return false;
    if (REPAIR_FILLERS.test(s)) return true;
    // 说到一半不会说 / 不知道怎么表达：当成卡壳
    if (/\b(i (?:can'?t|cannot|don'?t know how to) (?:say|explain|describe))\b/i.test(s)) return true;
    // 重复同一个词：I I I / the the the
    if (/^(\w+)(\s+\1){2,}[.!?…]*$/i.test(s)) return true;
    // 说到一半断掉：很短的句子 + 省略号
    if (/(\.{2,}|…)\s*$/.test(s)) {
      const n = (s.match(/[A-Za-z']+/g) || []).length;
      if (n <= 4) return true;
    }
    // 英文字母级别的乱拼（例如 asdf / 连续 5 个以上无元音字母）
    if (/^[a-z]{5,}$/i.test(s.replace(/\s+/g, "")) && !/[aeiouy]/i.test(s)) return true;
    return false;
  },

  /** 卡住的原因标签，用给界面的提示语 */
  why: function (text) {
    const s = String(text == null ? "" : text).trim();
    if (!s) return "";
    if (REPAIR_FILLERS.test(s)) return "hesitate";
    if (/(\.{2,}|…)\s*$/.test(s)) return "cut-off";
    if (/^(\w+)(\s+\1){2,}/i.test(s)) return "repeat";
    if (/^[a-z]{5,}$/i.test(s.replace(/\s+/g, "")) && !/[aeiouy]/i.test(s)) return "spelling";
    return "";
  },

  /**
   * 把一句话拆成两个可以呼吸的短句块。
   * 优先在逗号 / 分号 / 破折号处拆；其次在 and / but / because / so / when / if 前拆；
   * 都没有就按词数在中点附近拆。太短的句子原样返回一段。
   * @return 1–2 个字符串
   */
  chunks: function (sentence) {
    const s = String(sentence == null ? "" : sentence).replace(/\s+/g, " ").trim();
    if (!s) return [];
    if (s.length <= 18) return [s];

    // 1) 标点拆分：取最靠近中间的那个
    const seps = [", ", "; ", " — ", " - "];
    let best = -1;
    let bestGap = Infinity;
    seps.forEach(function (sep) {
      let from = 0;
      while (true) {
        const i = s.indexOf(sep, from);
        if (i < 0) break;
        const gap = Math.abs(i - s.length / 2);
        if (gap < bestGap) { bestGap = gap; best = i; }
        from = i + sep.length;
      }
    });
    if (best > 0) {
      const a = s.slice(0, best).trim();
      const b = s.slice(best).replace(/^[\s,;—-]+/, "").trim();
      if (a && b) return [a, b];
    }

    // 2) 连词前拆（连词留在后半句，读起来更自然）
    const conj = [" because ", " but ", " so ", " and ", " when ", " if ", " that "];
    for (let i = 0; i < conj.length; i++) {
      const at = s.toLowerCase().indexOf(conj[i]);
      if (at > 6 && at < s.length - 6) {
        const a = s.slice(0, at).trim();
        const b = s.slice(at + 1).trim();
        if (a && b) return [a, b];
      }
    }

    // 3) 按词数在中点拆
    const words = s.split(" ");
    if (words.length < 4) return [s];
    const mid = Math.ceil(words.length / 2);
    return [words.slice(0, mid).join(" "), words.slice(mid).join(" ")];
  },

  /**
   * 离线兜底对话：卡住时的一句话 + 拆句块。
   * @return { en, zh, parts }
   */
  offlineLine: function (model) {
    const parts = Repair.chunks(model);
    const en = parts.length > 1
      ? "No problem — let's say it in two small parts. First: " + parts[0] + " Then: " + parts[1] + "."
      : "No problem. Say it with me: " + (parts[0] || "");
    const zh = parts.length > 1
      ? "别急，我们拆成两小步：先「" + parts[0] + "」，再「" + parts[1] + "」。跟着念一遍就顺了。"
      : "别急，跟我念这一句：「" + (parts[0] || "") + "」。";
    return { en: en, zh: zh, parts: parts };
  }
};

if (typeof window !== "undefined") {
  window.Repair = Repair;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { Repair: Repair };
}
