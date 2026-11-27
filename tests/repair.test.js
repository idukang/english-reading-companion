/* =========================================================
   v1.7.0：外教「卡壳修复（Repair）」 的自动化测试
   —— 提示词注入、卡壳识别、拆句、离线兜底带读
   ========================================================= */

const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./harness.js");
const { Repair } = require("../app/src/main/assets/www/repair.js");

async function withApp(fn, opts) {
  const app = await h.boot(opts);
  try {
    await fn(app);
  } finally {
    app.win.close();
  }
}

/* ------------------------- 纯函数 ------------------------- */

test("修复：提示词要求先鼓励再确认、拆两句块带读，不许直接丢长答案", function () {
  const block = Repair.promptBlock();
  assert.match(block, /卡壳修复/);
  assert.match(block, /鼓励/);
  assert.match(block, /复述确认/);
  assert.match(block, /两个短句块/);
  assert.match(block, /长标准答案/);
  assert.match(block, /一次只修一个/);
});

test("修复：能认出 um / I don't know / 说到一半断掉 / 乱拼", function () {
  ["um", "Um...", "hmm", "I don't know", "dunno", "not sure", "help", "...", "I want to...", "sdfghj"].forEach(function (s) {
    assert.equal(Repair.isStuck(s), true, "应算卡壳：" + s);
  });
  ["Yes", "No, thanks.", "I went to the park yesterday.", "Seven.", "Could you say that again?"].forEach(function (s) {
    assert.equal(Repair.isStuck(s), false, "不应算卡壳：" + s);
  });
  assert.equal(Repair.isStuck(""), false);
});

test("修复：把长句拆成两个能呼吸的短句块", function () {
  assert.deepEqual(Repair.chunks("Hi."), ["Hi."]);
  const a = Repair.chunks("I want to go to the park, because it is sunny today.");
  assert.equal(a.length, 2);
  assert.match(a[0], /park/);
  assert.match(a[1], /because/);

  const b = Repair.chunks("I think we should leave now because the last train is at eleven.");
  assert.equal(b.length, 2);
  assert.match(b[1], /^because/);

  const c = Repair.chunks("The quick brown fox jumps over the lazy dog");
  assert.equal(c.length, 2);
  assert.equal(c.join(" ").replace(/\s+/g, " "), "The quick brown fox jumps over the lazy dog");
});

test("修复：离线兜底给一句英文 + 一句中文 + 拆好的片段", function () {
  const line = Repair.offlineLine("I want to go to the park because it is sunny.");
  assert.ok(line.parts.length === 2);
  assert.match(line.en, /two small parts/i);
  assert.match(line.en, /park/);
  assert.match(line.zh, /别急/);
  assert.match(line.zh, /拆成两小步/);
});

/* ------------------------- 界 面 ------------------------- */

test("System Prompt 注入修复规则；定级后还会带上学生水平", async function () {
  const seed = {
    "erc.profiles": {
      active: "pA",
      list: [{ id: "pA", name: "A", emoji: "🎒", tier: "teen", speed: 1, voice: "neural", created: 1, cefr: "B1" }]
    }
  };
  await withApp(async function ({ win }) {
    const prompt = win.App.inspect.AI.systemPrompt();
    assert.match(prompt, /卡壳修复/);
    assert.match(prompt, /两个短句块/);
    assert.match(prompt, /学生水平 · CEFR B1/);
    assert.match(prompt, /正常语速/);
  }, { storage: seed });

  // 没定级时不硬塞水平指令
  await withApp(async function ({ win }) {
    const prompt = win.App.inspect.AI.systemPrompt();
    assert.match(prompt, /卡壳修复/);
    assert.equal(/学生水平 · CEFR/.test(prompt), false);
  });
});

test("离线情景对话：只回一个 um 时先拆句带读，不会跳下一轮", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-tab="conv"]');
    const first = doc.querySelector('#scenarioList [data-act="open-scenario"]');
    h.click(win, first);
    const stream = doc.getElementById("chatStream");
    const before = stream.querySelectorAll(".bubble.partner").length;

    h.type(win, "#chatText", "um");
    h.clickSel(win, "#btnSend");

    const text = stream.textContent;
    assert.match(text, /拆成两小步/);
    assert.ok(stream.querySelectorAll(".repair-chunk").length >= 1, "应给出可以点的短句块");
    assert.match(doc.getElementById("chatHintLine").textContent, /跟着念/);
    // 没有推进到下一秒台词：伙伴气泡只多了修复这一句系统提示
    assert.ok(stream.querySelectorAll(".bubble.partner").length <= before + 1);
  });
});

test("读文章问外教（离线）：说不会时把选中句拆成两半带读", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-act="open-passage"][data-id="k1"]');
    h.click(win, doc.querySelector('#sentences .sent[data-idx="1"] .en'));
    h.clickSel(win, "#btnAskTutor");
    assert.ok(doc.getElementById("view-chat").classList.contains("active"));

    h.type(win, "#chatText", "I don't know");
    h.clickSel(win, "#btnSend");
    const text = doc.getElementById("chatStream").textContent;
    assert.match(text, /拆成两半/);
    assert.ok(doc.querySelectorAll("#chatStream .repair-chunk").length >= 1);
  });
});
