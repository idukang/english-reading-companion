/* =========================================================
   v1.6.0：外教「学习记忆小本本」的自动化测试
   —— 纯函数增删改查 / 提示词注入 / 离线问候 / 档案隔离
   ========================================================= */

const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./harness.js");
const { MemoryBook, MEMORY_TYPES } = require("../app/src/main/assets/www/memory-book.js");

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

function memoryOf(win, id) {
  const raw = win.localStorage.getItem("erc.p." + (id || activeId(win)) + ".memory");
  return raw ? JSON.parse(raw) : [];
}

/* ------------------------- 纯函数 ------------------------- */

test("记忆本：增删改查、同类型去重、类型兜底", function () {
  let list = [];
  let r = MemoryBook.add(list, "weak", "总是忘记第三人称单数 -s");
  assert.equal(r.added, true);
  list = r.list;
  assert.equal(list.length, 1);
  assert.equal(list[0].type, "weak");
  assert.equal(list[0].src, "manual");

  // 重复内容不加
  r = MemoryBook.add(list, "weak", "  总是忘记第三人称单数 -s ");
  assert.equal(r.added, false);
  assert.equal(r.duplicate, true);
  assert.equal(r.list.length, 1);

  // 同内容不同类型可以分别记
  r = MemoryBook.add(list, "interest", "总是忘记第三人称单数 -s");
  assert.equal(r.added, true);
  list = r.list;
  assert.equal(list.length, 2);

  // 未知类型落到「其他」
  r = MemoryBook.add(list, "weird", "喜欢篮球");
  list = r.list;
  assert.equal(list[0].type, "note");

  // 修改
  const id = list[0].id;
  list = MemoryBook.update(list, id, "喜欢篮球和羽毛球");
  assert.equal(list.filter(function (m) { return m.id === id; })[0].text, "喜欢篮球和羽毛球");

  // 删除
  list = MemoryBook.remove(list, id);
  assert.equal(list.some(function (m) { return m.id === id; }), false);

  // 清空
  assert.deepEqual(MemoryBook.clear(), []);
});

test("记忆本：脏数据会被洗干净，最多记 60 条、新的在前", function () {
  const dirty = [
    null,
    { type: "weak", text: "  " },
    { type: "bad", text: "一条" },
    { type: "interest", text: "篮球" },
    "字符串",
    { type: "interest", text: "篮球" }
  ];
  const clean = MemoryBook.clean(dirty);
  assert.equal(clean.length, 2);
  assert.deepEqual(clean.map(function (m) { return m.type; }).sort(), ["interest", "note"]);
  assert.equal(clean.filter(function (m) { return m.text === "篮球"; }).length, 1);

  let list = [];
  for (let i = 0; i < 70; i++) {
    list = MemoryBook.add(list, "note", "第 " + i + " 条").list;
  }
  assert.equal(list.length, MemoryBook.MAX);
  assert.equal(list[0].text, "第 69 条");
  assert.equal(list[MemoryBook.MAX - 1].text, "第 10 条");
});

test("记忆本：提示词块分类清楚，空记忆不产生多余文本", function () {
  assert.equal(MemoryBook.promptBlock([]), "");
  const list = MemoryBook.clean([
    { type: "weak", text: "第三人称单数" },
    { type: "interest", text: "篮球" },
    { type: "style", text: "先中文解释" }
  ]);
  const block = MemoryBook.promptBlock(list);
  assert.match(block, /外教记忆小本本/);
  assert.match(block, /薄弱点：第三人称单数/);
  assert.match(block, /兴趣主题：篮球/);
  assert.match(block, /口语偏好：先中文解释/);
  assert.match(block, /不要逐条复述/);

  const brief = MemoryBook.brief(list, 2);
  assert.match(brief, /第三人称单数/);
  assert.equal(brief.split(" · ").length, 2);
});

test("记忆本：能从用户的话里认出兴趣，也能把 TIP 收成薄弱点", function () {
  assert.equal(MemoryBook.interestFrom("I really like basketball."), "basketball");
  assert.equal(MemoryBook.interestFrom("I love playing the guitar because it is fun."), "playing the guitar");
  assert.equal(MemoryBook.interestFrom("我特别喜欢打篮球。"), "打篮球");
  assert.equal(MemoryBook.interestFrom("今天天气不错"), "");
  assert.equal(MemoryBook.interestFrom("I like it."), "");
  assert.equal(MemoryBook.interestFrom("I love it because it is fun."), "");

  const weak = MemoryBook.weakFromTip("你说的是 I goes to school，第三人称单数要加 -s。再试一次。");
  assert.match(weak, /第三人称单数/);
  assert.equal(weak.length <= 60, true);
});

test("记忆类型：四类都在界面上有名字", function () {
  assert.deepEqual(MEMORY_TYPES.map(function (t) { return t.id; }), ["weak", "interest", "style", "note"]);
  assert.equal(MemoryBook.typeName("weak"), "薄弱点");
  assert.equal(MemoryBook.typeName("interest"), "兴趣主题");
  assert.equal(MemoryBook.typeName("style"), "口语偏好");
  assert.equal(MemoryBook.typeName("note"), "其他");
});

/* ------------------------- 界面 ------------------------- */

test("设置页：手动添加、删除、清空记忆，数据只在本机", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-tab="settings"]');
    assert.ok(doc.getElementById("memoryCard"), "设置页应有记忆小本本");
    assert.match(doc.getElementById("memoryList").textContent, /还没有任何记忆/);

    h.type(win, "#memInput", "总是忘记第三人称单数");
    h.clickSel(win, "#btnMemAdd");
    let mem = memoryOf(win);
    assert.equal(mem.length, 1);
    assert.equal(mem[0].text, "总是忘记第三人称单数");
    assert.equal(mem[0].src, "manual");
    assert.match(doc.getElementById("memoryList").textContent, /第三人称单数/);

    // 切到「兴趣」再加一条
    h.click(win, doc.querySelector('#memTypeSeg [data-mt="interest"]'));
    h.type(win, "#memInput", "篮球");
    h.clickSel(win, "#btnMemAdd");
    mem = memoryOf(win);
    assert.equal(mem.length, 2);
    assert.equal(mem[0].type, "interest");

    // 重复内容不再加
    h.type(win, "#memInput", "篮球");
    h.clickSel(win, "#btnMemAdd");
    assert.equal(memoryOf(win).length, 2);

    // 删掉一条
    h.click(win, doc.querySelector('#memoryList [data-act="mem-del"]'));
    assert.equal(memoryOf(win).length, 1);
    assert.match(doc.getElementById("memoryList").textContent, /第三人称单数/);

    // 清空
    h.clickSel(win, "#btnMemClear");
    assert.deepEqual(memoryOf(win), []);
    assert.match(doc.getElementById("memoryList").textContent, /还没有任何记忆/);
  });
});

test("对话页：显示外教记得的要点，并能跳到设置管理", async function () {
  const seed = {
    "erc.profiles": { active: "pM", list: [{ id: "pM", name: "M", emoji: "🧸", tier: "kids", speed: 1, voice: "neural", created: 1 }] },
    "erc.p.pM.memory": [
      { id: "m1", type: "weak", text: "第三人称单数", src: "auto", ts: 2 },
      { id: "m2", type: "interest", text: "篮球", src: "manual", ts: 1 }
    ]
  };
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-tab="conv"]');
    const brief = doc.getElementById("memBrief").textContent;
    assert.match(brief, /第三人称单数/);
    assert.match(brief, /篮球/);
    h.click(win, doc.querySelector('[data-act="goto-memory"]'));
    assert.ok(doc.getElementById("view-settings").classList.contains("active"));
    assert.match(doc.getElementById("memoryList").textContent, /篮球/);
  }, { storage: seed });
});

test("外教 System Prompt 会带上记忆要点（配置了 AI 接口时）", async function () {
  const seed = {
    "erc.profiles": { active: "pA", list: [{ id: "pA", name: "A", emoji: "🎒", tier: "teen", speed: 1, voice: "neural", created: 1 }] },
    "erc.p.pA.memory": [
      { id: "m1", type: "weak", text: "过去式不规则变化", src: "auto", ts: 2 },
      { id: "m2", type: "style", text: "语速慢一点", src: "manual", ts: 1 }
    ]
  };
  await withApp(async function ({ win }) {
    const prompt = win.App.inspect.AI.systemPrompt();
    assert.match(prompt, /外教记忆小本本/);
    assert.match(prompt, /过去式不规则变化/);
    assert.match(prompt, /语速慢一点/);
  }, { storage: seed });
});

test("离线开聊：问候后体贴地带出记忆", async function () {
  const seed = {
    "erc.profiles": { active: "pB", list: [{ id: "pB", name: "B", emoji: "🧸", tier: "kids", speed: 1, voice: "neural", created: 1 }] },
    "erc.p.pB.memory": [{ id: "m1", type: "interest", text: "恐龙", src: "manual", ts: 1 }]
  };
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-tab="conv"]');
    const first = doc.querySelector('#scenarioList [data-act="open-scenario"]');
    assert.ok(first, "情景列表应有可点的情景");
    h.click(win, first);
    const stream = doc.getElementById("chatStream");
    assert.match(stream.textContent, /我记得/);
    assert.match(stream.textContent, /恐龙/);
  }, { storage: seed });
});

test("记忆按档案隔离：换档案就是另一本，互不串", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-tab="settings"]');
    h.type(win, "#memInput", "第一个档案的记忆");
    h.clickSel(win, "#btnMemAdd");
    const first = activeId(win);
    assert.equal(memoryOf(win, first).length, 1);

    h.clickSel(win, "#btnProfileNew");
    h.type(win, "#pName", "妈妈");
    h.clickSel(win, "#profileSave");
    const second = activeId(win);
    assert.notEqual(second, first);
    assert.deepEqual(memoryOf(win, second), []);
    assert.match(doc.getElementById("memoryList").textContent, /还没有任何记忆/);

    h.type(win, "#memInput", "第二个档案的记忆");
    h.clickSel(win, "#btnMemAdd");
    assert.equal(memoryOf(win, second).length, 1);
    assert.equal(memoryOf(win, first)[0].text, "第一个档案的记忆");

    // 切回第一个档案，记忆跟着回来
    h.clickSel(win, '[data-tab="library"]');
    h.clickSel(win, '[data-act="profile-switch"][data-id="' + first + '"]');
    h.clickSel(win, '[data-tab="settings"]');
    assert.match(doc.getElementById("memoryList").textContent, /第一个档案的记忆/);
    assert.equal(doc.getElementById("memoryList").textContent.indexOf("第二个档案的记忆"), -1);
  });
});
