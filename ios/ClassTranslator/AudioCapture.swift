import AVFoundation

final class AudioCapture {
    private let engine = AVAudioEngine()
    private var installed = false
    func prepare() throws -> Double {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: [])
        try session.setPreferredIOBufferDuration(0.04)
        try session.setActive(true)
        let format = engine.inputNode.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0, format.commonFormat == .pcmFormatFloat32 else {
            throw AppFailure.message("当前麦克风格式不可用，请重新连接设备")
        }
        return format.sampleRate
    }
    func start(deliver: @escaping @Sendable (Data) -> Void) throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { buffer, _ in
            guard let channels = buffer.floatChannelData else { return }
            let count = Int(buffer.frameLength)
            // Select the first physical microphone channel; WebSocket advertises mono.
            let samples = Array(UnsafeBufferPointer(start: channels[0], count: count))
            deliver(PCM.encode(samples))
        }
        installed = true
        engine.prepare()
        try engine.start()
    }
    func stop() {
        engine.stop()
        if installed { engine.inputNode.removeTap(onBus: 0); installed = false }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
