import SwiftUI
import AVFoundation

@main struct ClassTranslatorApp: App {
    @StateObject private var model = TranslatorModel()
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            MainView().environmentObject(model)
                .onChange(of: scenePhase) { _, phase in
                    if phase == .background { model.stop(reason: "已切到后台，录音已停止；回到应用后可重新开始") }
                }
                .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)) { _ in
                    model.stop(reason: "录音被来电或其他音频中断，请重新开始")
                }
                .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.routeChangeNotification)) { event in
                    guard let raw = event.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                          let reason = AVAudioSession.RouteChangeReason(rawValue: raw),
                          reason == .oldDeviceUnavailable || reason == .newDeviceAvailable else { return }
                    model.stop(reason: "麦克风或耳机已切换，请重新开始以使用新的输入设备")
                }
        }
    }
}

struct MainView: View {
    @EnvironmentObject var model: TranslatorModel
    @State private var settings = false
    @State private var records = false
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                HStack {
                    Image(systemName: model.phase == .listening ? "waveform" : "mic")
                        .foregroundStyle(model.phase == .listening ? .red : .blue)
                    Text(model.status).font(.subheadline.weight(.medium))
                    Spacer()
                    Text("EN → 中文").font(.caption).foregroundStyle(.secondary)
                }.padding().background(.thinMaterial)
                if !model.notice.isEmpty { Text(model.notice).font(.callout).foregroundStyle(.orange).padding(.horizontal).padding(.top, 8) }
                if !model.storageIssue.isEmpty { Text(model.storageIssue).font(.callout).foregroundStyle(.red).padding(8) }
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 16) {
                            if model.current.captions.isEmpty && model.partial.isEmpty {
                                ContentUnavailableView("听见英语，看见中文", systemImage: "waveform", description: Text("在设置中填写 API key，开始后将手机放在发言人附近。\n使用时请保持应用在前台。"))
                            }
                            ForEach(model.current.captions) { line in
                                VStack(alignment: .leading, spacing: 8) {
                                    Text(line.english).font(.body).foregroundStyle(.secondary)
                                    if !line.chinese.isEmpty { Text(line.chinese).font(.title3) }
                                    else if let issue = line.issue {
                                        Button { model.retry(line.id) } label: { Label(issue, systemImage: "arrow.clockwise") }.font(.callout)
                                    } else { Label("正在翻译…", systemImage: "ellipsis").foregroundStyle(.secondary).font(.callout) }
                                }.textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                                    .padding().background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
                            }
                            if !model.partial.isEmpty {
                                Text(model.partial).italic().foregroundStyle(.secondary).padding().accessibilityLabel("正在识别：\(model.partial)")
                            }
                            Color.clear.frame(height: 1).id("bottom")
                        }.padding()
                    }
                    .background(Color(.systemGroupedBackground))
                    .onChange(of: model.current.captions.count) { _, _ in withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
                    .onChange(of: model.partial) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
                }
                Button {
                    if model.phase == .idle { Task { await model.start() } }
                    else { model.stop() }
                } label: {
                    Label(model.phase == .idle ? "开始同传" : (model.phase == .connecting ? "取消连接" : "停止录音"), systemImage: model.phase == .idle ? "mic.fill" : "stop.fill")
                        .font(.headline).frame(maxWidth: .infinity).padding(.vertical, 10)
                }.buttonStyle(.borderedProminent).tint(model.phase == .idle ? .blue : .red)
                    .disabled(model.phase == .stopping || (model.phase == .idle && model.translating > 0)).padding()
            }
            .navigationTitle("课堂同传").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button { records = true } label: { Image(systemName: "clock.arrow.circlepath") }.accessibilityLabel("历史记录") }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if !model.current.captions.isEmpty { ShareLink(item: model.current.text) { Image(systemName: "square.and.arrow.up") }.accessibilityLabel("导出字幕") }
                    Button { settings = true } label: { Image(systemName: "gearshape") }.accessibilityLabel("设置").disabled(model.busy)
                }
            }
            .sheet(isPresented: $settings) { SettingsView() }
            .sheet(isPresented: $records) { HistoryView() }
        }
    }
}
struct SettingsView: View {
    @EnvironmentObject var model: TranslatorModel
    @Environment(\.dismiss) var dismiss
    var body: some View {
        NavigationStack {
            Form {
                Section("英文识别 · Deepgram Nova-3") {
                    SecureField("Deepgram API key", text: $model.deepgramKey)
                }
                Section("中文翻译 · DeepSeek / 兼容接口") {
                    SecureField("翻译 API key", text: $model.translationKey)
                    TextField("完整接口地址（含 /chat/completions）", text: $model.endpoint).keyboardType(.URL)
                    TextField("模型名称", text: $model.modelName)
                    Text("默认 deepseek-chat；也可按你的服务商文档修改模型和接口。接口必须使用 HTTPS。模型会参考前文纠正明显识别错误，但仍应核对人名、数字和专业术语。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section("数据与费用") {
                    Text("录音会实时发送至 Deepgram，确认后的英文及最多前三段上下文会发送至上方翻译服务。两项 API 按各自账户计费。")
                    Text("API key 仅在本次应用运行期间保留，退出后需重新输入。字幕保存在此 iPhone 的应用目录中，可分享导出或在历史记录中删除。不保存原始录音。")
                    Toggle("我了解并同意云端识别与翻译", isOn: $model.consent)
                }
                Section("使用范围") {
                    Text("iPhone 自用预览版 0.1.0 · iOS 17 及以上\n支持前台麦克风录音。切到后台、来电或切换耳机时停止录音。尚不支持系统音频、离线识别和桌面端记录同步。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }.textInputAutocapitalization(.never).autocorrectionDisabled()
                .navigationTitle("同传设置").toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
    }
}
struct HistoryView: View {
    @EnvironmentObject var model: TranslatorModel
    @Environment(\.dismiss) var dismiss
    @State private var deleting: UUID?
    var body: some View {
        NavigationStack {
            List {
                if model.history.isEmpty { Text("暂无记录").foregroundStyle(.secondary) }
                ForEach(model.history) { record in
                    NavigationLink {
                        ScrollView { Text(record.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding() }
                            .navigationTitle(record.date.formatted(date: .abbreviated, time: .shortened))
                            .toolbar { ShareLink(item: record.text) { Image(systemName: "square.and.arrow.up") } }
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(record.date.formatted(date: .abbreviated, time: .shortened))
                            Text(record.captions.first?.english ?? "录音").lineLimit(2).font(.caption).foregroundStyle(.secondary)
                            Text("\(record.captions.count) 段字幕").font(.caption2).foregroundStyle(.secondary)
                        }
                    }.swipeActions { Button("删除", role: .destructive) { deleting = record.id }.disabled(model.busy) }
                }
            }.navigationTitle("历史记录")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
                .alert("删除这条记录？", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
                    Button("删除", role: .destructive) { if let id = deleting { model.removeRecord(id) }; deleting = nil }
                    Button("取消", role: .cancel) { deleting = nil }
                } message: { Text("此操作会删除本机保存的这条字幕记录。") }
        }
    }
}
