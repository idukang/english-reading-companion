/* =========================================================
   v1.6.0：CEFR 分级词库 + 按等级加词 的自动化测试
   —— 数据完整性（等级 / 释义 / 体积）+ jsdom 里的真实点击
   ========================================================= */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const h = require("./harness.js");
const cefr = require("../app/src/main/assets/www/cefr.js");

const CEFR = cefr.CEFR;
const WORDS = cefr.CEFR_WORDS;

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

function vocabOf(win, id) {
  const raw = win.localStorage.getItem("erc.p." + (id || activeId(win)) + ".vocab");
  return raw ? JSON.parse(raw) : [];
}

/* ------------------------- 数据 ------------------------- */

test("CEFR 词库：A1–B2 四级各有足够的学习词，字段齐全且不重复", function () {
  assert.deepEqual(CEFR.levels, ["A1", "A2", "B1", "B2"]);
  assert.ok(WORDS.length >= 500, "词库应覆盖 500+ 词，实际 " + WORDS.length);

  const seen = new Set();
  const counts = { A1: 0, A2: 0, B1: 0, B2: 0 };
  WORDS.forEach(function (e) {
    assert.match(e.w, /^[a-z]+$/, "单词应为小写原形：" + e.w);
    assert.ok(CEFR.levels.indexOf(e.lv) >= 0, "等级必须合法：" + e.w + " / " + e.lv);
    assert.ok(e.z && e.z.length >= 1, "每个词都要有中文释义：" + e.w);
    assert.ok(e.p, "每个词都要有词性：" + e.w);
    assert.equal(seen.has(e.w), false, "词不应重复：" + e.w);
    seen.add(e.w);
    counts[e.lv]++;
  });
  ["A1", "A2", "B1", "B2"].forEach(function (lv) {
    assert.ok(counts[lv] >= 30, lv + " 至少要有 30 个词，实际 " + counts[lv]);
  });
});

test("CEFR 词库：打包体量轻，不塞 6 MB 全量词表", function () {
  const file = path.join(h.WWW, "cefr.js");
  const kb = fs.statSync(file).size / 1024;
  assert.ok(kb < 200, "cefr.js 应小于 200 KB，实际 " + kb.toFixed(1) + " KB");
  assert.ok(kb > 20, "词库不应为空，实际 " + kb.toFixed(1) + " KB");
});

test("CEFR 词库：能按原形查等级，出题池都在四级之内", function () {
  assert.equal(CEFR.levelOf("sun"), "A1");
  assert.equal(CEFR.levelOf("Sun"), "A1");
  assert.equal(CEFR.levelOf("evidence"), "B2");
  assert.equal(CEFR.levelOf("不存在的词"), "");
  CEFR.levels.forEach(function (lv) {
    const pool = CEFR.pool(lv);
    assert.ok(pool.length >= 30, lv + " 可出题词条应足够");
    pool.forEach(function (e) {
      assert.equal(e.lv, lv);
      assert.notEqual(e.u, false);
    });
  });
});

/* ------------------------- 界面 ------------------------- */

test("词典卡片显示 CEFR 等级标签", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-act="open-passage"][data-id="k1"]');
    h.click(win, doc.querySelector('.w[data-w="sun"]'));
    assert.equal(doc.getElementById("wordMask").classList.contains("hidden"), false);
    assert.equal(doc.getElementById("wCefr").textContent, "A1");
    assert.match(doc.getElementById("wCefr").className, /cefr-tag/);
  });
});

test("生词本：按 A1 一键加 10 词，自动去重并带上等级标签", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-tab="vocab"]');
    assert.ok(doc.getElementById("cefrCard"), "生词本页应有按等级加词卡片");
    assert.match(doc.getElementById("btnCefrImport").textContent, /加入 10 个 A1 词/);

    h.clickSel(win, "#btnCefrImport");
    const first = vocabOf(win);
    assert.equal(first.length, 10);
    first.forEach(function (v) {
      assert.equal(v.lv, "A1", "从 A1 导入的词应带 A1 标签");
      assert.ok(v.zh && v.zh.length > 0, "导入的词要有中文释义：" + v.w);
    });
    assert.equal(new Set(first.map(function (v) { return v.w; })).size, 10);

    // 再来一次：不会重复加已经有的 10 个词
    h.clickSel(win, "#btnCefrImport");
    const second = vocabOf(win);
    assert.equal(second.length, 20);
    assert.equal(new Set(second.map(function (v) { return v.w; })).size, 20);
    assert.ok(doc.querySelector(".v-word .cefr-tag"), "生词列表应显示等级标签");
  });
});

test("生词本：换 A2 / B1 / B2 导入，等级标签跟着变", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-tab="vocab"]');
    ["A1", "A2", "B1", "B2"].forEach(function (lv) {
      h.click(win, doc.querySelector('#cefrSeg [data-lv="' + lv + '"]'));
      assert.match(doc.getElementById("btnCefrImport").textContent, new RegExp(lv));
      h.clickSel(win, "#btnCefrImport");
      const vocab = vocabOf(win);
      assert.equal(vocab.slice(0, 10).filter(function (v) { return v.lv === lv; }).length, 10, lv + " 应导入 10 个");
    });
    const all = vocabOf(win);
    assert.equal(all.length, 40);
    assert.equal(new Set(all.map(function (v) { return v.w; })).size, 40);
  });
});

test("按等级加词按学习档案隔离：新档案从 0 开始", async function () {
  await withApp(async function ({ win, doc }) {
    h.clickSel(win, '[data-tab="vocab"]');
    h.clickSel(win, "#btnCefrImport");
    const first = activeId(win);
    assert.equal(vocabOf(win, first).length, 10);

    h.clickSel(win, '[data-tab="settings"]');
    h.clickSel(win, "#btnProfileNew");
    h.type(win, "#pName", "妹妹");
    h.clickSel(win, "#profileSave");
    const second = activeId(win);
    assert.notEqual(second, first);

    h.clickSel(win, '[data-tab="vocab"]');
    assert.equal(vocabOf(win, second).length, 0, "新档案不应继承别人的生词");
    assert.match(doc.getElementById("cefrLeft").textContent, /没进生词本/);

    // 新档案也能独立加词
    h.clickSel(win, "#btnCefrImport");
    assert.equal(vocabOf(win, second).length, 10);
    assert.equal(vocabOf(win, first).length, 10, "第一个档案不受影响");
  });
});
