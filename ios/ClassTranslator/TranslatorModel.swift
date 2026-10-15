import SwiftUI
import AVFoundation

// Do not forward bearer credentials through HTTP redirects to another service.
final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

@MainActor final class TranslatorModel: ObservableObject {
    enum Phase { case idle, connecting, listening, stopping }
    @Published var phase: Phase = .idle
    @Published var current = Recording()
    @Published var history: [Recording] = []
    @Published var partial = ""
    @Published var notice = ""
    @Published var storageIssue = ""
    @Published var deepgramKey = ""
    @Published var translationKey = ""
    @Published var endpoint = UserDefaults.standard.string(forKey: "translationEndpoint") ?? "https://api.deepseek.com/chat/completions"
    @Published var modelName = UserDefaults.standard.string(forKey: "translationModel") ?? "deepseek-chat"
    @Published var consent = false
    @Published var translating = 0
    var busy: Bool { phase != .idle || translating > 0 }
    var status: String {
        switch phase {
        case .idle: return translating > 0 ? "正在完成翻译…" : "准备就绪"
        case .connecting: return "正在连接…"
        case .listening: return "正在聆听英语"
        case .stopping: return "正在保存最后一句…"
        }
    }
    private let audio = AudioCapture()
    private let network = URLSession(configuration: .ephemeral, delegate: NoRedirects(), delegateQueue: nil)
    private var socket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var sendTask: Task<Void, Never>?
    private var keepAlive: Task<Void, Never>?
    private var stopTimer: Task<Void, Never>?
    private var connectTimer: Task<Void, Never>?
    private var packets: [Data] = []
    private var queuedBytes = 0
    private var byteLimit = 48000 * 2 * 3
    private var generation = UUID()
    private var pending: [UUID] = []
    private var inFlight: Set<UUID> = []
    private var configuration: TranslationConfiguration?
    private var archiveURL: URL?
    private var archiveReadable = true

    init() {
        do {
            let folder = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            let url = folder.appendingPathComponent("recordings.json")
            archiveURL = url
            if FileManager.default.fileExists(atPath: url.path) {
                history = try JSONDecoder().decode([Recording].self, from: Data(contentsOf: url))
                // A force-quit can leave translations pending. Mark them explicitly for export.
                for i in history.indices {
                    for j in history[i].captions.indices where history[i].captions[j].chinese.isEmpty {
                        history[i].captions[j].issue = "上次翻译未完成"
                    }
                }
            }
        } catch {
            archiveReadable = false
            storageIssue = "历史记录读取失败；为保护已有文件，本次不会覆盖它。请先导出当前记录。"
        }
    }
    func start() async {
        guard !busy else { return }
        notice = ""
        guard consent else { notice = "请先在设置中确认云端处理说明"; return }
        guard !deepgramKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { notice = "请先填写 Deepgram API key"; return }
        let config = TranslationConfiguration(endpoint: endpoint.trimmingCharacters(in: .whitespacesAndNewlines), model: modelName.trimmingCharacters(in: .whitespacesAndNewlines), key: translationKey.trimmingCharacters(in: .whitespacesAndNewlines))
        do { _ = try config.request(text: "check", context: []) } catch { notice = error.localizedDescription; return }
        phase = .connecting
        generation = UUID()
        let token = generation
        let granted = await AVAudioApplication.requestRecordPermission()
        guard token == generation, phase == .connecting else { return }
        guard granted else { fail("没有麦克风权限，请在 iPhone 设置中允许访问"); return }
        do {
            let rate = try audio.prepare()
            byteLimit = Int(rate) * 2 * 3
            var url = URLComponents(string: "wss://api.deepgram.com/v1/listen")!
            url.queryItems = ["model": "nova-3", "language": "en", "encoding": "linear16", "sample_rate": String(Int(rate)), "channels": "1", "interim_results": "true", "punctuate": "true", "smart_format": "true", "endpointing": "300"].map { URLQueryItem(name: $0.key, value: $0.value) }
            var request = URLRequest(url: url.url!, timeoutInterval: 10)
            request.setValue("Token \(deepgramKey.trimmingCharacters(in: .whitespacesAndNewlines))", forHTTPHeaderField: "Authorization")
            let ws = network.webSocketTask(with: request)
            socket = ws
            ws.resume()
            connectTimer = Task { [weak self] in
                try? await Task.sleep(for: .seconds(12))
                guard !Task.isCancelled, let self, self.generation == token, self.phase == .connecting else { return }
                self.fail("识别服务连接超时，请检查网络、API key 和额度")
            }
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                ws.sendPing { error in
                    if let error { continuation.resume(throwing: error) } else { continuation.resume() }
                }
            }
            guard token == generation, phase == .connecting else { return }
            connectTimer?.cancel()
            current = Recording()
            configuration = config
            UserDefaults.standard.set(config.endpoint, forKey: "translationEndpoint")
            UserDefaults.standard.set(config.model, forKey: "translationModel")
            phase = .listening
            UIApplication.shared.isIdleTimerDisabled = true
            receiveTask = Task { [weak self] in
                do {
                    while !Task.isCancelled {
                        let message = try await ws.receive()
                        guard let self, self.generation == token else { return }
                        let data: Data
                        switch message { case .data(let value): data = value; case .string(let value): data = Data(value.utf8); @unknown default: continue }
                        self.consume(data)
                    }
                } catch {
                    guard let self, self.generation == token, !Task.isCancelled else { return }
                    self.fail("识别连接断开，已保留收到的字幕；最后一句可能不完整，请重新开始")
                }
            }
            try audio.start { [weak self] data in
                Task { @MainActor in
                    guard let self, self.generation == token, self.phase == .listening else { return }
                    self.enqueue(data)
                }
            }
            keepAlive = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(4))
                    guard !Task.isCancelled, let self, self.generation == token, self.phase == .listening else { return }
                    do { try await ws.send(.string("{\"type\":\"KeepAlive\"}")) }
                    catch { self.fail("识别连接中断，请检查网络后重新开始"); return }
                }
            }
        } catch { if generation == token { fail("无法启动识别，请检查麦克风、网络、Deepgram API key 和额度") } }
    }
    private func enqueue(_ data: Data) {
        guard queuedBytes + data.count <= byteLimit else { fail("网络过慢，音频积压超过 3 秒，已停止以避免字幕持续延迟"); return }
        packets.append(data); queuedBytes += data.count
        drain()
    }
    private func drain() {
        guard sendTask == nil, let ws = socket else { return }
        let token = generation
        sendTask = Task { [weak self] in
            guard let self else { return }
            do {
                while !self.packets.isEmpty, !Task.isCancelled {
                    let data = self.packets.removeFirst()
                    try await ws.send(.data(data))
                    guard token == self.generation else { return }
                    self.queuedBytes -= data.count
                }
                guard token == self.generation, !Task.isCancelled else { return }
                self.sendTask = nil
                if self.phase == .stopping { try await ws.send(.string("{\"type\":\"CloseStream\"}")) }
            } catch { if token == self.generation { self.fail("音频发送失败，已保存收到的字幕；请检查网络") } }
        }
    }
    func stop(reason: String? = nil) {
        guard phase == .listening || phase == .connecting else { return }
        if let reason { notice = reason }
        if phase == .connecting { finish(); return }
        phase = .stopping
        audio.stop()
        UIApplication.shared.isIdleTimerDisabled = false
        keepAlive?.cancel()
        drain()
        let token = generation
        stopTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(6))
            guard !Task.isCancelled, let self, token == self.generation else { return }
            self.fail("收尾超时，已保存收到的字幕；最后一句可能不完整")
        }
    }
    private func consume(_ data: Data) {
        guard let value = try? JSONDecoder().decode(Recognition.self, from: data) else { return }
        if value.type == "Error" { fail("识别服务报错，请检查 API key、额度或网络"); return }
        if value.type == "Metadata", phase == .stopping { finish(); return }
        guard value.type == "Results" else { return }
        if value.is_final != true { partial = value.text; return }
        partial = ""
        guard !value.text.isEmpty else { return }
        let caption = Caption(english: value.text, seconds: max(0, value.start ?? 0))
        current.captions.append(caption)
        queueTranslation(caption.id)
        persist()
    }
    func retry(_ id: UUID) {
        guard !inFlight.contains(id), !pending.contains(id), let index = current.captions.firstIndex(where: { $0.id == id }) else { return }
        // Retry after stopping may use corrected settings; an active session keeps its original configuration.
        if phase == .idle {
            configuration = TranslationConfiguration(endpoint: endpoint.trimmingCharacters(in: .whitespacesAndNewlines), model: modelName, key: translationKey.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        current.captions[index].issue = nil
        queueTranslation(id)
    }
    private func queueTranslation(_ id: UUID) {
        if pending.count >= 40 {
            if let index = current.captions.firstIndex(where: { $0.id == id }) { current.captions[index].issue = "翻译积压，点按重试" }
            return
        }
        pending.append(id)
        pumpTranslations()
    }
    private func pumpTranslations() {
        while inFlight.count < 2, !pending.isEmpty, let config = configuration {
            let id = pending.removeFirst()
            guard let index = current.captions.firstIndex(where: { $0.id == id }) else { continue }
            let caption = current.captions[index]
            let context = current.captions.prefix(index).suffix(3).map(\.english)
            let recordingID = current.id
            inFlight.insert(id)
            Task { [weak self] in
                guard let self else { return }
                var translated = ""
                var problem: String?
                do {
                    let request = try config.request(text: caption.english, context: context)
                    let (data, response) = try await self.network.data(for: request)
                    translated = try TranslationConfiguration.result(data, status: (response as? HTTPURLResponse)?.statusCode ?? 0)
                } catch let failure as AppFailure { problem = failure.localizedDescription }
                catch { problem = "翻译失败或超时，英文已保留，点按重试" }
                if recordingID == self.current.id, let i = self.current.captions.firstIndex(where: { $0.id == id }) {
                    self.current.captions[i].chinese = translated
                    self.current.captions[i].issue = problem
                }
                self.inFlight.remove(id)
                self.persist()
                self.pumpTranslations()
            }
        }
        translating = pending.count + inFlight.count
    }
    private func fail(_ text: String) { notice = text; finish() }
    private func finish() {
        generation = UUID()
        audio.stop()
        connectTimer?.cancel(); stopTimer?.cancel(); keepAlive?.cancel(); sendTask?.cancel(); receiveTask?.cancel()
        socket?.cancel(with: .normalClosure, reason: nil); socket = nil
        sendTask = nil; packets = []; queuedBytes = 0
        partial = ""; phase = .idle
        UIApplication.shared.isIdleTimerDisabled = false
        persist()
    }
    func removeRecord(_ id: UUID) {
        guard !busy else { return }
        history.removeAll { $0.id == id }
        if current.id == id { current = Recording() }
        writeHistory()
    }
    private func persist() {
        guard !current.captions.isEmpty else { return }
        if let index = history.firstIndex(where: { $0.id == current.id }) { history[index] = current }
        else { history.insert(current, at: 0) }
        writeHistory()
    }
    private func writeHistory() {
        guard archiveReadable, let url = archiveURL else { return }
        do {
            let data = try JSONEncoder().encode(history)
            try data.write(to: url, options: [.atomic, .completeFileProtection])
            storageIssue = ""
        } catch { storageIssue = "记录写入失败，请在离开前使用分享按钮导出。" }
    }
}
