/* =========================================================
   句型闯关 —— 内置分级句库 + 纯函数工具
   -----------------------------------------------------------
   · 全部句子、中文提示、讲解均为本项目原创编写，不引用任何第三方
     课程或代码（Earthworm 为 AGPL-3.0，这里只借鉴「整句主动回忆 +
     听写 + 过关反馈」的产品思路，没有一行代码或一条数据来自它）。
   · 三关各 10 句：Level 1 日常短句、Level 2 生活场景、Level 3 进阶表达。
   · [[双中括号]] 可标重点词块（与书库一致），闯关时自动去掉标记。
   · 本文件不联网、不做任何统计，只是数据和纯函数。
   ========================================================= */

const CHALLENGE_LEVELS = [
  {
    id: "l1",
    name: "Level 1 · 开口热身",
    emoji: "🌱",
    sub: "日常高频短句",
    desc: "先把最简单的事说清楚：起床、点单、请人再说一遍。",
    sentences: [
      {
        en: "I get up at seven every morning.",
        zh: "我每天早上七点起床。",
        tag: "日常",
        hint: "get up 是“起床”；时间放前面、频率放句尾，读起来最顺。"
      },
      {
        en: "Could you say that again, please?",
        zh: "你能再说一遍吗？",
        tag: "沟通",
        hint: "Could you … , please? 比 Can you 更客气，是最稳妥的请求句。"
      },
      {
        en: "My sister likes apples and oranges.",
        zh: "我妹妹喜欢苹果和橙子。",
        tag: "家庭",
        hint: "第三人称单数动词要加 -s：she likes、he likes。"
      },
      {
        en: "There is a small park near my home.",
        zh: "我家附近有一个小公园。",
        tag: "社区",
        hint: "There is + 单数名词；near my home 是“在我家附近”。"
      },
      {
        en: "We have dinner together on Sundays.",
        zh: "我们每个周日一起吃晚饭。",
        tag: "家庭",
        hint: "on + 星期几；on Sundays 表示“每逢周日”的习惯。"
      },
      {
        en: "I am looking for my blue umbrella.",
        zh: "我在找我的蓝雨伞。",
        tag: "日常",
        hint: "look for 是“寻找”，正在找就用 am looking for。"
      },
      {
        en: "The bus arrives in ten minutes.",
        zh: "公交车十分钟后到。",
        tag: "出行",
        hint: "“多久之后”用 in：in ten minutes，不用 after ten minutes。"
      },
      {
        en: "Please turn off the light when you go out.",
        zh: "出去的时候请把灯关掉。",
        tag: "家庭",
        hint: "turn off 是“关掉”；when 从句里用一般现在时表示将来。"
      },
      {
        en: "She is good at telling stories.",
        zh: "她很会讲故事。",
        tag: "校园",
        hint: "be good at + 动名词：good at telling，不能说 good at tell。"
      },
      {
        en: "Do you want to come with us?",
        zh: "你想和我们一起去吗？",
        tag: "朋友",
        hint: "want to + 动词原形；with us 是“和我们一起”。"
      }
    ]
  },
  {
    id: "l2",
    name: "Level 2 · 生活场景",
    emoji: "🏙️",
    sub: "出门、问路、办事",
    desc: "句子长一点，加上原因、条件和礼貌的说法。",
    sentences: [
      {
        en: "I usually take the subway to work because it is faster than the bus.",
        zh: "我通常坐地铁上班，因为地铁比公交快。",
        tag: "通勤",
        hint: "take the subway 是“坐地铁”；because 后面接完整句子说明原因。"
      },
      {
        en: "Could you tell me where the nearest pharmacy is?",
        zh: "你能告诉我最近的药店在哪里吗？",
        tag: "问路",
        hint: "宾语从句用陈述语序：where the pharmacy is，不要说 where is the pharmacy。"
      },
      {
        en: "The restaurant on the corner serves very fresh noodles.",
        zh: "街角那家餐馆的面条很新鲜。",
        tag: "吃饭",
        hint: "on the corner 是“在街角”；serve 在这里是“供应（食物）”。"
      },
      {
        en: "I forgot to bring my charger, so I need to buy one.",
        zh: "我忘了带充电器，所以得去买一个。",
        tag: "出行",
        hint: "forget to do 是“忘了要做”；one 代替 a charger，避免重复。"
      },
      {
        en: "She has been learning English for three years.",
        zh: "她学英语已经三年了。",
        tag: "校园",
        hint: "has been doing 是现在完成进行时，强调一直持续到现在。"
      },
      {
        en: "If it rains tomorrow, we will stay at home and watch a movie.",
        zh: "如果明天下雨，我们就待在家里看电影。",
        tag: "计划",
        hint: "if 从句用一般现在时、主句用 will，也就是“主将从现”。"
      },
      {
        en: "The train was so crowded that I could not find a seat.",
        zh: "火车太挤了，我找不到座位。",
        tag: "出行",
        hint: "so + 形容词 + that 引导结果：太……以至于……。"
      },
      {
        en: "Would you mind speaking a little more slowly?",
        zh: "你介意说慢一点吗？",
        tag: "沟通",
        hint: "Would you mind + 动名词：speaking；“不介意”回答 No, not at all。"
      },
      {
        en: "I left my keys on the table in the kitchen.",
        zh: "我把钥匙落在厨房的桌子上了。",
        tag: "家庭",
        hint: "leave sth + 地点 是“把东西落在某处”，过去式是 left。"
      },
      {
        en: "This shop closes at nine, so we should leave before eight.",
        zh: "这家店九点关门，所以我们最好八点前走。",
        tag: "购物",
        hint: "before eight 是“八点之前”；should 表示“应该、最好”。"
      }
    ]
  },
  {
    id: "l3",
    name: "Level 3 · 进阶表达",
    emoji: "🚀",
    sub: "工作、观点与复杂句",
    desc: "职场与观点表达：被动、条件、比较，一句里套两层意思。",
    sentences: [
      {
        en: "The meeting has been moved to Thursday afternoon because the manager is traveling.",
        zh: "会议改到了周四下午，因为经理正在出差。",
        tag: "职场",
        hint: "has been moved 是被动语态的现在完成时：会议“被”改期。"
      },
      {
        en: "Although the project was difficult, the team finished it on time.",
        zh: "虽然这个项目很难，团队还是按时完成了。",
        tag: "职场",
        hint: "although 和 but 不同时用；on time 是“按时”。"
      },
      {
        en: "I would appreciate it if you could send me the report by Friday.",
        zh: "如果你能在周五前把报告发给我，我会很感激。",
        tag: "邮件",
        hint: "I would appreciate it if you could … 是职场里最礼貌的请求句式。"
      },
      {
        en: "The more you practice speaking, the more confident you will become.",
        zh: "你越练口语，就会越自信。",
        tag: "学习",
        hint: "the + 比较级, the + 比较级：越……就越……。"
      },
      {
        en: "Please make sure the door is locked before you leave the office.",
        zh: "离开办公室前，请确认门已经锁好。",
        tag: "职场",
        hint: "make sure + 句子；is locked 是被动，表示“被锁好”。"
      },
      {
        en: "It is important to check the details before signing the contract.",
        zh: "签合同之前核对细节很重要。",
        tag: "职场",
        hint: "It is + 形容词 + to do：真正的主语是后面的 to check …。"
      },
      {
        en: "He suggested that we should start the work earlier than planned.",
        zh: "他建议我们比原计划更早开始这项工作。",
        tag: "会议",
        hint: "suggest that + (should) do，口语里 should 常常省略。"
      },
      {
        en: "The city has changed a lot since I moved here five years ago.",
        zh: "自从我五年前搬到这里，这座城市变化很大。",
        tag: "生活",
        hint: "since + 过去的时间点，主句用现在完成时。"
      },
      {
        en: "We need to find a way to solve this problem without spending too much money.",
        zh: "我们得找到一个不太花钱就能解决这个问题的办法。",
        tag: "工作",
        hint: "without + 动名词：without spending；a way to do 是“做……的办法”。"
      },
      {
        en: "If I had known about the traffic, I would have left home much earlier.",
        zh: "要是早知道会堵车，我就会更早出门了。",
        tag: "复盘",
        hint: "与过去事实相反：if + had done，主句用 would have done。"
      }
    ]
  }
];

/* =========================================================
   PatternCore —— 词块拆句、打乱、校验、听写比对
   全部是纯函数，不碰 DOM、不读网络，方便自动化测试。
   ========================================================= */

const PatternCore = {
  /** 去掉 [[ ]] 高亮标记，并把连续空白压成一个空格 */
  plain: function (sentence) {
    return String(sentence == null ? "" : sentence)
      .replace(/\[\[|\]\]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  },

  /** 按空格拆词块，标点留在词尾（“again,” “please?”），口语连写不拆 */
  tokenize: function (sentence) {
    const s = this.plain(sentence);
    if (!s) return [];
    return s.split(" ").filter(function (w) { return w.length > 0; });
  },

  /** 比较用的词形：小写、去首尾标点，保留词内撇号和连字符 */
  core: function (token) {
    return String(token == null ? "" : token)
      .replace(/[’‘]/g, "'")
      .toLowerCase()
      .replace(/^[^a-z0-9']+/, "")
      .replace(/[^a-z0-9']+$/, "");
  },

  /** 一句话里所有可用于比较的词（标点当分隔符，词内撇号保留） */
  words: function (text) {
    return String(text == null ? "" : text)
      .replace(/[’‘]/g, "'")
      .toLowerCase()
      .replace(/[^a-z0-9']+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .filter(function (w) { return w.length > 0; });
  },

  /**
   * 打乱词块顺序。传入 rnd 可注入固定随机源（测试用）。
   * 两个以上词块时，保证打乱后不会和原句顺序完全相同。
   */
  shuffle: function (list, rnd) {
    const src = Array.isArray(list) ? list.slice() : [];
    const random = typeof rnd === "function" ? rnd : Math.random;
    for (let i = src.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      const t = src[i];
      src[i] = src[j];
      src[j] = t;
    }
    let same = src.length > 1;
    for (let k = 0; k < src.length && same; k++) {
      if (src[k] !== list[k]) same = false;
    }
    if (same) {
      const t = src[0];
      src[0] = src[1];
      src[1] = t;
    }
    return src;
  },

  /** 词块拼句：忽略大小写和标点，只比语序；返回是否全对和第一个错的词位 */
  checkOrder: function (answerTokens, targetTokens) {
    const a = (answerTokens || []).map(this.core, this);
    const t = (targetTokens || []).map(this.core, this);
    if (a.length !== t.length) {
      return { ok: false, firstBad: Math.min(a.length, t.length), missing: t.length - Math.min(a.length, t.length) };
    }
    for (let i = 0; i < t.length; i++) {
      if (a[i] !== t[i]) return { ok: false, firstBad: i };
    }
    return { ok: true, firstBad: -1 };
  },

  /** 提示下一个该放的词；已经拼满返回空串 */
  nextWord: function (answerTokens, targetTokens) {
    const n = (answerTokens || []).length;
    if (!targetTokens || n >= targetTokens.length) return "";
    return targetTokens[n];
  },

  /**
   * 听写宽容校验 + 逐词差异。
   * 忽略大小写、标点、多余空格和句末标点；返回：
   *   ok        整句是否完全一致
   *   cells     逐词对齐结果 {t, a, s}，s = same / missing / extra / changed
   *   missing / extra / changed  三类错误数量
   *   targetWords / answerWords  比较用的词序列
   */
  diff: function (answerText, targetSentence) {
    const targetTokens = this.tokenize(targetSentence);
    const answerTokens = this.tokenize(answerText);
    const t = targetTokens.map(this.core, this);
    const a = answerTokens.map(this.core, this);

    // 最长公共子序列，用来对齐两边的词
    const n = t.length;
    const m = a.length;
    const dp = [];
    for (let i = 0; i <= n; i++) {
      dp.push(new Array(m + 1).fill(0));
    }
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = (t[i] === a[j])
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }

    const raw = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (t[i] === a[j]) {
        raw.push({ s: "same", t: targetTokens[i], a: answerTokens[j] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        raw.push({ s: "missing", t: targetTokens[i], a: "" });
        i++;
      } else {
        raw.push({ s: "extra", t: "", a: answerTokens[j] });
        j++;
      }
    }
    while (i < n) { raw.push({ s: "missing", t: targetTokens[i], a: "" }); i++; }
    while (j < m) { raw.push({ s: "extra", t: "", a: answerTokens[j] }); j++; }

    // 相邻的「漏一个 + 多一个」合并成「拼错」，显示更直观
    const cells = [];
    for (let k = 0; k < raw.length; k++) {
      const cur = raw[k];
      const next = raw[k + 1];
      if (cur.s === "missing" && next && next.s === "extra") {
        cells.push({ s: "changed", t: cur.t, a: next.a });
        k++;
      } else if (cur.s === "extra" && next && next.s === "missing") {
        cells.push({ s: "changed", t: next.t, a: cur.a });
        k++;
      } else {
        cells.push(cur);
      }
    }

    let missing = 0;
    let extra = 0;
    let changed = 0;
    cells.forEach(function (c) {
      if (c.s === "missing") missing++;
      else if (c.s === "extra") extra++;
      else if (c.s === "changed") changed++;
    });

    return {
      ok: raw.length === n && n === m && t.every(function (w, idx) { return w === a[idx]; }),
      cells: cells,
      missing: missing,
      extra: extra,
      changed: changed,
      targetWords: t,
      answerWords: a
    };
  },

  /** 听写时给下一个还没写对的词（用于“提示”按钮） */
  dictationHint: function (answerText, targetSentence) {
    const targetTokens = this.tokenize(targetSentence);
    const got = this.words(answerText);
    for (let i = 0; i < targetTokens.length; i++) {
      const c = this.core(targetTokens[i]);
      if (got[i] !== c) return targetTokens[i];
    }
    return "";
  },

  /** 从一篇文章里挑适合闯关的句子（3–22 个词），最多 limit 句 */
  pickFromArticle: function (item, limit) {
    const out = [];
    if (!item || !Array.isArray(item.sentences)) return out;
    const cap = limit || 12;
    for (let i = 0; i < item.sentences.length && out.length < cap; i++) {
      const en = this.plain(item.sentences[i]);
      const n = this.tokenize(en).length;
      if (n < 3 || n > 22) continue;
      out.push({
        en: en,
        zh: (item.zh && item.zh[i]) || "",
        hint: (item.notes && item.notes[i]) || "",
        tag: "文章抽句"
      });
    }
    return out;
  }
};

if (typeof window !== "undefined") {
  window.CHALLENGE_LEVELS = CHALLENGE_LEVELS;
  window.PatternCore = PatternCore;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { CHALLENGE_LEVELS: CHALLENGE_LEVELS, PatternCore: PatternCore };
}
