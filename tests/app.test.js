/* =========================================================
   青鸟 · 英语陪读 —— 现有功能的回归测试（jsdom，不需要安卓设备）
   覆盖：书库 / 点读 / 查词 / 生词本与 SRS / 读后问答 / 导入文章 /
        学习档案隔离 / 内置数据完整性
   ========================================================= */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const h = require("./harness.js");

async function withApp(fn, opts) {
  const app = await h.boot(opts);
  try {
    await fn(app);
  } finally {
    app.win.close();
  }
}

function profileStore(win) {
  const s = JSON.parse(win.localStorage.getItem("erc.profiles"));
  const p = s.list.filter(function (x) { return x.id === s.active; })[0];
  return { store: s, profile: p };
}

function dataOf(win, key) {
  const { profile } = profileStore(win);
  const raw = win.localStorage.getItem("erc.p." + profile.id + "." + key);
  return raw ? JSON.parse(raw) : null;
}

test("启动后书库、底栏、统计都正常", async function () {
  await withApp(async function ({ win, doc }) {
    assert.equal(doc.querySelectorAll("#passageList .item").length, 3, "少儿库应有 3 篇文章");
    assert.equal(doc.getElementById("statRead").textContent, "已读 0 篇");
    assert.equal(doc.getElementById("statWords").textContent, "生词 0 个");
    const tabs = Array.from(doc.querySelectorAll("#tabbar .tab")).map(function (b) { return b.dataset.tab; });
    assert.deepEqual(tabs, ["library", "conv", "pattern", "vocab", "settings"]);
    assert.ok(doc.getElementById("view-library").classList.contains("active"));
  });
});

test("打开文章：逐句渲染、中文对照、已读进度写进当前档案", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-act="open-passage"][data-id="k1"]');
    assert.ok(doc.getElementById("view-reader").classList.contains("active"));
    assert.equal(doc.querySelectorAll("#sentences .sent").length, 9);
    assert.match(doc.querySelector("#sentences .sent .en").textContent, /The sun is up/);
    assert.match(doc.querySelector("#sentences .sent .zh").textContent, /太阳升起来了/);
    assert.equal(doc.getElementById("statRead").textContent, "已读 1 篇");
    assert.deepEqual(dataOf(win, "read"), ["k1"]);
  });
});

test("点句子会用原生 TTS 读整句（去掉 [[ ]] 高亮标记）", async function () {
  await withApp(async function ({ win, doc, calls }) {
    h.clickSel(win, '[data-act="open-passage"][data-id="k1"]');
    h.clickSel(win, '#sentences .sent[data-idx="1"] .en');
    assert.equal(calls.speak.length, 1);
    assert.equal(calls.speak[0].text, "I wake up at seven.");
    assert.equal(calls.speak[0].lang, "en-US");
  });
});

test("点单词会打开离线词库卡片，并能加入生词本", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-act="open-passage"][data-id="k1"]');
    const word = doc.querySelector('#sentences .sent[data-idx="0"] .w');
    assert.equal(word.textContent, "The");
    h.click(win, word);
    assert.ok(!doc.getElementById("wordMask").classList.contains("hidden"));
    assert.equal(doc.getElementById("wWord").textContent, "the");
    h.clickSel(win, "#wAdd");
    assert.equal(doc.getElementById("wAdd").textContent, "✔️ 已在生词本");
    const vocab = dataOf(win, "vocab");
    assert.equal(vocab.length, 1);
    assert.equal(vocab[0].w, "the");
    h.clickSel(win, "#wClose");
  });
});

test("离线词库支持词形还原（spotted → spot / went → go）", async function () {
  await withApp(async function ({ win }) {
    const spotted = win.dictLookup("spotted");
    const went = win.dictLookup("went");
    assert.ok(spotted, "spotted 应该能查到");
    assert.equal(spotted.matched, "spot");
    assert.ok(went);
    assert.equal(went.matched, "go");
    assert.ok(win.eval("DICT_COUNT") > 400);
  });
});

test("读后问答：关键词命中给正反馈，中文作答也接受", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-act="open-passage"][data-id="k1"]');
    h.type(win, '.qa-input[data-qi="0"]', "seven");
    h.clickSel(win, '[data-act="qa-check"][data-qi="0"]');
    const fb = doc.querySelector('[data-fb="0"]');
    assert.ok(fb.classList.contains("good"));
    assert.match(fb.textContent, /答对了/);
  });
});

test("导入自己的文章：切句后立刻能读，并记进本档案", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, "#btnCustomOpen");
    h.type(win, "#cTitle", "My Test");
    h.type(win, "#cText", "This is my first sentence. And here is the second one! Is it three now? Yes.");
    h.clickSel(win, "#cSave");
    assert.ok(doc.getElementById("view-reader").classList.contains("active"));
    assert.equal(doc.querySelectorAll("#sentences .sent").length, 4);
    assert.equal(dataOf(win, "custom").length, 1);
    assert.equal(dataOf(win, "custom")[0].title, "My Test");
  });
});

test("学习档案：切换档案后已读与生词完全分开", async function () {
  const seed = {
    "erc.profiles": {
      active: "pA",
      list: [
        { id: "pA", name: "A", emoji: "🧸", tier: "kids", speed: 1, voice: "neural", created: 1 },
        { id: "pB", name: "B", emoji: "🎒", tier: "teen", speed: 1, voice: "neural", created: 2 }
      ]
    },
    "erc.p.pA.read": ["k1"],
    "erc.p.pA.vocab": [{ w: "sun", ts: 1 }],
    "erc.p.pB.read": [],
    "erc.p.pB.vocab": []
  };
  await withApp(async function ({ win, doc }) {
    assert.equal(doc.getElementById("statRead").textContent, "已读 1 篇");
    assert.equal(doc.getElementById("statWords").textContent, "生词 1 个");
    h.clickSel(win, '[data-act="profile-switch"][data-id="pB"]');
    assert.equal(doc.getElementById("statRead").textContent, "已读 0 篇");
    assert.equal(profileStore(win).profile.id, "pB");
    h.clickSel(win, '[data-act="profile-switch"][data-id="pA"]');
    assert.equal(doc.getElementById("statRead").textContent, "已读 1 篇");
  }, { storage: seed });
});

test("生词卡片复习：记住了 → 间隔按 1 天后排", async function () {
  const seed = {
    "erc.profiles": {
      active: "pS",
      list: [{ id: "pS", name: "S", emoji: "🧸", tier: "kids", speed: 1, voice: "neural", created: 1 }]
    },
    "erc.p.pS.vocab": [{ w: "apple", head: "apple", ts: 1 }]
  };
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-tab="vocab"]');
    h.clickSel(win, "#btnReview");
    assert.ok(!doc.getElementById("flashWrap").classList.contains("hidden"));
    h.clickSel(win, "#flashKnow");
    const vocab = dataOf(win, "vocab");
    assert.equal(vocab[0].reps, 1);
    assert.equal(vocab[0].intervalDays, 1);
    assert.ok(vocab[0].dueAt > Date.now());
  }, { storage: seed });
});

test("内置书库数据完整：句数与中文一一对应，问答有参考答案", async function () {
  await withApp(async function ({ win }) {
    const LIBRARY = win.eval("LIBRARY");
    assert.equal(win.eval("TIERS").length, 3);
    ["kids", "teen", "adult"].forEach(function (tier) {
      assert.equal(LIBRARY[tier].length, 3, tier + " 应有 3 篇");
      LIBRARY[tier].forEach(function (item) {
        assert.ok(item.id && item.title);
        assert.equal(item.sentences.length, item.zh.length, item.id + " 句子与译文数量应一致");
        item.qa.forEach(function (q) {
          assert.ok(q.q && q.answer && Array.isArray(q.groups));
        });
      });
    });
  });
});

test("界面零外链：不加载任何远程脚本、样式或统计", function () {
  const html = fs.readFileSync(path.join(h.WWW, "index.html"), "utf8");
  assert.equal(/<script[^>]+src="https?:/i.test(html), false);
  assert.equal(/<link[^>]+href="https?:/i.test(html), false);
  assert.equal(/googletagmanager|google-analytics|umami|posthog|sentry/i.test(html), false);
  // 句型闯关的句库与工具是纯本地数据，不联网
  const challenge = fs.readFileSync(path.join(h.WWW, "challenge.js"), "utf8");
  assert.equal(/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon/.test(challenge), false);
});
