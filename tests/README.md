# 自动化测试（jsdom）

不用安卓设备、不用模拟器，在 Node.js 里把 `app/src/main/assets/www` 按 `index.html` 的顺序加载起来，
用真实的点击事件跑一遍界面流程，再检查 `localStorage` 里写下的数据。

| 文件 | 覆盖内容 |
| --- | --- |
| `app.test.js` | 现有功能回归：书库、点读、离线查词、生词本与 SRS、读后问答、导入文章、学习档案隔离、内置数据完整性、零外链 |
| `pattern.test.js` | v1.5.0 句型闯关：拆词 / 打乱 / 拼句校验 / 听写宽容校验与差异、三关句库、入口、拼对与拼错、提示与清空、单句循环、盲听、文章抽句、档案隔离、关卡解锁、整关完成、静音、返回键、进度持久化 |
| `cefr.test.js` | v1.6.0 CEFR 分级词库：A1–B2 四级数据完整性与体积、词典卡片等级标签、按等级一键加 10 词与去重、等级切换、档案隔离 |
| `quiz.test.js` | v1.6.0 选词填空 + 英汉配对：出题纯函数（挖空、同词性干扰项、5 组配对）、三入口切换、选对 / 选错反馈与统计、整句发音、收进生词本、做完一组给成绩、再来一轮、配错记薄弱点、档案隔离、返回键 |
| `updater.test.js` | v1.6.1 应用内更新：版本号比较（`1.6` = `1.6.0`、`1.10 > 1.9`）、检查结果解析与来源校验（只认 GitHub https 地址）、设置页版本显示、横幅与设置红点、更新日志与下载进度、静默检查失败不打扰、自动检查开关持久化、权限与安装/错误状态、无原生桥时不假装能更新 |
| `memory.test.js` | v1.6.0 外教记忆小本本：增删改查 / 去重 / 类型兜底 / 上限、提示词块、兴趣识别、TIP 收成薄弱点、设置页添加删除清空、对话页摘要与跳转、离线开聊带出记忆、System Prompt 注入、档案隔离 |
| `ladder.test.js` | v1.7.0 🪜 梯子模式：三阶状态机与越界保护、中文/讲解显隐规则、阅读页真实三阶切换、生词高亮、关译复述卡、遮住英文盲听、按档案记住阶段、档隔离 |
| `placement.test.js` | v1.7.0 🎯 CEFR 定级与任务卡：6 题计分与 A1–B2 阈值、结果参数与提示词、6 题完整流程、应用后加词/闯关/对话三处联动、建议语速、任务卡按等级过滤 / 换一张 / 关掉 / 档案记忆 |
| `recall.test.js` | v1.7.0 🧠 主动回忆与错因分诊：三档自评、只看英文 / 只听读音、三类错因分类与相似度、薄弱点写进记忆本并挂到生词、想起来了清标记、选词填空错因归义项 |
| `repair.test.js` | v1.7.0 卡壳修复：提示词规则、`um`/`I don't know`/省略号/乱拼识别、长句拆两个短句块、离线兜底、System Prompt 注入（含定级后的难度指令）、离线情景与读文答疑的拆句带读 |

## 怎么跑

```bash
npm install        # 只装 jsdom（开发依赖，不进 APK）
npm test
```

或者已经有 jsdom 的环境：

```bash
NODE_PATH=/path/to/node_modules node --test tests/app.test.js tests/pattern.test.js tests/cefr.test.js tests/quiz.test.js tests/memory.test.js tests/updater.test.js tests/ladder.test.js tests/placement.test.js tests/recall.test.js tests/repair.test.js
```

## 边界

这些都是网页层的逻辑与 DOM 行为测试。真机上的听感（Supertonic 音色、音量）、麦克风收音、
蓝牙耳机、触摸手感与动画流畅度，仍然只能在手机上验收；容器里只能验证编译、签名、包结构和这些自动化行为。
