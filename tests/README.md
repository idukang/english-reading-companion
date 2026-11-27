# 自动化测试（jsdom）

不用安卓设备、不用模拟器，在 Node.js 里把 `app/src/main/assets/www` 按 `index.html` 的顺序加载起来，
用真实的点击事件跑一遍界面流程，再检查 `localStorage` 里写下的数据。

| 文件 | 覆盖内容 |
| --- | --- |
| `app.test.js` | 现有功能回归：书库、点读、离线查词、生词本与 SRS、读后问答、导入文章、学习档案隔离、内置数据完整性、零外链 |
| `pattern.test.js` | v1.5.0 句型闯关：拆词 / 打乱 / 拼句校验 / 听写宽容校验与差异、三关句库、入口、拼对与拼错、提示与清空、单句循环、盲听、文章抽句、档案隔离、关卡解锁、整关完成、静音、返回键、进度持久化 |

## 怎么跑

```bash
npm install        # 只装 jsdom（开发依赖，不进 APK）
npm test
```

或者已经有 jsdom 的环境：

```bash
NODE_PATH=/path/to/node_modules node --test tests/app.test.js tests/pattern.test.js
```

## 边界

这些都是网页层的逻辑与 DOM 行为测试。真机上的听感（Supertonic 音色、音量）、麦克风收音、
蓝牙耳机、触摸手感与动画流畅度，仍然只能在手机上验收；容器里只能验证编译、签名、包结构和这些自动化行为。
