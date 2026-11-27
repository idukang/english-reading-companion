/* =========================================================
   选词填空 + 英汉配对 —— 出题核心（纯函数）
   -----------------------------------------------------------
   · 题目都来自 cefr.js 的分级词库（等级 / 词频 / 例句源自
     pretzelai/openlingo，MIT；中文释义来自本项目 dict.js）。
   · 这里不碰 DOM、不联网、不读存储，方便自动化测试。
   · 选词填空只挖「例句里原样出现的原形词」，选项是 3 个同词性的
     干扰项，所以填进去语法都通顺，只能靠意思判断。
   ========================================================= */

const QuizCore = {
  LEVELS: ["A1", "A2", "B1", "B2"],

  LEVEL_NAMES: {
    A1: "A1 · 入门",
    A2: "A2 · 基础",
    B1: "B1 · 进阶",
    B2: "B2 · 高阶"
  },

  /** 打乱数组，可注入固定随机源（测试用） */
  shuffle: function (list, rnd) {
    const src = Array.isArray(list) ? list.slice() : [];
    const random = typeof rnd === "function" ? rnd : Math.random;
    for (let i = src.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      const t = src[i];
      src[i] = src[j];
      src[j] = t;
    }
    return src;
  },

  /** 某个等级里能出题的词条 */
  pool: function (all, lv) {
    return (Array.isArray(all) ? all : []).filter(function (e) {
      return e && e.lv === lv && e.u !== false && e.z && e.w;
    });
  },

  /** 例句是否适合挖空：4–20 个词，且这个词是原形 */
  blankable: function (entry) {
    if (!entry || !entry.e || !entry.b || !entry.z) return false;
    const words = String(entry.e).match(/[A-Za-z]+(?:['’][A-Za-z]+)*/g) || [];
    if (words.length < 4 || words.length > 20) return false;
    return words.some(function (w) { return w.toLowerCase() === String(entry.b).toLowerCase(); });
  },

  /** 从候选里按词频挑一个没出过的词；没有就返回 null */
  pickEntry: function (pool, used, rnd) {
    const usedSet = used || {};
    const free = (pool || []).filter(function (e) {
      return e && e.u !== false && !usedSet[e.w];
    });
    if (!free.length) return null;
    const random = typeof rnd === "function" ? rnd : Math.random;
    return free[Math.floor(random() * free.length)];
  },

  /**
   * 生成一道选词填空。
   * @param entry 正确词条（cefr.js 的一条）
   * @param pool  同等级的候选词条
   * @param rnd   可注入随机源
   * @return { word, form, lv, zh, sentence, options:[{w, ok}] } 或 null
   */
  buildBlank: function (entry, pool, rnd, all) {
    if (!this.blankable(entry)) return null;
    const form = String(entry.b);
    const re = new RegExp("\\b" + form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
    if (!re.test(entry.e)) return null;
    const sentence = String(entry.e).replace(re, "____");

    const random = typeof rnd === "function" ? rnd : Math.random;
    const inSentence = {};
    (String(entry.e).match(/[A-Za-z]+(?:['’][A-Za-z]+)*/g) || []).forEach(function (w) {
      inSentence[w.toLowerCase()] = true;
    });

    const seenZh = {};
    seenZh[String(entry.z)] = true;
    const want = 3;

    const collect = function (list, samePosOnly) {
      const out = [];
      const picked = {};
      const localZh = Object.assign({}, seenZh);
      const shuffled = QuizCore.shuffle(list, random);
      for (let i = 0; i < shuffled.length && out.length < want; i++) {
        const c = shuffled[i];
        if (!c || c.w === entry.w) continue;
        if (!c.z || localZh[String(c.z)]) continue;
        if (samePosOnly && c.p !== entry.p) continue;
        if (inSentence[c.w]) continue;
        if (picked[c.w]) continue;
        picked[c.w] = true;
        localZh[String(c.z)] = true;
        out.push(c.w);
      }
      return out;
    };

    // 先同等级同词性，再多借几个等级的同词性词，凑不够 3 个就放弃这道题
    let words = collect(this.pool(pool, entry.lv), true);
    if (words.length < want) {
      const wider = (Array.isArray(all) ? all : pool || []).filter(function (e) {
        return e && e.u !== false && e.lv === entry.lv && e.p === entry.p;
      });
      words = collect(wider, true);
    }
    if (words.length < want) {
      const anyLevel = (Array.isArray(all) ? all : pool || []).filter(function (e) {
        return e && e.u !== false && e.p === entry.p;
      });
      words = collect(anyLevel, true);
    }
    if (words.length < want) return null;

    const options = QuizCore.shuffle(
      [{ w: form, ok: true }].concat(words.map(function (w) { return { w: w, ok: false }; })),
      random
    );

    return {
      word: entry.w,
      form: form,
      lv: entry.lv,
      pos: entry.p || "",
      zh: entry.z,
      sentence: sentence,
      options: options
    };
  },

  /**
   * 生成一轮英汉配对：size 组（默认 5），英文与中文各自打乱。
   * @return { pairs:[{i,w,zh,lv}], left:[{i,w}], right:[{i,zh}] } 或 null
   */
  buildMatch: function (pool, size, rnd) {
    const want = Math.max(2, Math.min(5, Number(size) || 5));
    const random = typeof rnd === "function" ? rnd : Math.random;
    const list = QuizCore.shuffle((pool || []).filter(function (e) {
      return e && e.u !== false && e.w && e.z;
    }), random);

    const pairs = [];
    const seenW = {};
    const seenZ = {};
    for (let i = 0; i < list.length && pairs.length < want; i++) {
      const e = list[i];
      if (seenW[e.w] || seenZ[String(e.z)]) continue;
      seenW[e.w] = true;
      seenZ[String(e.z)] = true;
      pairs.push({ i: pairs.length, w: e.w, zh: e.z, lv: e.lv });
    }
    if (pairs.length < 2) return null;

    return {
      pairs: pairs,
      left: QuizCore.shuffle(pairs.map(function (p) { return { i: p.i, w: p.w }; }), random),
      right: QuizCore.shuffle(pairs.map(function (p) { return { i: p.i, zh: p.zh }; }), random)
    };
  },

  /** 配对判定：两侧的 pair id 相同即配成 */
  match: function (a, b) {
    return a != null && b != null && Number(a) === Number(b);
  },

  /** 等级是否合法（A1 / A2 / B1 / B2） */
  isLevel: function (lv) {
    return QuizCore.LEVELS.indexOf(String(lv || "").toUpperCase()) >= 0;
  }
};

if (typeof window !== "undefined") {
  window.QuizCore = QuizCore;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { QuizCore: QuizCore };
}
