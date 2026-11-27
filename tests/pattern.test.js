/* =========================================================
   句型闯关（v1.5.0）的自动化测试
   —— 纯函数（拆分 / 打乱 / 校验 / 听写差异）+ jsdom 里的真实点击流程
   ========================================================= */

const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./harness.js");
const core = require("../app/src/main/assets/www/challenge.js");

const PatternCore = core.PatternCore;
const LEVELS = core.CHALLENGE_LEVELS;

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

function patternData(win) {
  const raw = win.localStorage.getItem("erc.p." + activeId(win) + ".patterns");
  return raw ? JSON.parse(raw) : null;
}

function poolChunks(doc) {
  return Array.from(doc.querySelectorAll("#pzPool .pz-chunk"));
}

function answerChunks(doc) {
  return Array.from(doc.querySelectorAll("#pzAnswer .pz-chunk"));
}

/** 按正确语序点词块（每个词块点一次） */
function placeAll(win, doc, sentence) {
  const tokens = PatternCore.tokenize(sentence);
  tokens.forEach(function (t) {
    const btn = poolChunks(doc).filter(function (b) { return b.textContent === t; })[0];
    assert.ok(btn, "词块池里应该有：" + t);
    h.click(win, btn);
  });
  return tokens.length;
}

function nextLabel(doc) {
  const btn = doc.querySelector('#pzFeedback [data-pz="next"]');
  return btn ? btn.textContent.trim() : "";
}

function clickNext(win, doc) {
  const btn = doc.querySelector('#pzFeedback [data-pz="next"]');
  assert.ok(btn, "过关反馈里应该有「下一句」按钮");
  h.click(win, btn);
}

/* ------------------------- 纯函数 ------------------------- */

test("拆词块：保留词尾标点、撇号与连字符不拆开", function () {
  assert.deepEqual(PatternCore.tokenize("I get up at seven, every morning."),
    ["I", "get", "up", "at", "seven,", "every", "morning."]);
  assert.deepEqual(PatternCore.tokenize("Don't be late — we're leaving."),
    ["Don't", "be", "late", "—", "we're", "leaving."]);
  assert.deepEqual(PatternCore.tokenize("[[Good morning]], sun!"),
    ["Good", "morning,", "sun!"]);
});

test("打乱：不会原样返回，且不丢词不重复", function () {
  const src = ["I", "get", "up", "at", "seven"];
  const shuffled = PatternCore.shuffle(src);
  assert.equal(shuffled.length, src.length);
  assert.deepEqual(shuffled.slice().sort(), src.slice().sort());
  assert.notDeepEqual(shuffled, src);
  // 固定随机源也要保证不是原序
  assert.notDeepEqual(PatternCore.shuffle(src, function () { return 0; }), src);
  // 只有一个词时原样返回
  assert.deepEqual(PatternCore.shuffle(["hi"]), ["hi"]);
});

test("拼句校验：忽略大小写与标点，只比语序", function () {
  const target = ["I", "get", "up", "at", "seven."];
  assert.equal(PatternCore.checkOrder(["i", "get", "up", "at", "seven"], target).ok, true);
  const bad = PatternCore.checkOrder(["I", "up", "get", "at", "seven"], target);
  assert.equal(bad.ok, false);
  assert.equal(bad.firstBad, 1);
  assert.equal(PatternCore.checkOrder(["I", "get"], target).ok, false);
});

test("听写校验：大小写、空格、标点宽容，并标出漏词 / 多词 / 拼错", function () {
  const target = "I get up at seven every morning.";
  assert.equal(PatternCore.diff("  i GET up at seven every morning ", target).ok, true);
  assert.equal(PatternCore.diff("I get up at seven every morning", target).ok, true);

  const missing = PatternCore.diff("I get at seven every morning", target);
  assert.equal(missing.ok, false);
  assert.equal(missing.missing, 1);
  assert.equal(missing.cells.filter(function (c) { return c.s === "missing"; })[0].t, "up");

  const extra = PatternCore.diff("I get up at seven every single morning", target);
  assert.equal(extra.ok, false);
  assert.equal(extra.extra, 1);

  const changed = PatternCore.diff("I get up at seven every night", target);
  assert.equal(changed.ok, false);
  assert.equal(changed.changed, 1);
  const cell = changed.cells.filter(function (c) { return c.s === "changed"; })[0];
  assert.equal(cell.t, "morning.");
  assert.equal(cell.a, "night");
});

test("听写提示：给出第一个还没写对的词", function () {
  assert.equal(PatternCore.dictationHint("I get", "I get up at seven."), "up");
  assert.equal(PatternCore.dictationHint("", "I get up."), "I");
  assert.equal(PatternCore.dictationHint("I get up", "I get up."), "");
});

test("内置句库：三关各 10 句，原创信息完整、长度适合手机拼句", function () {
  assert.equal(LEVELS.length, 3);
  const seen = new Set();
  LEVELS.forEach(function (lv) {
    assert.equal(lv.sentences.length, 10, lv.id + " 应有关 10 句");
    lv.sentences.forEach(function (s) {
      assert.ok(s.en && s.zh && s.hint && s.tag, "句子字段要齐全：" + s.en);
      const n = PatternCore.tokenize(s.en).length;
      assert.ok(n >= 4 && n <= 18, "句子长度应在 4–18 个词：" + s.en + " (" + n + ")");
      assert.equal(seen.has(s.en), false, "句子不应重复：" + s.en);
      seen.add(s.en);
      assert.equal(/\[\[|\]\]/.test(s.en), false);
    });
  });
});

test("文章抽句：过滤太短 / 太长的句子，带上译文与讲解", function () {
  const item = {
    title: "Test",
    sentences: ["Hi.", "The sun is up.", "I [[wake up]] at seven.", "This sentence is far too long to be a good chunk puzzle because it keeps going and going and going well past the limit."],
    zh: ["嗨。", "太阳升起来了。", "我七点起床。", "太长的一句。"],
    notes: [null, null, "wake up 是起床。", null]
  };
  const picked = PatternCore.pickFromArticle(item, 12);
  assert.equal(picked.length, 2);
  assert.equal(picked[0].en, "The sun is up.");
  assert.equal(picked[1].en, "I wake up at seven.");
  assert.equal(picked[1].zh, "我七点起床。");
  assert.match(picked[1].hint, /wake up/);
});

/* ------------------------- 界面流程 ------------------------- */

test("入口：底栏「闯关」和书库卡片都能进入句型闯关", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-tab="pattern"]');
    assert.ok(doc.getElementById("view-pattern").classList.contains("active"));
    assert.equal(doc.getElementById("pzHome").classList.contains("hidden"), false);
    assert.equal(doc.querySelectorAll("#pzLevels .pz-level").length, 3);

    h.clickSel(win, '[data-tab="library"]');
    h.clickSel(win, '.pz-jump');
    assert.ok(doc.getElementById("view-pattern").classList.contains("active"));
    assert.ok(doc.querySelector('[data-tab="pattern"]').classList.contains("active"));
  });
});

test("开始第一关：显示中文提示与打乱的词块，答案区为空", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-tab="pattern"]');
    h.clickSel(win, "#pzLevels .pz-level");
    assert.equal(doc.getElementById("pzPlay").classList.contains("hidden"), false);
    assert.equal(doc.getElementById("pzZh").textContent, LEVELS[0].sentences[0].zh);
    assert.equal(doc.getElementById("pzProgress").textContent.indexOf("第 1 / 10 句"), 0);
    const tokens = PatternCore.tokenize(LEVELS[0].sentences[0].en);
    assert.deepEqual(poolChunks(doc).map(function (b) { return b.textContent; }).slice().sort(), tokens.slice().sort());
    assert.notDeepEqual(poolChunks(doc).map(function (b) { return b.textContent; }), tokens);
    assert.equal(answerChunks(doc).length, 0);
    assert.match(doc.getElementById("pzAnswer").textContent, /按顺序拼成/);
  });
});

test("按语序拼对：正反馈、提示音、连对与档案进度都记账", async function () {
  await withApp(async function ({ win, doc, calls }) {
    h.clickSel(win, '[data-tab="pattern"]');
    h.clickSel(win, "#pzLevels .pz-level");
    placeAll(win, doc, LEVELS[0].sentences[0].en);
    await h.sleep(260);

    const fb = doc.getElementById("pzFeedback");
    assert.equal(fb.classList.contains("hidden"), false);
    assert.match(fb.textContent, /拼对了/);
    assert.match(fb.textContent, /连对 1 句/);
    assert.match(doc.getElementById("pzStreak").textContent, /🔥 1/);
    assert.ok(calls.oscillators >= 3, "应该用 Web Audio 合成过关提示音");

    const data = patternData(win);
    assert.deepEqual(data.levels.l1.done, [0]);
    assert.equal(data.levels.l1.idx, 1);
    assert.equal(data.stats.correct, 1);
    assert.equal(data.stats.attempts, 1);
    assert.equal(data.stats.streak, 1);
    assert.equal(data.last, "l1");

    // 点「下一句」顺滑进入第二句
    clickNext(win, doc);
    assert.equal(doc.getElementById("pzProgress").textContent.indexOf("第 2 / 10 句"), 0);
    assert.equal(doc.getElementById("pzZh").textContent, LEVELS[0].sentences[1].zh);
    assert.equal(patternData(win).levels.l1.idx, 1);
  });
});

test("顺序拼错：温柔提示、连对清零、正确率不被记成满分", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-tab="pattern"]');
    h.clickSel(win, "#pzLevels .pz-level");
    const tokens = PatternCore.tokenize(LEVELS[0].sentences[0].en);
    tokens.slice().reverse().forEach(function (t) {
      h.click(win, poolChunks(doc).filter(function (b) { return b.textContent === t; })[0]);
    });
    await h.sleep(260);
    const fb = doc.getElementById("pzFeedback");
    assert.match(fb.textContent, /顺序还差一点/);
    assert.match(fb.textContent, /第 1 个词/);
    const data = patternData(win);
    assert.equal(data.stats.attempts, 1);
    assert.equal(data.stats.correct, 0);
    assert.equal(data.stats.streak, 0);
    assert.deepEqual(data.levels.l1.done, []);
  });
});

test("提示下一词：高亮池子里对应的词块；清空把词块全部退回", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-tab="pattern"]');
    h.clickSel(win, "#pzLevels .pz-level");
    const tokens = PatternCore.tokenize(LEVELS[0].sentences[0].en);
    h.clickSel(win, "#pzHint");
    assert.match(doc.getElementById("pzHintLine").textContent, new RegExp("下一个词：\\s*" + tokens[0]));
    const hinted = doc.querySelector("#pzPool .pz-chunk.hint");
    assert.ok(hinted);
    assert.equal(hinted.textContent, tokens[0]);

    h.click(win, poolChunks(doc)[0]);
    h.click(win, poolChunks(doc)[0]);
    assert.equal(answerChunks(doc).length, 2);
    h.clickSel(win, "#pzClear");
    assert.equal(answerChunks(doc).length, 0);
    assert.equal(poolChunks(doc).length, tokens.length);
    assert.match(doc.getElementById("pzAnswer").textContent, /按顺序拼成/);
  });
});

test("切到听写：大小写 / 多余空格 / 结尾标点宽容，写错标出差异", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-tab="pattern"]');
    h.clickSel(win, "#pzLevels .pz-level");
    h.clickSel(win, '#pzModeSeg [data-mode="dictate"]');
    assert.equal(doc.getElementById("pzDictate").classList.contains("hidden"), false);
    assert.equal(doc.getElementById("pzBuild").classList.contains("hidden"), true);

    // 先写错：最后一个词不对
    h.type(win, "#pzInput", "i get up at seven every night");
    h.clickSel(win, "#pzSubmit");
    assert.equal(doc.getElementById("pzFeedback").classList.contains("hidden"), false);
    assert.ok(doc.querySelector("#pzFeedback .df-wrong"), "写错的词应标出来");
    assert.ok(doc.querySelector("#pzFeedback .df-fix"), "应同时给出正确写法");
    assert.equal(patternData(win).stats.attempts, 1);
    assert.equal(patternData(win).stats.correct, 0);

    // 再写对：大小写、多余空格、句末标点都不扣分
    h.type(win, "#pzInput", "  I   GET up at seven every morning ");
    h.clickSel(win, "#pzSubmit");
    const fb = doc.getElementById("pzFeedback");
    assert.match(fb.textContent, /拼对了/);
    const data = patternData(win);
    assert.equal(data.stats.correct, 1);
    assert.equal(data.stats.attempts, 2);
    assert.deepEqual(data.levels.l1.done, [0]);
  });
});

test("单句循环：读完后自动再读；关掉后不再重复", async function () {
  await withApp(async function ({ win, doc, calls }) {
    h.clickSel(win, '[data-tab="pattern"]');
    h.clickSel(win, "#pzLevels .pz-level");
    h.clickSel(win, "#pzLoopBtn");
    assert.equal(calls.speak.length, 1);
    assert.equal(calls.speak[0].text, LEVELS[0].sentences[0].en);
    win.Native.onSpeakEnd(calls.speak[calls.speak.length - 1].id);
    await h.sleep(900);
    assert.equal(calls.speak.length, 2, "循环应该在 700ms 后重读");
    assert.equal(calls.speak[1].text, LEVELS[0].sentences[0].en);

    h.clickSel(win, "#pzLoopBtn"); // 关掉
    win.Native.onSpeakEnd(calls.speak[calls.speak.length - 1].id);
    await h.sleep(900);
    assert.equal(calls.speak.length, 2, "关掉循环后不应再自动朗读");
  });
});

test("盲听模式：遮住中文和词数，只留发音", async function () {
  await withApp(async function ({ win, doc, calls }) {
    h.clickSel(win, '[data-tab="pattern"]');
    h.clickSel(win, "#pzLevels .pz-level");
    h.clickSel(win, "#pzBlindBtn");
    const zh = doc.getElementById("pzZh");
    assert.ok(zh.classList.contains("is-blind"));
    assert.match(zh.textContent, /盲听模式/);
    assert.match(doc.getElementById("pzCount").textContent, /词数已隐藏/);
    assert.ok(calls.speak.length >= 1, "打开盲听应该自动读一遍");
    assert.equal(calls.speak[calls.speak.length - 1].text, LEVELS[0].sentences[0].en);

    h.clickSel(win, "#pzBlindBtn");
    assert.equal(doc.getElementById("pzZh").textContent, LEVELS[0].sentences[0].zh);
    assert.match(doc.getElementById("pzCount").textContent, /个词块/);
  });
});

test("过关后点整句里的单词，能查词并收进当前档案的生词本", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-tab="pattern"]');
    h.clickSel(win, "#pzLevels .pz-level");
    placeAll(win, doc, LEVELS[0].sentences[0].en);
    await h.sleep(260);
    const word = doc.querySelector('#pzFeedback .pz-full .w');
    assert.ok(word, "整句应该按单词渲染");
    h.click(win, word);
    assert.equal(doc.getElementById("wordMask").classList.contains("hidden"), false);
    h.clickSel(win, "#wAdd");
    const raw = win.localStorage.getItem("erc.p." + activeId(win) + ".vocab");
    assert.equal(JSON.parse(raw).length, 1);
  });
});

test("从当前阅读文章抽句闯关：句子来自文章，进度单独记", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-act="open-passage"][data-id="k1"]');
    h.clickSel(win, "#btnPatternFromReader");
    assert.ok(doc.getElementById("view-pattern").classList.contains("active"));
    assert.match(doc.getElementById("pzLevelName").textContent, /文章闯关/);
    assert.equal(doc.getElementById("pzZh").textContent, "太阳升起来了。");
    placeAll(win, doc, "The sun is up.");
    await h.sleep(260);
    assert.match(doc.getElementById("pzFeedback").textContent, /拼对了/);
    const data = patternData(win);
    assert.deepEqual(data.levels["art:k1"].done, [0]);
    // 文章闯关不改变「接着闯」指向的内置关卡
    assert.equal(data.last, "");
  });
});

test("档案隔离：换个学习档案，闯关进度、正确率、连对都是新的", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-tab="pattern"]');
    h.clickSel(win, "#pzLevels .pz-level");
    placeAll(win, doc, LEVELS[0].sentences[0].en);
    await h.sleep(260);
    const firstId = activeId(win);
    assert.equal(patternData(win).stats.streak, 1);

    // 在设置里新建一个档案并自动切换
    h.clickSel(win, '[data-tab="settings"]');
    h.clickSel(win, "#btnProfileNew");
    h.type(win, "#pName", "妹妹");
    h.clickSel(win, "#profileSave");
    const secondId = activeId(win);
    assert.notEqual(secondId, firstId);

    h.clickSel(win, '[data-tab="pattern"]');
    assert.match(doc.getElementById("pzStats").textContent, /当前连对 0/);
    assert.match(doc.getElementById("pzStats").textContent, /正确率 0%/);
    assert.equal(patternData(win), null, "新档案不应该继承别人的闯关数据");

    // 切回第一个档案，数据还在
    h.clickSel(win, '[data-tab="library"]');
    h.clickSel(win, '[data-act="profile-switch"][data-id="' + firstId + '"]');
    h.clickSel(win, '[data-tab="pattern"]');
    assert.match(doc.getElementById("pzStats").textContent, /当前连对 1/);
    assert.equal(patternData(win).levels.l1.done.length, 1);
  });
});

test("渐进关卡：完成上一关才解锁下一关", async function () {
  const seed = {
    "erc.profiles": {
      active: "pL",
      list: [{ id: "pL", name: "L", emoji: "🌱", tier: "kids", speed: 1, voice: "neural", created: 1 }]
    },
    "erc.p.pL.patterns": {
      levels: {
        l1: { done: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], idx: 10, attempts: 12, correct: 10 }
      },
      stats: { attempts: 12, correct: 10, streak: 3, best: 5 },
      last: "l1",
      mode: "build",
      loop: false,
      blind: false
    }
  };
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-tab="pattern"]');
    const cards = Array.from(doc.querySelectorAll("#pzLevels .pz-level"));
    assert.equal(cards[0].classList.contains("is-locked"), false);
    assert.match(cards[0].textContent, /已完成/);
    assert.equal(cards[1].classList.contains("is-locked"), false, "第二关应已解锁");
    assert.equal(cards[2].classList.contains("is-locked"), true, "第三关应还锁着");

    // 点锁着的第三关不会进入
    h.click(win, cards[2]);
    assert.equal(doc.getElementById("pzPlay").classList.contains("hidden"), true);

    // 第二关可以正常开始
    h.click(win, cards[1]);
    assert.equal(doc.getElementById("pzPlay").classList.contains("hidden"), false);
    assert.match(doc.getElementById("pzProgress").textContent, /第 1 \/ 10 句/);
  }, { storage: seed });
});

test("打完整关：完成页给成绩，回到列表后下一关解锁", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-tab="pattern"]');
    h.clickSel(win, "#pzLevels .pz-level");
    for (let i = 0; i < LEVELS[0].sentences.length; i++) {
      placeAll(win, doc, LEVELS[0].sentences[i].en);
      await h.sleep(220);
      assert.match(doc.getElementById("pzFeedback").textContent, /拼对了/, "第 " + (i + 1) + " 句应拼对");
      clickNext(win, doc);
    }
    assert.equal(doc.getElementById("pzDone").classList.contains("hidden"), false);
    assert.match(doc.getElementById("pzDoneStats").textContent, /完成 10\/10/);
    assert.match(doc.getElementById("pzDoneStats").textContent, /本关正确率 100%/);
    assert.equal(doc.getElementById("pzNextLevel").classList.contains("hidden"), false);

    h.clickSel(win, "#pzDoneHome");
    const cards = Array.from(doc.querySelectorAll("#pzLevels .pz-level"));
    assert.equal(cards[1].classList.contains("is-locked"), false);
    assert.equal(patternData(win).levels.l1.done.length, 10);
  });
});

test("设置里关掉过关提示音，或用手机静音时，都不合成声音", async function () {
  // 1) 设置里关掉
  await withApp(async function ({ win, doc, calls }) {
    h.clickSel(win, '[data-tab="pattern"]');
    h.clickSel(win, "#pzLevels .pz-level");
    placeAll(win, doc, LEVELS[0].sentences[0].en);
    await h.sleep(240);
    assert.equal(calls.oscillators, 0);
    assert.equal(calls.audioContexts, 0);
  }, { storage: { "erc.settings": { sfx: false } } });

  // 2) 手机媒体音量为 0（由原生桥告知）
  await withApp(async function ({ win, doc, calls }) {
    calls.muted = true;
    h.clickSel(win, '[data-tab="pattern"]');
    h.clickSel(win, "#pzLevels .pz-level");
    placeAll(win, doc, LEVELS[0].sentences[0].en);
    await h.sleep(240);
    assert.equal(calls.oscillators, 0);
  });
});

test("安卓返回键：闯关进行中先回关卡列表，再按才回书库", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-tab="pattern"]');
    h.clickSel(win, "#pzLevels .pz-level");
    assert.equal(doc.getElementById("btnBack").classList.contains("hidden"), false, "进入关卡后应出现返回按钮");
    assert.equal(win.App.handleBack(), "handled");
    assert.equal(doc.getElementById("pzHome").classList.contains("hidden"), false);
    assert.equal(doc.getElementById("pzPlay").classList.contains("hidden"), true);
    assert.equal(doc.getElementById("btnBack").classList.contains("hidden"), true);
    assert.equal(win.App.handleBack(), "handled");
    assert.ok(doc.getElementById("view-library").classList.contains("active"));
  });
});

test("进度持久化：重新打开 App 仍停在上次那句", async function () {
  let saved;
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-tab="pattern"]');
    h.clickSel(win, "#pzLevels .pz-level");
    placeAll(win, doc, LEVELS[0].sentences[0].en);
    await h.sleep(260);
    clickNext(win, doc);
    saved = patternData(win);
  });
  // 用同一份 localStorage 再启动一次
  const storage = {};
  storage["erc.profiles"] = {
    active: "p1",
    list: [{ id: "p1", name: "P", emoji: "🧸", tier: "kids", speed: 1, voice: "neural", created: 1 }]
  };
  storage["erc.p.p1.patterns"] = Object.assign({}, saved, {
    last: "l1",
    levels: { l1: { done: [0], idx: 1, attempts: 1, correct: 1 } }
  });
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-tab="pattern"]');
    h.clickSel(win, "#btnPzContinue");
    assert.equal(doc.getElementById("pzZh").textContent, LEVELS[0].sentences[1].zh);
    assert.match(doc.getElementById("pzProgress").textContent, /第 2 \/ 10 句/);
  }, { storage: storage });
});
