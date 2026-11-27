/* =========================================================
   v1.6.0：选词填空 + 英汉配对 的自动化测试
   —— 纯函数出题 + jsdom 里的真实点击与统计
   ========================================================= */

const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./harness.js");
const { QuizCore } = require("../app/src/main/assets/www/quiz.js");
const { CEFR } = require("../app/src/main/assets/www/cefr.js");

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

function quizData(win, id) {
  const raw = win.localStorage.getItem("erc.p." + (id || activeId(win)) + ".quiz");
  return raw ? JSON.parse(raw) : null;
}

function memoryData(win, id) {
  const raw = win.localStorage.getItem("erc.p." + (id || activeId(win)) + ".memory");
  return raw ? JSON.parse(raw) : [];
}

function optionButtons(doc) {
  return Array.from(doc.querySelectorAll("#qzBlankOptions .qz-opt"));
}

function clickOption(win, doc, word) {
  const b = optionButtons(doc).filter(function (x) { return x.dataset.w === word; })[0];
  assert.ok(b, "选项里应该有：" + word);
  h.click(win, b);
  return b;
}

/* ------------------------- 纯函数 ------------------------- */

test("选词填空出题：挖空原形词，四个选项同词性、意思互不重复", function () {
  const pool = CEFR.pool("A1");
  let made = 0;
  pool.forEach(function (e) {
    const q = QuizCore.buildBlank(e, pool, Math.random, CEFR.all);
    if (!q) return;
    made++;
    assert.match(q.sentence, /____/, "句子应该被挖空：" + e.w);
    assert.equal(q.sentence.toLowerCase().indexOf(" " + q.form.toLowerCase() + " ") >= 0, false);
    assert.equal(q.options.length, 4);
    assert.equal(q.options.filter(function (o) { return o.ok; }).length, 1);
    assert.equal(q.word, e.w);
    assert.ok(q.zh);
    const zh = q.options.map(function (o) { return o.w; });
    assert.equal(new Set(zh).size, 4, "选项不应重复");
  });
  assert.ok(made >= 150, "A1 至少应有 150 道可出的题，实际 " + made);
});

test("选词填空出题：干扰项与答案同词性", function () {
  const pool = CEFR.pool("A2");
  let checked = 0;
  pool.forEach(function (e) {
    const q = QuizCore.buildBlank(e, pool, Math.random, CEFR.all);
    if (!q) return;
    checked++;
    const entry = CEFR.entry(q.word);
    q.options.forEach(function (o) {
      if (o.ok) return;
      const other = CEFR.entry(o.w);
      assert.ok(other, "干扰项应在词库里：" + o.w);
      assert.equal(other.p, entry.p, o.w + " 应与 " + e.w + " 同词性");
    });
  });
  assert.ok(checked >= 80, "A2 应能出足够多的题，实际 " + checked);
});

test("英汉配对：一轮 5 组，左右两列都是同一批配对编号", function () {
  const round = QuizCore.buildMatch(CEFR.pool("A1"), 5, Math.random);
  assert.ok(round);
  assert.equal(round.pairs.length, 5);
  assert.equal(new Set(round.pairs.map(function (p) { return p.w; })).size, 5);
  assert.equal(new Set(round.pairs.map(function (p) { return p.zh; })).size, 5);
  assert.deepEqual(round.left.map(function (p) { return p.i; }).sort(), [0, 1, 2, 3, 4]);
  assert.deepEqual(round.right.map(function (p) { return p.i; }).sort(), [0, 1, 2, 3, 4]);
  assert.equal(QuizCore.match(0, 0), true);
  assert.equal(QuizCore.match(0, 1), false);
  assert.equal(QuizCore.match(null, 0), false);
});

test("英汉配对：词不够时也能出 2 组，不会卡死", function () {
  const few = CEFR.pool("B2").slice(0, 3);
  const round = QuizCore.buildMatch(few, 5, Math.random);
  assert.ok(round);
  assert.equal(round.pairs.length, 3);
  assert.equal(QuizCore.buildMatch([], 5), null);
  assert.equal(QuizCore.buildMatch(few.slice(0, 1), 5), null);
});

/* ------------------------- 选词填空界面 ------------------------- */

test("闯关页三个入口清晰并列，选词填空能开局", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-tab="pattern"]');
    const tabs = doc.querySelectorAll("#qzTabs button");
    assert.equal(tabs.length, 3);
    assert.match(tabs[0].textContent, /句型闯关/);
    assert.match(tabs[1].textContent, /选词填空/);
    assert.match(tabs[2].textContent, /英汉配对/);
    // 默认还是句型闯关
    assert.equal(doc.getElementById("qzPatternPane").classList.contains("hidden"), false);

    h.click(win, tabs[1]);
    assert.equal(doc.getElementById("qzBlankPane").classList.contains("hidden"), false);
    assert.equal(doc.getElementById("qzPatternPane").classList.contains("hidden"), true);
    assert.equal(doc.querySelectorAll("#qzBlankLevelSeg button").length, 4);

    h.clickSel(win, "#btnQzBlankStart");
    assert.equal(doc.getElementById("qzBlankPlay").classList.contains("hidden"), false);
    assert.equal(doc.getElementById("pzHome").classList.contains("hidden"), true);
    assert.equal(optionButtons(doc).length, 4);
    assert.match(doc.getElementById("qzBlankProgress").textContent, /第 1 \/ 10 题/);
    assert.match(doc.getElementById("qzBlankSentence").textContent, /＿＿/);
    assert.match(doc.getElementById("qzBlankTitle").textContent, /选词填空 · A1/);
  });
});

test("选词填空：点对给正反馈、记成绩、加进已做词表，还能收进生词本", async function () {
  await withApp(async function ({ win, doc, calls }) {
    h.clickSel(win, '[data-tab="pattern"]');
    h.click(win, doc.querySelector('#qzTabs [data-qz="blank"]'));
    h.clickSel(win, "#btnQzBlankStart");
    const s = win.App.inspect.Quiz.session;
    const q = s.deck[0];

    clickOption(win, doc, q.form);
    const fb = doc.getElementById("qzBlankFeedback");
    assert.equal(fb.classList.contains("hidden"), false);
    assert.match(fb.textContent, /选对了/);
    assert.match(fb.textContent, new RegExp(q.form));
    assert.ok(fb.textContent.indexOf(q.zh.slice(0, 2)) >= 0, "反馈里应有中文释义");
    assert.equal(doc.querySelector("#qzBlankOptions .qz-opt.ok").dataset.w, q.form);
    optionButtons(doc).forEach(function (b) { assert.equal(b.disabled, true); });
    assert.ok(calls.oscillators >= 3, "选对应该用 Web Audio 合成提示音");

    const data = quizData(win);
    assert.equal(data.blank.attempts, 1);
    assert.equal(data.blank.correct, 1);
    assert.deepEqual(data.blank.byLevel.A1.done, [q.word]);

    // 整句发音
    h.click(win, doc.querySelector('#qzBlankFeedback [data-qz="speak"]'));
    assert.equal(calls.speak[calls.speak.length - 1].text, s.deck[0].sentence.replace(/____/, q.form));

    // 加入生词本
    h.click(win, doc.querySelector('#qzBlankFeedback [data-qz="add"]'));
    const vocab = JSON.parse(win.localStorage.getItem("erc.p." + activeId(win) + ".vocab"));
    assert.equal(vocab.length, 1);
    assert.equal(vocab[0].w, q.form.toLowerCase());
    assert.equal(vocab[0].lv, q.lv);

    // 下一题
    h.click(win, doc.querySelector('#qzBlankFeedback [data-qz="next"]'));
    assert.match(doc.getElementById("qzBlankProgress").textContent, /第 2 \/ 10 题/);
    assert.equal(optionButtons(doc).length, 4);
    assert.equal(doc.getElementById("qzBlankFeedback").classList.contains("hidden"), true);
  });
});

test("选词填空：选错温柔提示、不扣分，但会把薄弱词记进外教记忆", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-tab="pattern"]');
    h.click(win, doc.querySelector('#qzTabs [data-qz="blank"]'));
    h.clickSel(win, "#btnQzBlankStart");
    const q = win.App.inspect.Quiz.session.deck[0];
    const wrong = q.options.filter(function (o) { return !o.ok; })[0].w;

    clickOption(win, doc, wrong);
    const bad = doc.querySelector("#qzBlankOptions .qz-opt.bad");
    assert.ok(bad, "选错的选项应标出来");
    assert.equal(bad.dataset.w, wrong);
    assert.match(doc.getElementById("qzBlankFeedback").textContent, /再想想/);
    // 还能继续选对的
    assert.equal(optionButtons(doc).length, 4);

    const data = quizData(win);
    assert.equal(data.blank.attempts, 1);
    assert.equal(data.blank.correct, 0);
    const mem = memoryData(win);
    assert.equal(mem.length, 1);
    assert.equal(mem[0].type, "weak");
    assert.match(mem[0].text, new RegExp(q.word));
    assert.equal(mem[0].src, "auto");
  });
});

test("选词填空：做完 10 题给成绩，进度写进当前档案", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-tab="pattern"]');
    h.click(win, doc.querySelector('#qzTabs [data-qz="blank"]'));
    h.clickSel(win, "#btnQzBlankStart");
    for (let i = 0; i < 10; i++) {
      const q = win.App.inspect.Quiz.session.deck[i];
      clickOption(win, doc, q.form);
      h.click(win, doc.querySelector('#qzBlankFeedback [data-qz="next"]'));
    }
    assert.match(doc.getElementById("qzBlankSentence").textContent, /答对 10 \/ 10/);
    assert.equal(doc.getElementById("qzBlankProgress").textContent, "已完成 10 题");
    const data = quizData(win);
    assert.equal(data.blank.attempts, 10);
    assert.equal(data.blank.correct, 10);
    assert.equal(data.blank.byLevel.A1.done.length, 10);

    // 再来一组：做完的词不再重复出
    h.click(win, doc.querySelector('#qzBlankFeedback [data-qz="again"]'));
    const nextDeck = win.App.inspect.Quiz.session.deck;
    assert.ok(nextDeck.length > 0);
    const done = data.blank.byLevel.A1.done;
    nextDeck.forEach(function (q) {
      assert.equal(done.indexOf(q.word), -1, "不应重复出已经做对的词：" + q.word);
    });
  });
});

/* ------------------------- 英汉配对界面 ------------------------- */

test("英汉配对：开局 5 组，点英文再点中文就把这一对消去", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-tab="pattern"]');
    h.click(win, doc.querySelector('#qzTabs [data-qz="match"]'));
    assert.equal(doc.getElementById("qzMatchPane").classList.contains("hidden"), false);
    h.clickSel(win, "#btnQzMatchStart");
    assert.equal(doc.getElementById("qzMatchPlay").classList.contains("hidden"), false);
    assert.equal(doc.querySelectorAll("#qzMatchLeft .qz-tile").length, 5);
    assert.equal(doc.querySelectorAll("#qzMatchRight .qz-tile").length, 5);
    assert.match(doc.getElementById("qzMatchProgress").textContent, /还剩 5 对/);

    const p = win.App.inspect.Quiz.session.round.pairs[0];
    h.click(win, doc.querySelector('#qzMatchLeft [data-i="' + p.i + '"]'));
    assert.ok(doc.querySelector('#qzMatchLeft [data-i="' + p.i + '"]').classList.contains("sel"));
    h.click(win, doc.querySelector('#qzMatchRight [data-i="' + p.i + '"]'));
    assert.equal(doc.querySelectorAll("#qzMatchLeft .qz-tile").length, 4);
    assert.equal(doc.querySelectorAll("#qzMatchRight .qz-tile").length, 4);
    assert.match(doc.getElementById("qzMatchProgress").textContent, /还剩 4 对/);
    const data = quizData(win);
    assert.equal(data.match.pairs, 1);
  });
});

test("英汉配对：配错轻轻提示并记薄弱点，全部配完给成绩、能再来一轮", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-tab="pattern"]');
    h.click(win, doc.querySelector('#qzTabs [data-qz="match"]'));
    h.clickSel(win, "#btnQzMatchStart");
    const s = win.App.inspect.Quiz.session;

    // 故意配错两组
    h.click(win, doc.querySelector('#qzMatchLeft [data-i="' + s.round.pairs[0].i + '"]'));
    h.click(win, doc.querySelector('#qzMatchRight [data-i="' + s.round.pairs[1].i + '"]'));
    assert.ok(doc.querySelector("#qzMatchLeft .qz-tile.bad"));
    await h.sleep(500);
    assert.ok(memoryData(win).some(function (m) {
      return m.type === "weak" && m.text.indexOf(s.round.pairs[0].w) >= 0;
    }), "配错应该记一条薄弱点");

    // 把剩下的都配对
    s.round.pairs.forEach(function (p) {
      const l = doc.querySelector('#qzMatchLeft [data-i="' + p.i + '"]');
      if (!l) return;
      h.click(win, l);
      h.click(win, doc.querySelector('#qzMatchRight [data-i="' + p.i + '"]'));
    });
    assert.equal(doc.getElementById("qzMatchDone").classList.contains("hidden"), false);
    assert.match(doc.getElementById("qzMatchDoneSub").textContent, /5 组/);
    const data = quizData(win);
    assert.equal(data.match.rounds, 1);
    assert.equal(data.match.pairs, 5);
    assert.equal(data.match.byLevel.A1.rounds, 1);

    h.clickSel(win, "#btnQzMatchAgain");
    assert.equal(doc.getElementById("qzMatchDone").classList.contains("hidden"), true);
    assert.equal(doc.querySelectorAll("#qzMatchLeft .qz-tile").length, 5);
    assert.equal(win.App.inspect.Quiz.session.round.pairs.length, 5);
  });
});

/* ------------------------- 档案隔离与返回键 ------------------------- */

test("两种新题型的进度按档案隔离", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-tab="pattern"]');
    h.click(win, doc.querySelector('#qzTabs [data-qz="blank"]'));
    h.clickSel(win, "#btnQzBlankStart");
    const q = win.App.inspect.Quiz.session.deck[0];
    clickOption(win, doc, q.form);
    const first = activeId(win);
    assert.equal(quizData(win, first).blank.correct, 1);

    h.clickSel(win, '[data-tab="settings"]');
    h.clickSel(win, "#btnProfileNew");
    h.type(win, "#pName", "爸爸");
    h.clickSel(win, "#profileSave");
    const second = activeId(win);
    assert.notEqual(second, first);

    h.clickSel(win, '[data-tab="pattern"]');
    assert.match(doc.getElementById("qzBlankStats").textContent, /已做 0 题/);
    assert.equal(quizData(win, second).blank.correct, 0);
    assert.equal(quizData(win, second).blank.byLevel.A1, undefined);
    assert.equal(doc.getElementById("qzBlankPlay").classList.contains("hidden"), true, "新档案回到首页");

    // 切回去，成绩还在
    h.clickSel(win, '[data-tab="library"]');
    h.clickSel(win, '[data-act="profile-switch"][data-id="' + first + '"]');
    h.clickSel(win, '[data-tab="pattern"]');
    assert.match(doc.getElementById("qzBlankStats").textContent, /已做 1 题/);
  });
});

test("安卓返回键：选词填空进行中先回闯关首页", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-tab="pattern"]');
    h.click(win, doc.querySelector('#qzTabs [data-qz="blank"]'));
    h.clickSel(win, "#btnQzBlankStart");
    assert.equal(doc.getElementById("btnBack").classList.contains("hidden"), false);
    assert.equal(win.App.handleBack(), "handled");
    assert.equal(doc.getElementById("pzHome").classList.contains("hidden"), false);
    assert.equal(doc.getElementById("qzBlankPlay").classList.contains("hidden"), true);
    assert.equal(doc.getElementById("btnBack").classList.contains("hidden"), true);
  });
});
