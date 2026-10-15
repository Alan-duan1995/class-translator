# 课堂同传 · iPhone 自用预览版 0.1.0

原生 SwiftUI iPhone 工程，最低 iOS 17。与桌面版独立，使用手机麦克风采集线下英文会议或课堂发言。

## 已实现

- Deepgram `nova-3` 英文流式识别：边说边显示临时英文，定稿后翻译。
- DeepSeek / OpenAI 兼容接口英译简体中文：最多两条并发，参考前三段英文上下文，尝试纠正明显的识别错误；保留原始英文，不保证纠错准确。
- 停止时发送 `CloseStream`，等待最后字幕和 Metadata；六秒超时后明确提示最后一句可能不完整。
- 网络音频积压超过三秒时停止并提示；翻译失败保留英文，可在当前会话中重试。
- 双语记录逐段自动保存于应用目录，可分享导出文本、删除历史记录。
- 前台录音期间保持屏幕唤醒。进入后台、来电中断、插拔耳机时停止录音，需要手动重新开始。

## 安装到自己的 iPhone

1. 在 Mac 安装完整 **Xcode 16 或更新版**（建议使用支持你 iPhone 系统版本的最新版），完成首次启动和 iOS 平台组件安装。仅 Command Line Tools 不够。
2. 解压源代码包，打开 `ios/ClassTranslator.xcodeproj`。
3. 在 Xcode 的 Settings → Accounts 登录自己的 Apple 账号。自用测试可先使用免费 Personal Team，不需要购买会员。
4. 项目 → TARGETS → ClassTranslator → Signing & Capabilities，勾选 Automatically manage signing，选择你的 Team。若 Bundle Identifier 被占用，将 `com.alan.class-translator.ios` 改成你自己的唯一名称。
5. 用数据线连接 iPhone，解锁并信任此 Mac，按系统提示开启开发者模式。在 Xcode 顶部选中该 iPhone，点运行。
6. 首次打开应用，进入设置，填写 Deepgram key、翻译服务 key、接口和模型，并确认云端处理说明；然后允许麦克风访问。

免费 Personal Team 的安装签名有效期为七天，到期需重新通过 Xcode 签名运行。不要卸载应用来续签，以免丢失本机记录；建议先分享导出重要记录。

**没有签名的 archive 或模拟器 app 不能直接安装到 iPhone。** 本仓库不包含任何人的证书、账号、设备标识或 API key，不提供绕过苹果签名的安装方式。

## 配置和隐私

默认识别：`wss://api.deepgram.com/v1/listen`，`nova-3`，英文，单声道 PCM16，以实际麦克风采样率发送。

默认翻译：`https://api.deepseek.com/chat/completions`，模型 `deepseek-chat`（可编辑，请以你的服务商支持的模型为准）。填写**完整** `/chat/completions` 地址；必须为 HTTPS，不允许 URL 内附账号、密码、查询参数或片段。HTTP 重定向不会携带凭据跳转。

API key 仅在应用内存中保存，完全退出后需重新填写。仅保存非敏感的接口地址和模型名称。音频上传到 Deepgram；定稿英文和最多前三段上下文发送给翻译服务。服务费用由各自 API 账户承担。不保存原始音频。字幕存于受 iOS 文件保护的 Application Support，可能随系统设备备份保存；应用内可删除。

## 当前边界

这是首个 iPhone 预览版，并非桌面版全部功能的迁移。不支持系统内部音频、后台持续录音、离线模型、音频导入、桌面记录同步、说话人分组或应用内自动更新。历史记录支持查看、删除和导出；重试翻译目前仅适用于当前会话。云端翻译并非逐字流式，定稿后以整句返回。没有实际 API key 和真机的情况下，不能验证识别准确率、真实端到端延迟、蓝牙和来电中断行为。

## 验证与打包

```sh
sh ios/test-core.sh
xcodebuild -project ios/ClassTranslator.xcodeproj -scheme ClassTranslator \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath ios/build/simulator \
  CODE_SIGNING_ALLOWED=NO build
xcodebuild -project ios/ClassTranslator.xcodeproj -scheme ClassTranslator \
  -destination 'generic/platform=iOS' -archivePath ios/build/ClassTranslator.xcarchive \
  CODE_SIGNING_ALLOWED=NO archive
```

GitHub workflow `iOS preview` 运行核心数据/协议测试、模拟器编译与启动截图、未签名真机构建，并保存构建产物。源代码包可直接打开，不需要 Node.js、CocoaPods 或额外依赖。

实际安装后应测试：首次拒绝/允许麦克风、错误 key、正常英文发言、快速停止/重开、断网、翻译超时重试、锁屏/切后台、耳机插拔、导出、重启恢复及删除记录。模拟器启动成功不代表这些真机检查已通过。

参考：[Apple 自用测试账号](https://developer.apple.com/help/account/basics/about-your-developer-account)、[Deepgram CloseStream](https://developers.deepgram.com/docs/close-stream)。
