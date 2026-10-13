# v0.8.0 说明与实现对照

核对日期：2026-10-13。范围：桌面版公开使用说明、前后端功能入口、Swift 助手、设置与文件存储、构建配置、发布资源及现有测试。根目录 Python 网页版单独保留，不包含桌面版新增的全部能力；历史计划不作为当前使用说明。

| 说明项目 | 当前实现及限制 | 代码入口（仓库相对路径） |
|---|---|---|
| 支持系统 | 安装配置最低 macOS 12；苹果识别/翻译 macOS 26；Mac 系统声音 macOS 14.2；Windows 有系统回环 | `desktop/electron-builder.yml`、`desktop/src/main/platform.js`、`apple_asr/` |
| 五种识别方式 | 苹果、本地 Kroko 英语、Gemini 分段、自定义分段接口、Deepgram 英语流式 | `desktop/src/main/main.js`、`desktop/src/main/session.js`、`desktop/src/main/cloud/`、`desktop/src/main/local/` |
| Deepgram | `nova-3`、英语、16 kHz 单声道 PCM、临时结果、说话人区分；不负责翻译 | `desktop/src/main/cloud/deepgram-asr.js` |
| Deepgram 重试 | 默认累计两次异常退出后停止；开启补转写后继续尝试重连，结束时批量补缺失音频，失败留存重试 | `desktop/src/main/session.js` |
| 自定义转写 | `/audio/transcriptions`，WAV multipart；远端 HTTPS + Key，本机可 HTTP 且免 Key；保存不上传测试音频 | `desktop/src/main/cloud/openai-asr.js`、`desktop/src/main/api.js` |
| AI 翻译纠错 | 当前句加前三句原文作上下文；纠错体现在译文，原始字幕不被改写 | `desktop/src/main/llm/index.js`、`desktop/src/main/llm/prompts.js` |
| 翻译失败回退 | 尝试苹果/本地直译；本地只支持英译简中；苹果语言包缺失时也可能尝试已配置的 AI 服务 | `desktop/src/main/session.js` |
| 模型配置 | DeepSeek 预设为 `deepseek-flash`；Gemini 自动模式按候选列表轮换；这些是代码配置，不代表账户一定有权限或免费额度 | `desktop/src/main/langs.js`、`desktop/src/main/llm/gemini.js` |
| 课堂笔记 | 收到定稿时检查 180 秒间隔；只追加新内容；失败后设为约 30 秒重试，仍需新定稿触发 | `desktop/src/main/session.js`、`desktop/src/main/langs.js` |
| 课后精讲 | 结束完成后自动发起；至少 3 条转写，且配置可用 AI；可选择历史课程重新生成 | `desktop/src/renderer/app.js`、`desktop/src/main/api.js` |
| 导出与历史 | 笔记导出 Markdown；精讲导出 Markdown/PDF；原始转写自动保存在课堂记录 Markdown 中 | `desktop/src/renderer/app.js`、`desktop/src/main/pdf.js`、`desktop/src/main/store/records.js` |
| 录音 | 默认关闭；16 kHz/16-bit/mono WAV，90 分钟约 173 MB（165 MiB）；保留 0/3/7/30 天 | `desktop/src/main/store/audio.js`、`desktop/src/main/api.js` |
| 清理时机 | 启动、运行中每 6 小时、修改保留天数时；App 关闭时没有后台清理任务 | `desktop/src/main/main.js` |
| Key | 本地加密、界面仅末四位；使用时发送给对应接口认证；Mac 使用文件加密并支持旧钥匙串迁移 | `desktop/src/main/store/settings.js`、`desktop/src/main/store/filecrypto.js` |
| 更新 | 启动/手动查询 GitHub Release；按平台下载、SHA-256 校验、忙碌时禁止打开安装包；不静默替换程序 | `desktop/src/main/installer-update.js`、`desktop/src/renderer/app.js` |
| 开发与发布 | `npm start` 包含 Mac Swift 编译；Windows CI 有独立模型准备步骤；v0.8.0 发布工作流从同一提交构建四种安装包 | `desktop/package.json`、`desktop/scripts/`、`.github/workflows/` |
| 防睡眠与音量 | 活跃会话/精讲任务持有系统防睡眠令牌；100ms 间隔测量 PCM 音量；结束释放 | `desktop/src/main/activity.js`、`desktop/src/main/ipc.js` |
| 连接状态 | Deepgram 连接/重连/停止持久提示；主动开启缓存可在结束后补转写 | `desktop/src/main/cloud/deepgram-asr.js`、`desktop/src/main/session.js` |

## 本次修订

- 更新旧版下载名称，与 v0.8.0 Release 的四个真实安装包文件名一致。
- 补齐识别方式、云端数据去向、翻译纠错边界和 AI 服务前提。
- 去掉“所有 Gemini 模型均有每日免费额度”等无法由代码保证的说法。
- 明确清理时机、Mac 开发依赖、Windows 构建路径和旧网页版本范围。
- 历史计划只作背景；当前悬浮字幕已实现，旧版密钥保存方案等不作为当前说明。

## 验证与剩余限制

- v0.8.0 本地现有测试 204 项全部通过（使用 `node --test --test-concurrency=1 "test/**/*.test.js"`）。此前并行运行出现过系统音频启动测试的 1.5 秒等待超时；顺序运行通过，但该测试仍存在环境敏感性。
- 本次没有使用真实云端 Key 验证全部模型的账户权限、费用、识别准确率或网络稳定性；模型候选列表不等同于服务商当前可用列表。
- 未逐台验证 Windows、Intel Mac 和最低 macOS 版本；平台支持表依据代码门槛与打包配置。
- v0.8.0 保留更新下载、防睡眠、输入音量及连接状态；作者和应用标识保持 v0.7.3 的 Alan 配置。
- 文档一致性检查不是完整代码安全审计，也不证明所有运行场景没有缺陷。

## v0.8.0 新能力

| 功能 | 实现与边界 | 入口 |
|---|---|---|
| 术语表 | 40 行/1500 字符；Deepgram 只取前 400 字节术语，AI/Gemini 参考完整列表；不是确定性替换 | `glossary.js`、`llm/index.js` |
| 补转写 | 默认关、仅 Deepgram 英语；2 小时缓存上限；结束时处理未确认时段，失败每分钟空闲重试或手动重试；7 天运行中清理；分块提交避免重复重试 | `audio-jobs.js`、`session.js` |
| 导入 | 50 MB/30 分钟；浏览器解码到 mono PCM；Deepgram 120 秒或其它服务 8 秒一段；取消保留已处理文字，重启不续传 | `renderer/library.js`、`audio-jobs.js` |
| 编辑与管理 | JSON 为结构化记录，Markdown 同步导出；版本号防覆盖；旧 MD 可迁移；全文搜索、标题/分类、按句编辑重译；修改使衍生报告失效 | `store/records.js`、`library-api.js` |
| 说话人 | 记录内名字映射；导入各片段编号独立，无自动跨片段身份匹配 | `store/records.js`、`renderer/library.js` |
| 会议纪要 | 至少 3 条转写；LLM 输出摘要、决策、待办和未决事项；独立 `_会议纪要.md`；未指定内容不推断 | `api.js`、`llm/index.js` |
| 悬浮字幕 | 独立 always-on-top 窗口，仅接收字幕消息，无通用主进程接口 | `main.js`、`preload/overlay.cjs`、`renderer/overlay.js` |

新增自动测试覆盖：编辑保存及冲突、旧格式迁移、纪要独立保存、术语限制、导入取消清理、恢复成功/失败/部分提交重试、最终已确认音频不重复补回、缓存缺失不谎报成功、重启导入临时文件清理。云端请求使用模拟响应，未消耗真实 API 额度。桌面交互验证使用独立资料，覆盖设置保存、记录改名/分类/原文编辑/搜索和置顶窗口。
