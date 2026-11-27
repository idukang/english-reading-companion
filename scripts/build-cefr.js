#!/usr/bin/env node
/* =========================================================
   生成 app/src/main/assets/www/cefr.js（CEFR 分级词库）
   -----------------------------------------------------------
   数据来源：
     · pretzelai/openlingo（MIT）words/english.json 的 CEFR 等级、词性、
       词频与例句；致谢写在 README 与生成文件的文件头里。
     · 本项目 dict.js 的中文简明释义与中文例句翻译。
     · 少量补充词（下面 SUPPLEMENT）只写中文释义，等级 / 词性 / 例句
       仍取自 openlingo，避免手工编造。
   只保留「词 + 等级 + 词性 + 中文 + 例句」这几列，体积约 70–90 KB，
   不把 6 MB 的全量词表塞进 APK。

   用法（仓库里已提交生成结果，日常构建不需要跑）：
     node scripts/build-cefr.js [path/to/english.json]
   默认路径：../audit-tmp/openlingo/words/english.json
   ========================================================= */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const WWW = path.join(ROOT, "app", "src", "main", "assets", "www");
const SRC = process.argv[2] || path.join(ROOT, "..", "audit-tmp", "openlingo", "words", "english.json");
const OUT = path.join(WWW, "cefr.js");

/* ---------- 1. 读本项目的 dict.js ---------- */
function readDict() {
  const code = fs.readFileSync(path.join(WWW, "dict.js"), "utf8");
  const ctx = { DICT: null };
  vm.createContext(ctx);
  vm.runInContext(code + "\n;this.DICT = DICT;", ctx);
  return ctx.DICT;
}

/* ---------- 2. 读 openlingo 词表 ---------- */
function readOpenlingo() {
  const list = JSON.parse(fs.readFileSync(SRC, "utf8"));
  const map = {};
  list.forEach(function (e) {
    const w = String(e.word || "").toLowerCase().trim();
    if (!/^[a-z]+$/.test(w)) return;
    const prev = map[w];
    // 同一个词可能有多条记录：优先有用的、带例句的、词频更靠前的
    const score = function (x) {
      return (x.useful_for_flashcard ? 2 : 0) + (x.example_sentence_english ? 1 : 0) - (x.word_frequency || 9999) / 100000;
    };
    if (!prev || score(e) > score(prev)) map[w] = e;
  });
  return map;
}

/* ---------- 3. 补充词：只补中文释义 ---------- */
/* openlingo 里已有等级 / 词性与例句，这里只写中文，不重复造数据 */
const SUPPLEMENT = {
  /* A2 */
  apply: "申请；应用", arrange: "安排", celebrate: "庆祝", communicate: "交流；沟通",
  complain: "抱怨", depend: "取决于；依靠", discover: "发现", environment: "环境",
  explain: "解释", gather: "聚集", honest: "诚实的", imagine: "想象",
  polite: "有礼貌的", prepare: "准备", purpose: "目的", realize: "意识到",
  recognize: "认出；承认", relax: "放松", remind: "提醒", reply: "回复",
  respond: "回应", seem: "似乎", serious: "严肃的；严重的", situation: "情况",
  succeed: "成功", useful: "有用的", warn: "警告", weight: "重量",
  curious: "好奇的", amount: "数量", argue: "争论",
  /* B1 */
  afford: "负担得起", allow: "允许", announce: "宣布", appreciate: "感激；欣赏",
  avoid: "避免", aware: "意识到的", balance: "平衡", compare: "比较",
  contain: "包含", convenient: "方便的", culture: "文化", deliver: "递送；交付",
  describe: "描述", destroy: "毁坏", develop: "发展；开发", discuss: "讨论",
  familiar: "熟悉的", foreign: "外国的", frequent: "频繁的", increase: "增加",
  influence: "影响", insist: "坚持", intend: "打算", limit: "限制",
  manage: "设法做到；管理", mention: "提到", nervous: "紧张的", notice: "注意到；告示",
  obvious: "明显的", organize: "组织", patient: "病人；有耐心的", perform: "表演；执行",
  prevent: "阻止", promise: "承诺", protect: "保护", quality: "质量",
  recommend: "推荐", reduce: "减少", refuse: "拒绝", regret: "后悔",
  respect: "尊重", responsible: "负责的", satisfy: "使满意", share: "分享；份额",
  similar: "相似的", suggest: "建议", trust: "信任", truth: "真相",
  unusual: "不寻常的", upset: "难过的；心烦的", value: "价值", various: "各种各样的",
  volunteer: "志愿者", waste: "浪费", wonder: "想知道；奇迹", achieve: "实现；达到",
  adapt: "适应", advantage: "优势", approach: "方法；接近", attitude: "态度",
  benefit: "好处；受益", challenge: "挑战", concentrate: "集中注意力", confident: "自信的",
  consider: "考虑", convince: "说服", decade: "十年", define: "给……下定义",
  demand: "需求；要求", demonstrate: "演示；证明", encourage: "鼓励", essential: "必不可少的",
  eventually: "最终", expand: "扩大", flexible: "灵活的", forecast: "预报",
  generous: "大方的", gradually: "逐渐地", hesitate: "犹豫", identify: "辨认出",
  impressive: "令人印象深刻的", maintain: "保持；维持", participate: "参加", persuade: "说服",
  priority: "优先事项", tend: "往往会", urgent: "紧急的", vary: "变化；不同",
  analyse: "分析",
  /* B2 */
  complex: "复杂的", consequence: "后果", decline: "下降；拒绝", efficient: "高效的",
  emerge: "出现", establish: "建立", evidence: "证据", guarantee: "保证",
  individual: "个人的；个体", inevitable: "不可避免的", interpret: "解释；口译",
  negotiate: "谈判", opportunity: "机会", perspective: "观点；视角", precise: "精确的",
  pursue: "追求", reliable: "可靠的", remarkable: "非凡的", resource: "资源",
  significant: "显著的；重要的", strategy: "策略", sufficient: "足够的", tolerate: "容忍",
  unique: "独一无二的", vital: "至关重要的", witness: "目击者；见证", assess: "评估",
  assume: "假设；认为", require: "需要；要求", potential: "潜力；潜在的", principle: "原则",
  procedure: "程序；步骤", reveal: "揭示", recover: "恢复", seek: "寻找",
  sustain: "维持", transfer: "转移", undertake: "承担", welfare: "福利",
  whereas: "而；然而（对比）"
};

/* ---------- 4. 工具 ---------- */

/* 这些词进词典标签没问题，但拿来出题（选词填空 / 配对 / 按级加词）没意义 */
const NOT_PRACTICE = new Set([
  "a", "an", "the", "and", "or", "but", "if", "because", "so", "than", "that", "this",
  "these", "those", "there", "here", "when", "where", "why", "how", "what", "who",
  "which", "whether", "while", "as", "of", "to", "in", "on", "at", "by", "for", "from",
  "with", "about", "after", "before", "during", "under", "until", "since", "up", "down",
  "off", "out", "into", "over", "all", "any", "some", "no", "not", "only", "then", "too",
  "very", "just", "also", "else", "already", "yet", "still", "ever", "never",
  "i", "me", "my", "we", "us", "our", "you", "your", "he", "him", "his", "she", "her",
  "it", "its", "they", "them", "their", "myself", "yourself", "themselves", "everyone",
  "everything", "something", "anything", "nothing", "nobody", "someone", "anyone",
  "be", "am", "is", "are", "was", "were", "have", "has", "had", "do", "does", "did",
  "can", "could", "will", "would", "shall", "should", "may", "might", "must", "cannot",
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "hundred", "thirty", "first", "second", "third", "eighth", "forty", "ok", "okay",
  "yes", "hi", "hello", "goodbye", "bye", "please", "thanks", "thank", "sorry", "well",
  "monday", "saturday", "friday", "yesterday", "today", "tomorrow", "now", "o'clock",
  /* 书里出现但不适合当练习词的道具词 */
  "sleeper", "wag", "standup", "self", "renew", "lin", "tom", "amy", "li", "wang", "wei",
  "english", "yuan", "latte", "croissant"
]);

const FUNCTION_POS = /^(art|prep|pron|conj|det|aux|numeral|interj|particle)\./i;

const POS_ALIAS = {
  n: "noun", nouns: "noun", v: "verb", verbs: "verb", adj: "adjective",
  adjective: "adjective", adv: "adverb", adverb: "adverb", prep: "preposition",
  pron: "pronoun", conj: "conjunction", num: "numeral"
};

function posOf(p) {
  const raw = String(p || "").trim().toLowerCase().replace(/[.。]/g, "");
  return POS_ALIAS[raw] || raw;
}

function usable(word, pos) {
  if (!word) return false;
  if (NOT_PRACTICE.has(word)) return false;
  if (FUNCTION_POS.test(posOf(pos))) return false;
  return true;
}

/* 例句里是否原样出现这个词（只认原形，避免把 destroyed 挖空后选项却是 destroy） */
function blankForm(sentence, word) {
  const tokens = String(sentence || "").match(/[A-Za-z]+(?:['’][A-Za-z]+)*/g) || [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].toLowerCase() === word) return tokens[i];
  }
  return "";
}

function cleanZh(zh) {
  return String(zh || "").replace(/\s+/g, " ").trim();
}

/* ---------- 5. 组装 ---------- */
function build() {
  const DICT = readDict();
  const OL = readOpenlingo();
  const rows = [];
  const seen = new Set();

  function push(word, ol, zh, ex, exZh) {
    const w = String(word || "").toLowerCase();
    if (!w || seen.has(w)) return;
    const lv = String(ol && ol.cefr_level || "").toUpperCase();
    if (["A1", "A2", "B1", "B2"].indexOf(lv) < 0) return;
    const pos = posOf(ol.pos);
    const freq = Number(ol.word_frequency) || 99999;

    // 例句优选：短、且原样包含这个词的句子
    let sentence = "";
    let trans = "";
    const candidates = [];
    if (ex) candidates.push({ s: ex, t: exZh || "" });
    if (ol.example_sentence_english) candidates.push({ s: ol.example_sentence_english, t: "" });
    candidates.sort(function (a, b) {
      const wa = (a.s.match(/\s+/g) || []).length;
      const wb = (b.s.match(/\s+/g) || []).length;
      return wa - wb;
    });
    let form = "";
    for (let i = 0; i < candidates.length; i++) {
      const f = blankForm(candidates[i].s, w);
      if (f) { sentence = candidates[i].s; trans = candidates[i].t; form = f; break; }
    }
    if (!sentence && candidates.length) { sentence = candidates[0].s; trans = candidates[0].t; }

    seen.add(w);
    rows.push({
      w: w,
      lv: lv,
      p: pos,
      z: cleanZh(zh),
      e: cleanZh(sentence),
      ez: cleanZh(trans),
      b: form ? form.toLowerCase() : "",
      f: freq,
      u: usable(w, pos)
    });
  }

  Object.keys(DICT).forEach(function (w) {
    const ol = OL[w];
    if (!ol) return;
    const d = DICT[w];
    push(w, ol, d.z, d.e, d.ez);
  });

  Object.keys(SUPPLEMENT).forEach(function (w) {
    const ol = OL[w];
    if (!ol) return;
    push(w, ol, SUPPLEMENT[w], "", "");
  });

  const order = { A1: 0, A2: 1, B1: 2, B2: 3 };
  rows.sort(function (a, b) {
    if (order[a.lv] !== order[b.lv]) return order[a.lv] - order[b.lv];
    if (a.f !== b.f) return a.f - b.f;
    return a.w < b.w ? -1 : (a.w > b.w ? 1 : 0);
  });

  const counts = {};
  rows.forEach(function (r) { counts[r.lv] = (counts[r.lv] || 0) + 1; });

  const lines = [];
  lines.push("/* =========================================================");
  lines.push("   CEFR 分级词库（A1 / A2 / B1 / B2）—— 自动生成，请勿手改");
  lines.push("   ---------------------------------------------------------");
  lines.push("   生成命令：node scripts/build-cefr.js <openlingo/words/english.json>");
  lines.push("   等级、词性、词频与英文例句来自 pretzelai/openlingo（MIT 协议），");
  lines.push("   中文释义与例句翻译来自本项目 dict.js（部分补充词的中文为原创）。");
  lines.push("   只保留学习所需的几列，不打包 6 MB 全量词表。");
  lines.push("   字段：w 单词  lv 等级  p 词性  z 中文释义  e 英文例句  ez 例句中文");
  lines.push("         b 例句里的原形（空 = 不适合做挖空题）  f 词频序号  u 能否用于出题");
  lines.push("   ========================================================= */");
  lines.push("");
  lines.push("const CEFR_LEVELS = [\"A1\", \"A2\", \"B1\", \"B2\"];");
  lines.push("");
  lines.push("const CEFR_WORDS = [");
  rows.forEach(function (r) {
    const parts = [
      "w:" + JSON.stringify(r.w),
      "lv:" + JSON.stringify(r.lv),
      "p:" + JSON.stringify(r.p),
      "z:" + JSON.stringify(r.z)
    ];
    if (r.e) parts.push("e:" + JSON.stringify(r.e));
    if (r.ez) parts.push("ez:" + JSON.stringify(r.ez));
    if (r.b) parts.push("b:" + JSON.stringify(r.b));
    parts.push("f:" + r.f);
    if (!r.u) parts.push("u:false");
    lines.push("  { " + parts.join(", ") + " },");
  });
  lines.push("];");
  lines.push("");
  lines.push("const CEFR_INDEX = {};");
  lines.push("CEFR_WORDS.forEach(function (e) { if (!CEFR_INDEX[e.w]) CEFR_INDEX[e.w] = e; });");
  lines.push("");
  lines.push("const CEFR = {");
  lines.push("  levels: CEFR_LEVELS,");
  lines.push("  all: CEFR_WORDS,")
  lines.push("  counts: " + JSON.stringify(counts) + ",");
  lines.push("");
  lines.push("  /** 查一个词的等级（按原形；查不到返回空串） */");
  lines.push("  levelOf: function (word) {");
  lines.push("    const e = this.entry(word);");
  lines.push("    return e ? e.lv : \"\";");
  lines.push("  },");
  lines.push("");
  lines.push("  entry: function (word) {");
  lines.push("    const w = String(word == null ? \"\" : word).toLowerCase().replace(/[’]/g, \"'\")");
  lines.push("      .replace(/^[^a-z']+|[^a-z']+$/g, \"\");");
  lines.push("    return w ? (CEFR_INDEX[w] || null) : null;");
  lines.push("  },");
  lines.push("");
  lines.push("  /** 某个等级里能拿来出题 / 加词的词条 */");
  lines.push("  pool: function (lv) {");
  lines.push("    return CEFR_WORDS.filter(function (e) { return e.lv === lv && e.u !== false; });");
  lines.push("  }");
  lines.push("};");
  lines.push("");
  lines.push("if (typeof window !== \"undefined\") {");
  lines.push("  window.CEFR_WORDS = CEFR_WORDS;");
  lines.push("  window.CEFR = CEFR;");
  lines.push("}");
  lines.push("if (typeof module !== \"undefined\" && module.exports) {");
  lines.push("  module.exports = { CEFR_LEVELS: CEFR_LEVELS, CEFR_WORDS: CEFR_WORDS, CEFR: CEFR };");
  lines.push("}");
  lines.push("");

  fs.writeFileSync(OUT, lines.join("\n"), "utf8");
  console.log("写入 " + path.relative(ROOT, OUT));
  console.log("总词条 " + rows.length + "，分级：" + JSON.stringify(counts));
  console.log("可用于出题：" + JSON.stringify(CEFR_levels(rows)) + "");
  console.log("体积 " + (fs.statSync(OUT).size / 1024).toFixed(1) + " KB");
}

function CEFR_levels(rows) {
  const c = {};
  rows.forEach(function (r) { if (r.u) c[r.lv] = (c[r.lv] || 0) + 1; });
  return c;
}

build();
