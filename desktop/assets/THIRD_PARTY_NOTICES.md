# 第三方组件与模型

课堂同传本身以 MIT 许可证发布。安装包里还包含下面这些第三方组件和模型，它们各自的许可证如下。

| 名称 | 用途 | 许可证 | 来源 |
|---|---|---|---|
| sherpa-onnx | 本地实时语音识别的运行库 | Apache-2.0 | k2-fsa 项目 |
| Kroko ASR 英语社区模型（streaming zipformer，2025-08-06） | 本地实时识别用的英语模型 | CC-BY-SA | Banafo（Kroko ASR） |
| Bergamot Translator（0.4.9） | 本地翻译的运行库 | MPL-2.0 | Bergamot 项目（browsermt），源代码见其公开仓库 |
| Firefox Translations 英语 → 简体中文模型（2.2 版） | 本地翻译用的模型 | MPL-2.0 | Mozilla |
| Silero VAD | 判断有没有人说话 | MIT | Silero Team（许可全文见 SILERO_LICENSE.txt） |
| onnxruntime-web | 运行 Silero VAD 模型 | MIT | Microsoft |
| Electron | 桌面应用框架 | MIT | OpenJS Foundation 及贡献者 |

Kroko 社区模型以 CC-BY-SA 协议提供：使用时需要署名；如果修改了模型本身并再分发，需要以相同协议分享。课堂同传没有修改该模型，原样随安装包分发。

Bergamot Translator 和 Firefox Translations 模型以 MPL-2.0 协议提供。课堂同传没有修改它们，原样随安装包分发；它们的源代码和模型文件可以从 Bergamot 项目和 Mozilla 的公开仓库获得。
