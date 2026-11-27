/* =========================================================
   CEFR 快速定级 + 本轮小任务卡（纯函数）
   -----------------------------------------------------------
   方法论参考：byoungd/up《CEFR 目标与英语能力自测》
   —— 用「在具体情境中能完成什么任务」定起点，而不是词汇量；
   定级之后把结果翻成训练参数：按级加词、选词填空、外教难度与
   语速建议、一张可以换的小任务卡。

   · 6 道题 = 4 道场景自评 + 2 道微测，总分 0–18，定出 A1–B2。
   · 本文件不碰 DOM、不联网、不读存储，方便自动化测试。
   ========================================================= */

const PLACEMENT_QUESTIONS = [
  {
    id: "listen30",
    tag: "听力",
    q: "听一段 30 秒的日常对话（正常语速、没有字幕），对方在讲周末安排。你能——",
    opts: [
      { t: "只抓到几个熟悉的词，抓不住安排", v: 0 },
      { t: "听出大致在讲周末，但时间地点不确定", v: 1 },
      { t: "听出他要去哪、和谁、几点，个别词要猜", v: 2 },
      { t: "基本全听懂，还能听出他其实不太想去", v: 3 }
    ]
  },
  {
    id: "micro-delay",
    tag: "微测 · 阅读",
    q: "“The flight was delayed by two hours.” 这句话的意思是——",
    opts: [
      { t: "航班要飞两个小时", v: 1 },
      { t: "航班晚点两小时", v: 3 },
      { t: "航班提前两小时起飞", v: 0 },
      { t: "航班换了登机口", v: 0 }
    ]
  },
  {
    id: "read300",
    tag: "阅读",
    q: "读一篇 300 词左右的英文短文（产品说明或新闻）。你能——",
    opts: [
      { t: "只认得几个词，整体不知道在说什么", v: 0 },
      { t: "知道大致主题，但分不清作者的主张和例子", v: 1 },
      { t: "能说出主旨和两三个细节，长句要回看", v: 2 },
      { t: "一遍读完能说出主旨、依据和作者的保留", v: 3 }
    ]
  },
  {
    id: "speak3min",
    tag: "口语",
    q: "和一位外国同事聊 3 分钟周末安排。你能——",
    opts: [
      { t: "只会 yes / no 或单个词", v: 0 },
      { t: "能说简单短句，常停下来想词", v: 1 },
      { t: "能连着说几句，卡住时会换个说法继续", v: 2 },
      { t: "能自然接话、追问，还听得出对方没听懂并修复", v: 3 }
    ]
  },
  {
    id: "micro-again",
    tag: "微测 · 互动",
    q: "对话里对方说 “Sorry, could you say that again?” 最可能的意思是——",
    opts: [
      { t: "请你再说一遍", v: 3 },
      { t: "请你大声一点", v: 1 },
      { t: "请你写下来", v: 0 },
      { t: "请你换一种语言", v: 0 }
    ]
  },
  {
    id: "video1min",
    tag: "听力",
    q: "看一段 1 分钟的无字幕英文 vlog。你能——",
    opts: [
      { t: "只能靠画面猜在做什么", v: 0 },
      { t: "听到零散词句，能猜出大概在做什么", v: 1 },
      { t: "能跟上主线，偶尔漏掉一两句", v: 2 },
      { t: "能跟上主线，还听得出语气和笑点", v: 3 }
    ]
  }
];

/* 定级结果 → 训练参数（按级加词、选词填空、外教语速与难度建议） */
const PLACEMENT_INFO = {
  A1: {
    lv: "A1",
    label: "A1 · 入门",
    desc: "能理解并使用非常常见的表达；对方说得慢、愿意帮忙时，可以做简单互动。",
    speed: 0.75,
    vocab: "A1",
    quiz: "A1",
    tutor: "用最常见的词和 5–10 词的短句，一次只问一个问题；必要时先给中文提示再给英文。"
  },
  A2: {
    lv: "A2",
    label: "A2 · 基础",
    desc: "能处理个人信息、购物、地点、工作等熟悉主题的直接交流。",
    speed: 0.9,
    vocab: "A2",
    quiz: "A2",
    tutor: "用常用词和 8–14 词的短句，围绕熟悉话题；一次最多两个新表达，说完主动确认你听懂了没有。"
  },
  B1: {
    lv: "B1",
    label: "B1 · 进阶",
    desc: "能理解熟悉主题的主要意思；在旅行与日常场景中应对，并简单说明经历、计划和理由。",
    speed: 1.0,
    vocab: "B1",
    quiz: "B1",
    tutor: "正常语速和日常词汇，多追问理由与细节；只在你卡住时换简单说法，不要整段降级成入门英语。"
  },
  B2: {
    lv: "B2",
    label: "B2 · 高阶",
    desc: "能理解具体或抽象复杂文本的主要观点；与熟练使用者较自然地互动，并清楚表达立场。",
    speed: 1.1,
    vocab: "B2",
    quiz: "B2",
    tutor: "正常到略快语速，可以用抽象话题与地道的词块；像真实对话那样打断、追问和表达不同意见。"
  }
};

/* 小任务卡：按定级结果挑，高等级也能看到低等级的任务（可重复练） */
const TASK_CARDS = [
  { id: "clear3", min: "A1", text: "用 3 轮把一件事说清楚：发生了什么、你怎么想、接下来怎么办。", tip: "先说 what happened，再说 I think…，最后说 next…" },
  { id: "confirm", min: "A1", text: "做一次没听清时的礼貌确认：请对方把最后一句再说一遍。", tip: "Could you say the last part again?" },
  { id: "twoWords", min: "A1", text: "用今天刚学的 2 个词，各造一个自己的句子。", tip: "短句就行，说完整比说漂亮重要。" },
  { id: "split", min: "A2", text: "把一句长句拆成两句短句说出来，意思不变。", tip: "先讲谁/什么，再讲发生了什么。" },
  { id: "number", min: "A2", text: "让对方重复一个数字或时间，并确认一次。", tip: "So it's at seven, right?" },
  { id: "because", min: "A2", text: "用 because 给自己的一个观点补两条理由。", tip: "I prefer… because… and also…" },
  { id: "retell", min: "B1", text: "听外教说完一段，用自己的话复述 3 句，不照抄原句。", tip: "先主旨，再两个细节。" },
  { id: "anotherWay", min: "B1", text: "同一个意思换两种说法：一种简单，一种更正式。", tip: "比较 kids / children / minors 这类差别。" },
  { id: "unknown", min: "B1", text: "问一个你真正不知道的问题，再把答案复述一遍确认。", tip: "So you mean…? Did I get that right?" },
  { id: "conclusion", min: "B2", text: "先说结论再说理由，最后补一句限制或例外。", tip: "The main point is… because… though…" },
  { id: "polite", min: "B2", text: "同一件事对朋友说一遍、对客户说一遍，语气各不同。", tip: "比较 Can you… 和 Would you be able to…" }
];

const Placement = {
  levels: ["A1", "A2", "B1", "B2"],
  questions: PLACEMENT_QUESTIONS,
  info: PLACEMENT_INFO,
  tasks: TASK_CARDS,

  isLevel: function (lv) {
    return Placement.levels.indexOf(String(lv || "").toUpperCase()) >= 0;
  },

  levelIndex: function (lv) {
    return Placement.levels.indexOf(String(lv || "").toUpperCase());
  },

  /** 单题答案的分数（非法选项按 0 分） */
  scoreOf: function (qIndex, optIndex) {
    const q = PLACEMENT_QUESTIONS[qIndex];
    if (!q) return 0;
    const o = q.opts[optIndex];
    return o ? Math.max(0, Math.min(3, Number(o.v) || 0)) : 0;
  },

  /** 一次作答的总分（数组里存的是选项下标） */
  score: function (answers) {
    const arr = Array.isArray(answers) ? answers : [];
    let total = 0;
    for (let i = 0; i < PLACEMENT_QUESTIONS.length; i++) {
      total += Placement.scoreOf(i, arr[i]);
    }
    return total;
  },

  answered: function (answers) {
    const arr = Array.isArray(answers) ? answers : [];
    let n = 0;
    for (let i = 0; i < PLACEMENT_QUESTIONS.length; i++) {
      if (typeof arr[i] === "number" && arr[i] >= 0 && PLACEMENT_QUESTIONS[i].opts[arr[i]]) n++;
    }
    return n;
  },

  /** 总分 → 等级（0–5 A1 / 6–10 A2 / 11–14 B1 / 15–18 B2） */
  levelFromScore: function (score) {
    const n = Math.max(0, Number(score) || 0);
    if (n <= 5) return "A1";
    if (n <= 10) return "A2";
    if (n <= 14) return "B1";
    return "B2";
  },

  level: function (answers) {
    return Placement.levelFromScore(Placement.score(answers));
  },

  /** 取某一级的训练参数；非法等级回落到 A1 */
  infoOf: function (lv) {
    const key = String(lv || "").toUpperCase();
    return PLACEMENT_INFO[key] || PLACEMENT_INFO.A1;
  },

  /** 定级后给外教的难度指令；没有定级返回空串 */
  tutorBlock: function (lv) {
    if (!Placement.isLevel(lv)) return "";
    const info = Placement.infoOf(lv);
    return "\n\n【学生水平 · CEFR " + info.lv + "】\n" +
      info.label + "：" + info.desc + "\n" +
      "请按这个水平调整：" + info.tutor +
      "\n不要因为学生说中文就整段改用中文；英文部分保持可理解但略高于舒适区。";
  },

  /** 这个等级能看到的小任务卡（低等级的任务也保留，方便反复练） */
  taskDeck: function (lv) {
    const idx = Placement.levelIndex(lv);
    const max = idx < 0 ? 0 : idx;
    return TASK_CARDS.filter(function (c) { return Placement.levelIndex(c.min) <= max; });
  },

  /** 换一张：尽量不重复当前这张 */
  pickTask: function (lv, currentId, rnd) {
    const deck = Placement.taskDeck(lv);
    if (!deck.length) return null;
    const pool = deck.filter(function (c) { return c.id !== currentId; });
    const list = pool.length ? pool : deck;
    const random = typeof rnd === "function" ? rnd : Math.random;
    return list[Math.floor(random() * list.length)];
  },

  taskById: function (id) {
    for (let i = 0; i < TASK_CARDS.length; i++) {
      if (TASK_CARDS[i].id === id) return TASK_CARDS[i];
    }
    return null;
  }
};

if (typeof window !== "undefined") {
  window.PLACEMENT_QUESTIONS = PLACEMENT_QUESTIONS;
  window.PLACEMENT_INFO = PLACEMENT_INFO;
  window.TASK_CARDS = TASK_CARDS;
  window.Placement = Placement;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    PLACEMENT_QUESTIONS: PLACEMENT_QUESTIONS,
    PLACEMENT_INFO: PLACEMENT_INFO,
    TASK_CARDS: TASK_CARDS,
    Placement: Placement
  };
}
