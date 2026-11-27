/* =========================================================
   v1.7.0：🧠 生词主动回忆翻卡 + 错因分诊 的自动化测试
   —— 三档自评、只看英文/只听读音、错因分类、
      薄弱点写进记忆本并挂到生词上（下次优先复现）
   ========================================================= */

const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./harness.js");
const { Recall, ERROR_CAUSES, RECALL_RATINGS } = require("../app/src/main/assets/www/recall.js");

async function withApp(fn, opts) {
  const app = await h.boot(opts);
  try {
    await fn(app);
  } finally {
    app.win.close();
  }
}

function activeId(win) {
  return JSON.parse(win.localStorage.getItem("erc.profiles")).active;
}

function dataOf(win, key, id) {
  const raw = win.localStorage.getItem("erc.p." + (id || activeId(win)) + "." + key);
  return raw ? JSON.parse(raw) : null;
}

const SEED = {
  "erc.profiles": { active: "pR", list: [{ id: "pR", name: "R", emoji: "🧸", tier: "kids", speed: 1, voice: "neural", created: 1 }] },
  "erc.p.pR.vocab": [{ w: "apple", head: "apple", pos: "noun", zh: "苹果", ex: "I eat an apple.", ts: 1 }]
};

/* ------------------------- 纯函数 ------------------------- */

test("错因：三档自评与三类错因都齐全", function () {
  assert.deepEqual(RECALL_RATINGS.map(function (r) { return r.id; }), ["got", "fuzzy", "miss"]);
  assert.deepEqual(ERROR_CAUSES.map(function (c) { return c.id; }), ["form", "sound", "meaning"]);
  assert.equal(Recall.rating("got").quality, "good");
  assert.equal(Recall.rating("fuzzy").quality, "fuzzy");
  assert.equal(Recall.rating("miss").quality, "miss");
  assert.equal(Recall.rating("nope"), null);
  assert.equal(Recall.causeLabel("form"), "词形陌生");
  assert.equal(Recall.causeLabel("sound"), "听音辨识弱");
  assert.equal(Recall.causeLabel("meaning"), "义项混淆");
  assert.ok(Recall.causeTip("sound").length > 6);
});

test("错因分诊：选词/配对算义项，翻卡看文字算词形，只听读音算听音，听写看拼得像不像", function () {
  assert.equal(Recall.classify("blank"), "meaning");
  assert.equal(Recall.classify("match"), "meaning");
  assert.equal(Recall.classify("recall-text", "fuzzy"), "meaning");
  assert.equal(Recall.classify("recall-text", "miss"), "form");
  assert.equal(Recall.classify("recall-audio"), "sound");
  // 听写：拼得接近算词形（spelling），差得远算听音
  assert.equal(Recall.classify("dictation", { written: "schedual", target: "schedule" }), "form");
  assert.equal(Recall.classify("dictation", { written: "skedool", target: "schedule" }), "form");
  assert.equal(Recall.classify("dictation", { written: "something", target: "schedule" }), "sound");
  assert.equal(Recall.classify("dictation", { written: "", target: "schedule" }), "sound");
  assert.ok(Recall.similarity("schedule", "schedual") > 0.7);
  assert.ok(Recall.similarity("schedule", "banana") < 0.3);
});

test("错因：生成的薄弱点文字带错因标签、词和提示", function () {
  const t = Recall.weakText("schedule", "日程安排；时间表", "recall-text", "miss");
  assert.match(t, /词形陌生/);
  assert.match(t, /schedule/);
  assert.match(t, /日程安排/);
  const s = Recall.weakText("schedule", "日程安排", "recall-audio");
  assert.match(s, /听音辨识弱/);
  assert.match(s, /只听读音/);
  assert.equal(Recall.weakText("", "空"), "");
});

/* ------------------------- 界面 ------------------------- */

test("主动回忆：正面只给英文和读音按钮，不先给中文；翻面才出现三档自评", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-tab="vocab"]');
    h.clickSel(win, "#btnRecall");
    assert.equal(doc.getElementById("flashWrap").classList.contains("hidden"), false);
    assert.ok(doc.getElementById("flashCard").classList.contains("recall"));
    assert.equal(doc.getElementById("flashWord").textContent, "apple");
    assert.equal(doc.getElementById("flashIpa").textContent, "", "主动回忆正面不显示音标");
    assert.equal(doc.getElementById("flashBack").classList.contains("hidden"), true);
    assert.equal(doc.getElementById("flashRatings").classList.contains("hidden"), true);
    assert.equal(doc.getElementById("flashJudgeActs").classList.contains("hidden"), true);
    assert.match(doc.getElementById("flashPrompt").textContent, /想意思/);

    h.clickSel(win, "#flashCard");
    assert.equal(doc.getElementById("flashBack").classList.contains("hidden"), false);
    assert.equal(doc.getElementById("flashRatings").classList.contains("hidden"), false);
    assert.equal(doc.querySelectorAll("#flashRatings [data-rate]").length, 3);
    assert.match(doc.getElementById("flashZh").textContent, /苹果/);
  }, { storage: SEED });
});

test("主动回忆：选「没记住」会把词形陌生写进记忆本，并挂到生词上优先复现", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-tab="vocab"]');
    h.clickSel(win, "#btnRecall");
    h.clickSel(win, "#flashCard");
    h.click(win, doc.querySelector('#flashRatings [data-rate="miss"]'));

    const mem = dataOf(win, "memory");
    assert.equal(mem.length, 1);
    assert.equal(mem[0].type, "weak");
    assert.match(mem[0].text, /词形陌生/);
    assert.match(mem[0].text, /apple/);
    assert.equal(mem[0].src, "auto");

    const vocab = dataOf(win, "vocab");
    assert.equal(vocab[0].weak.cause, "form");
    assert.ok(vocab[0].weak.ts > 0);
    assert.equal(vocab[0].lapses, 1);
    assert.ok(vocab[0].dueAt > Date.now());

    // 列表上会显示薄弱点小标签
    assert.match(doc.querySelector("#vocabList .v-weak").textContent, /词形陌生/);
  }, { storage: SEED });
});

test("主动回忆：模糊 → 义项混淆、间隔不拉长；想起来了 → 不写薄弱点", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-tab="vocab"]');
    h.clickSel(win, "#btnRecall");
    h.clickSel(win, "#flashCard");
    h.click(win, doc.querySelector('#flashRatings [data-rate="fuzzy"]'));

    let mem = dataOf(win, "memory");
    assert.equal(mem.length, 1);
    assert.match(mem[0].text, /义项混淆/);
    let vocab = dataOf(win, "vocab");
    assert.equal(vocab[0].weak.cause, "meaning");
    assert.equal(vocab[0].intervalDays, 1, "模糊只排到明天，不按 1/3/7 往上拉");
    assert.equal(vocab[0].lapses || 0, 0);

    // 再点一次「想起来了」：间隔拉长，不会新增薄弱点
    h.clickSel(win, "#flashCard");
    h.click(win, doc.querySelector('#flashRatings [data-rate="got"]'));
    mem = dataOf(win, "memory");
    assert.equal(mem.length, 1, "想起来了不应再写一条");
    vocab = dataOf(win, "vocab");
    assert.equal(vocab[0].reps, 2);
    assert.equal(vocab[0].intervalDays, 3, "第二次记住应按 1 → 3 天");
  }, { storage: SEED });
});

test("主动回忆：只听读音没想起来 → 记成听音辨识弱", async function () {
  await withApp(async function ({ win, doc, calls }) {
    h.clickSel(win, '[data-tab="vocab"]');
    h.clickSel(win, "#btnRecall");
    h.clickSel(win, "#btnRecallEar");
    assert.equal(doc.getElementById("flashWord").textContent, "👂");
    assert.ok(calls.speak.length >= 1, "应该播放读音");
    assert.match(doc.getElementById("flashPrompt").textContent, /只听读音/);

    h.clickSel(win, "#flashCard");
    h.click(win, doc.querySelector('#flashRatings [data-rate="miss"]'));
    const mem = dataOf(win, "memory");
    assert.match(mem[0].text, /听音辨识弱/);
    assert.equal(dataOf(win, "vocab")[0].weak.cause, "sound");
  }, { storage: SEED });
});

test("选词填空选错：薄弱点按「义项混淆」沉淀", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-tab="pattern"]');
    h.click(win, doc.querySelector('#qzTabs [data-qz="blank"]'));
    h.clickSel(win, "#btnQzBlankStart");
    const q = win.App.inspect.Quiz.session.deck[0];
    const wrong = q.options.filter(function (o) { return !o.ok; })[0].w;
    const btn = doc.querySelector('#qzBlankOptions .qz-opt[data-w="' + wrong + '"]');
    h.click(win, btn);

    const mem = dataOf(win, "memory");
    assert.equal(mem.length, 1);
    assert.match(mem[0].text, /义项混淆/);
    assert.match(mem[0].text, /选词填空/);
    assert.match(mem[0].text, new RegExp(q.word));
  });
});
