/* =========================================================
   v1.7.0：🎯 CEFR 快速定级 + 本轮小任务卡 的自动化测试
   —— 6 题计分与分级、界面完整流程、定级后的三处联动、
      任务卡按等级过滤 / 换一张 / 关掉 / 按档案记住
   ========================================================= */

const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./harness.js");
const { Placement, PLACEMENT_QUESTIONS, TASK_CARDS } = require("../app/src/main/assets/www/placement.js");

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

function profileOf(win, id) {
  const s = JSON.parse(win.localStorage.getItem("erc.profiles"));
  return s.list.filter(function (p) { return p.id === (id || s.active); })[0];
}

function taskOf(win, id) {
  const raw = win.localStorage.getItem("erc.p." + (id || activeId(win)) + ".task");
  return raw ? JSON.parse(raw) : null;
}

/** 选当前题里分值最高的那个选项 */
function pickBest(win, doc) {
  const idx = Number(doc.getElementById("plStep").textContent.match(/第 (\d+)/)[1]) - 1;
  const q = PLACEMENT_QUESTIONS[idx];
  let best = 0;
  q.opts.forEach(function (o, i) { if (o.v > q.opts[best].v) best = i; });
  h.click(win, doc.querySelectorAll("#plOpts .pl-opt")[best]);
}

/** 选当前题里分值最低的那个选项 */
function pickWorst(win, doc) {
  const idx = Number(doc.getElementById("plStep").textContent.match(/第 (\d+)/)[1]) - 1;
  const q = PLACEMENT_QUESTIONS[idx];
  let worst = 0;
  q.opts.forEach(function (o, i) { if (o.v < q.opts[worst].v) worst = i; });
  h.click(win, doc.querySelectorAll("#plOpts .pl-opt")[worst]);
}

/* ------------------------- 纯函数 ------------------------- */

test("定级：6 道题、每题 0–3 分，总分 18，分级阈值正确", function () {
  assert.equal(PLACEMENT_QUESTIONS.length, 6);
  PLACEMENT_QUESTIONS.forEach(function (q) {
    assert.ok(q.id && q.q && q.tag);
    assert.ok(q.opts.length >= 3 && q.opts.length <= 4);
    q.opts.forEach(function (o) {
      assert.ok(o.t, "每个选项都要有文字");
      assert.ok(o.v >= 0 && o.v <= 3 && Number.isInteger(o.v));
    });
    assert.ok(q.opts.some(function (o) { return o.v === 3; }), q.id + " 应有满分选项");
    assert.ok(q.opts.some(function (o) { return o.v === 0; }), q.id + " 应有零分选项");
  });

  assert.equal(Placement.score([]), 0);
  assert.equal(Placement.answered([]), 0);
  assert.equal(Placement.answered([0, 0]), 2);
  assert.equal(Placement.levelFromScore(0), "A1");
  assert.equal(Placement.levelFromScore(5), "A1");
  assert.equal(Placement.levelFromScore(6), "A2");
  assert.equal(Placement.levelFromScore(10), "A2");
  assert.equal(Placement.levelFromScore(11), "B1");
  assert.equal(Placement.levelFromScore(14), "B1");
  assert.equal(Placement.levelFromScore(15), "B2");
  assert.equal(Placement.levelFromScore(18), "B2");
  assert.equal(Placement.isLevel("b1"), true);
  assert.equal(Placement.isLevel("C1"), false);
});

test("定级：结果带着加词等级、闯关等级和语速建议，非法等级回落到 A1", function () {
  const a2 = Placement.infoOf("A2");
  assert.equal(a2.vocab, "A2");
  assert.equal(a2.quiz, "A2");
  assert.equal(a2.speed, 0.9);
  assert.match(a2.desc, /熟悉主题/);
  assert.equal(Placement.infoOf("C2").lv, "A1");
  assert.equal(Placement.infoOf("").lv, "A1");

  assert.equal(Placement.tutorBlock(""), "");
  const block = Placement.tutorBlock("B1");
  assert.match(block, /CEFR B1/);
  assert.match(block, /正常语速/);
  assert.match(block, /不要因为学生说中文就整段改用中文/);
});

test("小任务卡：A1 只看入门卡，B2 能看到全部；换一张尽量不重复", function () {
  const a1 = Placement.taskDeck("A1");
  const b2 = Placement.taskDeck("B2");
  assert.ok(a1.length >= 3);
  assert.ok(b2.length > a1.length);
  assert.ok(a1.every(function (c) { return c.min === "A1"; }));
  assert.equal(b2.length, TASK_CARDS.length);
  assert.ok(Placement.taskDeck("").length >= 3, "没定级时按 A1 给任务");

  const cur = a1[0];
  for (let i = 0; i < 12; i++) {
    const t = Placement.pickTask("A1", cur.id, function () { return 0.5; });
    assert.ok(t);
    assert.notEqual(t.id, cur.id, "换一张不应重复当前这张");
  }
  assert.equal(Placement.taskById(cur.id).id, cur.id);
  assert.equal(Placement.taskById("nope"), null);
});

/* ------------------------- 界面 ------------------------- */

test("设置页：6 题全选满分 → B2，结果页一键应用后三处联动", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-tab="settings"]');
    assert.match(doc.getElementById("placementLevel").textContent, /还没定级/);
    h.clickSel(win, "#btnPlacementStart");
    assert.equal(doc.getElementById("placementMask").classList.contains("hidden"), false);
    assert.equal(doc.querySelectorAll("#plOpts .pl-opt").length, 4);

    for (let i = 0; i < 6; i++) pickBest(win, doc);

    assert.equal(doc.getElementById("plResult").classList.contains("hidden"), false);
    assert.match(doc.getElementById("plResult").textContent, /B2/);
    assert.match(doc.getElementById("plResult").textContent, /按级加词/);
    assert.match(doc.getElementById("plResult").textContent, /建议语速 1.1x/);

    h.click(win, doc.querySelector('#plResult [data-pl="apply"]'));
    assert.equal(doc.getElementById("placementMask").classList.contains("hidden"), true);
    assert.equal(profileOf(win).cefr, "B2");

    // 生词本：按级加词默认变成 B2
    h.clickSel(win, '[data-tab="vocab"]');
    assert.match(doc.getElementById("btnCefrImport").textContent, /B2/);
    assert.ok(doc.querySelector('#cefrSeg [data-lv="B2"]').classList.contains("active"));

    // 闯关：选词填空 / 英汉配对默认等级也跟着变
    assert.equal(win.App.inspect.Quiz.blankLv, "B2");
    assert.equal(win.App.inspect.Quiz.matchLv, "B2");

    // 对话页：水平卡与建议语速按钮
    h.clickSel(win, '[data-tab="conv"]');
    assert.equal(doc.getElementById("convCefrPill").textContent, "CEFR B2");
    assert.match(doc.getElementById("convCefrHint").textContent, /B2/);
    assert.equal(doc.getElementById("btnConvApplySpeed").classList.contains("hidden"), false);
    h.clickSel(win, "#btnConvApplySpeed");
    assert.equal(JSON.parse(win.localStorage.getItem("erc.settings")).speed, 1.1);
  });
});

test("设置页：全选最低分 → A1；返回上一题可以改答案后重算", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-tab="settings"]');
    h.clickSel(win, "#btnPlacementStart");
    for (let i = 0; i < 6; i++) pickWorst(win, doc);
    assert.match(doc.getElementById("plResult").textContent, /A1/);

    // 重新测一次 → 回到第 1 题
    h.click(win, doc.querySelector('#plResult [data-pl="retry"]'));
    assert.match(doc.getElementById("plStep").textContent, /第 1 \/ 6 题/);

    // 只答第 1 题最高分，再返回上一题，答案还在
    pickBest(win, doc);
    assert.match(doc.getElementById("plStep").textContent, /第 2 \/ 6 题/);
    h.clickSel(win, "#plBack");
    assert.match(doc.getElementById("plStep").textContent, /第 1 \/ 6 题/);
    assert.ok(doc.querySelectorAll("#plOpts .pl-opt.picked").length === 1, "返回后应保留上次的选择");
  });
});

test("任务卡：换一张会变、会写进本档案；关掉后回到默认提示", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-tab="conv"]');
    const first = doc.getElementById("taskText").textContent;
    assert.match(first, /换一张小任务卡/);

    h.clickSel(win, "#btnTaskNext");
    const t1 = doc.getElementById("taskText").textContent;
    assert.ok(t1.length > 6);
    assert.notEqual(t1, first);
    assert.ok(taskOf(win), "任务卡应写进当前档案");

    h.clickSel(win, "#btnTaskNext");
    const t2 = doc.getElementById("taskText").textContent;
    assert.notEqual(t2, t1, "再换一张应不同");

    h.clickSel(win, "#btnTaskOff");
    assert.match(doc.getElementById("taskText").textContent, /换一张小任务卡/);
    assert.equal(taskOf(win), null);
  });
});

test("任务卡按等级过滤，并按档案记住上次那张", async function () {
  const seed = {
    "erc.profiles": {
      active: "pA",
      list: [
        { id: "pA", name: "A", emoji: "📰", tier: "adult", speed: 1, voice: "neural", created: 1, cefr: "B1" },
        { id: "pB", name: "B", emoji: "🧸", tier: "kids", speed: 1, voice: "neural", created: 2 }
      ]
    },
    "erc.p.pA.task": { id: "retell" },
    "erc.p.pB.task": { id: "polite" }
  };
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-tab="conv"]');
    assert.match(doc.getElementById("taskText").textContent, /复述 3 句/);
    assert.match(doc.getElementById("taskLvPill").textContent, /B1/);

    // B2 专属卡在 B1 档案里不出现：换到只剩 A1 卡的档案，B2 的卡会被丢掉
    h.clickSel(win, '[data-tab="library"]');
    h.clickSel(win, '[data-act="profile-switch"][data-id="pB"]');
    h.clickSel(win, '[data-tab="conv"]');
    assert.match(doc.getElementById("taskText").textContent, /换一张小任务卡/, "B2 专属卡不应留给入门档案");
    assert.equal(taskOf(win, "pB"), null, "不合等级的旧任务应被清掉");
  }, { storage: seed });
});
