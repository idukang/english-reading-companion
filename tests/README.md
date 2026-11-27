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

## 怎么跑

```bash
npm install        # 只装 jsdom（开发依赖，不进 APK）
npm test
```

或者已经有 jsdom 的环境：

```bash
NODE_PATH=/path/to/node_modules node --test tests/app.test.js tests/pattern.test.js tests/cefr.test.js tests/quiz.test.js tests/memory.test.js tests/updater.test.js
```

## 边界

这些都是网页层的逻辑与 DOM 行为测试。真机上的听感（Supertonic 音色、音量）、麦克风收音、
蓝牙耳机、触摸手感与动画流畅度，仍然只能在手机上验收；容器里只能验证编译、签名、包结构和这些自动化行为。
