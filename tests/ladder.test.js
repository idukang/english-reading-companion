/* =========================================================
   v1.7.0：🪜 撤梯子渐进阅读 的自动化测试
   —— 纯函数状态机 + 阅读页真实点击（中文/讲解收起、生词高亮、
      复述卡、遮住英文盲听、按档案记住上次停在哪一阶）
   ========================================================= */

const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./harness.js");
const { Ladder, LADDER_STAGES } = require("../app/src/main/assets/www/ladder.js");

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

function ladderOf(win, id) {
  const raw = win.localStorage.getItem("erc.p." + (id || activeId(win)) + ".ladder");
  return raw ? JSON.parse(raw) : null;
}

/* ------------------------- 纯函数 ------------------------- */

test("梯子：三阶状态机只认 1/2/3，next/prev 不越界", function () {
  assert.equal(LADDER_STAGES.length, 3);
  assert.deepEqual(LADDER_STAGES.map(function (s) { return s.id; }), [1, 2, 3]);
  assert.equal(Ladder.normalize(0), 1);
  assert.equal(Ladder.normalize("2"), 2);
  assert.equal(Ladder.normalize(9), 1);
  assert.equal(Ladder.normalize(null), 1);
  assert.equal(Ladder.next(1), 2);
  assert.equal(Ladder.next(2), 3);
  assert.equal(Ladder.next(3), 3);
  assert.equal(Ladder.prev(3), 2);
  assert.equal(Ladder.prev(1), 1);
  assert.equal(Ladder.isLast(3), true);
  assert.equal(Ladder.isLast(2), false);
});

test("梯子：第 1 阶隐藏中文与讲解，第 2 阶放开并高亮生词，第 3 阶只留复述", function () {
  const s1 = Ladder.flags(1);
  assert.equal(s1.showZh, false);
  assert.equal(s1.showNotes, false);
  assert.equal(s1.highlight, false);
  assert.equal(s1.retell, false);
  assert.equal(s1.blind, true);

  const s2 = Ladder.flags(2);
  assert.equal(s2.showZh, true);
  assert.equal(s2.showNotes, true);
  assert.equal(s2.highlight, true);
  assert.equal(s2.retell, false);
  assert.equal(s2.blind, false);

  const s3 = Ladder.flags(3);
  assert.equal(s3.showZh, false);
  assert.equal(s3.showNotes, false);
  assert.equal(s3.retell, true);
});

test("梯子：全局中文/讲解开关仍然优先，偏好数据会被洗干净", function () {
  assert.equal(Ladder.zhVisible(true, false, 1), true);
  assert.equal(Ladder.zhVisible(true, true, 1), false);
  assert.equal(Ladder.zhVisible(true, true, 2), true);
  assert.equal(Ladder.zhVisible(false, true, 2), false);
  assert.equal(Ladder.notesVisible(true, true, 1), false);
  assert.equal(Ladder.notesVisible(false, false, 2), false);

  assert.deepEqual(Ladder.pref(true, 9), { on: true, stage: 1 });
  assert.deepEqual(Ladder.sanitize(null), { on: false, stage: 1 });
  assert.deepEqual(Ladder.sanitize({ on: 1, stage: "3" }), { on: true, stage: 3 });
  assert.deepEqual(Ladder.sanitize("坏数据"), { on: false, stage: 1 });
});

/* ------------------------- 界面 ------------------------- */

test("阅读页：打开梯子后第 1 阶收起中文与讲解，阶段条出现", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-act="open-passage"][data-id="k1"]');
    assert.ok(doc.querySelectorAll("#sentences .zh").length > 0, "默认应该看得到中文");

    h.clickSel(win, "#btnLadder");
    assert.ok(doc.getElementById("btnLadder").classList.contains("on"));
    assert.equal(doc.querySelectorAll("#sentences .zh").length, 0, "第 1 阶应收起所有中文");
    assert.equal(doc.querySelectorAll("#sentences .note").length, 0, "第 1 阶应收起讲解");
    assert.equal(doc.getElementById("ladderSeg").classList.contains("hidden"), false);
    assert.match(doc.getElementById("ladderStageName").textContent, /盲听/);
    assert.equal(doc.getElementById("retellCard").classList.contains("hidden"), true);
    assert.deepEqual(ladderOf(win), { on: true, stage: 1 });
  });
});

test("阅读页：第 2 阶放开中文与讲解，并把生词本里的词高亮", async function () {
  const seed = {
    "erc.profiles": { active: "pL", list: [{ id: "pL", name: "L", emoji: "🧸", tier: "kids", speed: 1, voice: "neural", created: 1 }] },
    "erc.p.pL.vocab": [{ w: "sun", ts: 1 }],
    "erc.p.pL.ladder": { on: true, stage: 1 }
  };
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-act="open-passage"][data-id="k1"]');
    assert.equal(doc.querySelectorAll("#sentences .zh").length, 0);

    h.click(win, doc.querySelector('#ladderSeg [data-ls="2"]'));
    assert.ok(doc.querySelectorAll("#sentences .zh").length > 0, "第 2 阶应显示中文");
    assert.ok(doc.querySelectorAll("#sentences .note").length > 0, "第 2 阶应显示讲解");
    const sun = doc.querySelector('#sentences .w[data-w="sun"]');
    assert.ok(sun, "文章里应有 sun");
    assert.ok(sun.classList.contains("hot"), "生词本里的 sun 应被高亮");
    assert.deepEqual(ladderOf(win, "pL"), { on: true, stage: 2 });
  }, { storage: seed });
});

test("阅读页：第 3 阶收起中文并出现「关译复述」卡片", async function () {
  const seed = {
    "erc.profiles": { active: "pL", list: [{ id: "pL", name: "L", emoji: "🧸", tier: "kids", speed: 1, voice: "neural", created: 1 }] },
    "erc.p.pL.ladder": { on: true, stage: 2 }
  };
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-act="open-passage"][data-id="k1"]');
    assert.ok(doc.querySelectorAll("#sentences .zh").length > 0);
    h.click(win, doc.querySelector('#ladderSeg [data-ls="3"]'));
    assert.equal(doc.querySelectorAll("#sentences .zh").length, 0);
    assert.equal(doc.getElementById("retellCard").classList.contains("hidden"), false);
    assert.match(doc.getElementById("retellCard").textContent, /复述/);

    // 「只听全文」会把英文遮起来再播放
    h.clickSel(win, "#btnRetellListen");
    assert.ok(doc.getElementById("sentences").classList.contains("blind-listen"));
    assert.ok(doc.querySelector(".w[data-w='sun']"));
    // 再点一次恢复
    h.clickSel(win, "#btnRetellListen");
    assert.equal(doc.getElementById("sentences").classList.contains("blind-listen"), false);
  }, { storage: seed });
});

test("梯子偏好按档案记住：重开同一档案回到上次阶段，换档案回到关闭", async function () {
  const seed = {
    "erc.profiles": {
      active: "pA",
      list: [
        { id: "pA", name: "A", emoji: "🧸", tier: "kids", speed: 1, voice: "neural", created: 1 },
        { id: "pB", name: "B", emoji: "🎒", tier: "teen", speed: 1, voice: "neural", created: 2 }
      ]
    },
    "erc.p.pA.ladder": { on: true, stage: 3 },
    "erc.p.pA.read": ["k1"],
    "erc.p.pB.read": [],
    "erc.p.pB.ladder": { on: false, stage: 1 }
  };
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-act="open-passage"][data-id="k1"]');
    assert.ok(doc.getElementById("btnLadder").classList.contains("on"));
    assert.match(doc.getElementById("ladderStageName").textContent, /复述/);
    assert.equal(doc.getElementById("retellCard").classList.contains("hidden"), false);

    // 关掉后写回本档案
    h.clickSel(win, "#btnLadder");
    assert.equal(doc.getElementById("btnLadder").classList.contains("on"), false);
    assert.deepEqual(ladderOf(win, "pA"), { on: false, stage: 3 });

    // 换到另一个档案：它自己的偏好是关闭
    h.clickSel(win, '[data-tab="library"]');
    h.clickSel(win, '[data-act="profile-switch"][data-id="pB"]');
    const first = doc.querySelector('#passageList [data-act="open-passage"]');
    h.click(win, first);
    assert.equal(doc.getElementById("btnLadder").classList.contains("on"), false);
    assert.ok(doc.querySelectorAll("#sentences .zh").length > 0);
  }, { storage: seed });
});

test("遮住英文听一遍：先隐藏文字再朗读，停止后恢复", async function () {
  await withApp(async function ({ win, doc, calls }) {
    h.clickSel(win, '[data-act="open-passage"][data-id="k1"]');
    h.clickSel(win, "#btnLadder");
    h.clickSel(win, "#btnBlindListen");
    assert.ok(doc.getElementById("sentences").classList.contains("blind-listen"));
    assert.match(doc.getElementById("btnBlindListen").textContent, /恢复/);
    assert.ok(calls.speak.length >= 1, "应该开始朗读");

    h.clickSel(win, "#btnStop");
    assert.equal(doc.getElementById("sentences").classList.contains("blind-listen"), false);
  });
});
