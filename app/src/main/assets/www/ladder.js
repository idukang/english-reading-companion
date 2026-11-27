/* =========================================================
   梯子模式 —— 撤掉支架的三阶阅读（纯函数）
   -----------------------------------------------------------
   方法论参考：byoungd/up《听力篇》《阅读篇》的「字幕是一架可以
   撤走的梯子」：先保存无支架首读/首听，再只打开足够解决问题的
   支架，最后关掉支架重构。这里把它做成阅读页可一键切换的三阶：

     ① 盲听首读：只靠声音和英文过一遍，中文与讲解全部收起
     ② 对照修复：放开中文、讲解与生词高亮，一句句修回去
     ③ 关译复述：重新收起中文，用自己的话复述

   本文件不碰 DOM、不联网、不读存储，方便自动化测试。
   ========================================================= */

const LADDER_STAGES = [
  {
    id: 1,
    key: "blind",
    name: "盲听首读",
    short: "① 盲听",
    emoji: "🙈",
    desc: "先只听、只看英文：中文对照和讲解都收起，遇到生词也别急着查，先把主线抓住。",
    showZh: false,
    showNotes: false,
    highlight: false,
    retell: false,
    blind: true
  },
  {
    id: 2,
    key: "repair",
    name: "对照修复",
    short: "② 对照",
    emoji: "🔍",
    desc: "放开中文和讲解、生词高亮；一句一句对回去，把刚才没听清的地方修好。",
    showZh: true,
    showNotes: true,
    highlight: true,
    retell: false,
    blind: false
  },
  {
    id: 3,
    key: "retell",
    name: "关译复述",
    short: "③ 复述",
    emoji: "🗣️",
    desc: "重新收起中文和讲解，用自己的话把这一篇说出来：发生了什么、你怎么看、下一步。",
    showZh: false,
    showNotes: false,
    highlight: false,
    retell: true,
    blind: false
  }
];

const Ladder = {
  stages: LADDER_STAGES,
  FIRST: 1,
  LAST: LADDER_STAGES.length,

  /** 只接受 1 / 2 / 3，其它值一律回到第 1 阶 */
  normalize: function (n) {
    const v = Number(n);
    return (v === 2 || v === 3) ? v : Ladder.FIRST;
  },

  /** 取某一阶的完整定义 */
  stage: function (n) {
    const id = Ladder.normalize(n);
    for (let i = 0; i < LADDER_STAGES.length; i++) {
      if (LADDER_STAGES[i].id === id) return LADDER_STAGES[i];
    }
    return LADDER_STAGES[0];
  },

  /** 某一阶对界面的影响：显示中文 / 讲解、生词高亮、复述卡、可遮蔽英文 */
  flags: function (n) {
    const s = Ladder.stage(n);
    return {
      showZh: s.showZh,
      showNotes: s.showNotes,
      highlight: s.highlight,
      retell: s.retell,
      blind: s.blind
    };
  },

  next: function (n) {
    const id = Ladder.normalize(n);
    return id >= Ladder.LAST ? Ladder.LAST : id + 1;
  },

  prev: function (n) {
    const id = Ladder.normalize(n);
    return id <= Ladder.FIRST ? Ladder.FIRST : id - 1;
  },

  isLast: function (n) { return Ladder.normalize(n) >= Ladder.LAST; },

  /** 存进本机档案的偏好：开关 + 上次停在哪一阶 */
  pref: function (on, n) {
    return { on: !!on, stage: Ladder.normalize(n) };
  },

  /** 把旧数据 / 手改的数据洗成合法偏好（缺省关闭、第 1 阶） */
  sanitize: function (raw) {
    const r = (raw && typeof raw === "object") ? raw : {};
    return Ladder.pref(!!r.on, r.stage);
  },

  /** 这一阶是否该显示中文（还要叠加全局「显示中文对照」开关） */
  zhVisible: function (bilingual, on, n) {
    if (!bilingual) return false;
    if (!on) return true;
    return Ladder.flags(n).showZh;
  },

  /** 这一阶是否该显示句子讲解（叠加全局「讲解」开关） */
  notesVisible: function (notes, on, n) {
    if (!notes) return false;
    if (!on) return true;
    return Ladder.flags(n).showNotes;
  },

  /** 这一阶是否把生词本里的词高亮 */
  highlightOn: function (on, n) {
    return !!on && Ladder.flags(n).highlight;
  }
};

if (typeof window !== "undefined") {
  window.LADDER_STAGES = LADDER_STAGES;
  window.Ladder = Ladder;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { LADDER_STAGES: LADDER_STAGES, Ladder: Ladder };
}
