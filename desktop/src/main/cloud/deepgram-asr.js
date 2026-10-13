import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { SR } from "../langs.js";

// The desktop main process owns the authenticated connection; no key is sent to the renderer.
export class DeepgramASR extends EventEmitter {
  constructor({ key, speaker, offset, terms = [], connect = (url, options) => new WebSocket(url, options), timeoutMs = 10_000 }) {
    super();
    Object.assign(this, { key, speaker, offset, terms, connect, timeoutMs });
    this.kind = "deepgram";
    this.pending = [];
    this.pendingBytes = 0;
    this.ended = false;
    this.stopping = false;
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
  }
  start() {
    this.emit("message", { type: "connection", state: "connecting", text: "正在连接 Deepgram…" });
    // Defer configuration failures so Session has registered this instance before exit.
    if (!this.key || this.speaker !== "en") {
      queueMicrotask(() => this.fail(!this.key
        ? "请在「AI 模型与 API」中填写 Deepgram API key，再重新开始录制"
        : "Deepgram 实时识别目前配置为英语，请把说话语言设为英语"));
      return;
    }
    const query = new URLSearchParams({ model: "nova-3", language: "en", encoding: "linear16",
      sample_rate: String(SR), channels: "1", interim_results: "true", diarize: "true",
      punctuate: "true", smart_format: "true", endpointing: "300" });
    for (const term of this.terms) query.append("keyterm", term);
    try {
      this.ws = this.connect(`wss://api.deepgram.com/v1/listen?${query}`, {
        headers: { Authorization: `Token ${this.key}` }, handshakeTimeout: this.timeoutMs,
      });
    } catch { queueMicrotask(() => this.fail("Deepgram 连接失败，请检查网络后重新开始录制")); return; }
    this.openTimer = setTimeout(() => this.fail("Deepgram 连接超时，请检查网络后重新开始录制"), this.timeoutMs);
    this.ws.on("open", () => {
      if (this.ended) return;
      clearTimeout(this.openTimer);
      this.emit("message", { type: "connection", state: "connected", text: "Deepgram 已连接" });
      for (const chunk of this.pending) this.send(chunk);
      this.pending = []; this.pendingBytes = 0;
      if (this.ended) return;
      if (!this.stopping) this.keepAlive = setInterval(() => this.send(JSON.stringify({ type: "KeepAlive" })), 4000);
      if (this.stopping) this.closeStream();
    });
    this.ws.on("message", data => this.result(data));
    this.ws.on("error", () => this.fail("Deepgram 连接失败，请检查网络、API key 和账户额度；可切换识别方式"));
    this.ws.on("close", code => {
      if (this.ended) return;
      if (this.stopping && code === 1000) this.finish(0);
      else this.fail("Deepgram 连接已断开，将尝试重连；断线期间可能遗漏字幕，说话人编号会重新分配");
    });
  }
  send(data) {
    if (this.ended || this.ws?.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > SR * 2 * 5) return this.fail("网络过慢，Deepgram 音频积压，已停止当前连接；请检查网络");
    try { this.ws.send(data, error => { if (error) this.fail("Deepgram 音频发送失败，请检查网络"); }); }
    catch { this.fail("Deepgram 音频发送失败，请检查网络"); }
  }
  feed(buf) {
    if (this.ended || this.stopping) return;
    if (this.ws?.readyState === WebSocket.OPEN) return this.send(buf);
    this.pendingBytes += buf.length;
    if (this.pendingBytes > SR * 2 * 10) return this.fail("Deepgram 连接过慢，请检查网络后重新开始录制");
    this.pending.push(Buffer.from(buf));
  }
  result(data) {
    if (this.ended) return;
    let m;
    try { m = JSON.parse(String(data)); } catch { return; }
    if (m.type === "Error") return this.fail("Deepgram 识别失败，请检查 API key、账户额度或网络");
    if (m.type !== "Results") return;
    const alt = m.channel?.alternatives?.[0];
    if (!m.is_final) {
      this.emit("message", { type: "partial", text: alt?.transcript ?? "" });
      return;
    }
    this.emit("message", { type: "partial", text: "" });
    this.emit("message", { type:"coverage", end:Number(m.start ?? 0) + Number(m.duration ?? 0) });
    if (!alt?.transcript?.trim()) return;
    // Split finalized words on speaker changes, preserving timestamps and punctuation.
    const groups = [];
    for (const word of alt.words ?? []) {
      const label = Number.isInteger(word.speaker) && word.speaker >= 0 ? word.speaker : null;
      const text = word.punctuated_word ?? word.word;
      if (!text) continue;
      if (groups.at(-1)?.speakerId === label) groups.at(-1).text += ` ${text}`;
      else groups.push({ text, start: word.start ?? m.start ?? 0, speakerId: label });
    }
    if (!groups.length) groups.push({ text: alt.transcript, start: m.start ?? 0, speakerId: null });
    for (const group of groups) this.emit("message", { type: "final", source: "deepgram", lang: "en", ...group });
  }
  closeStream() { this.send(JSON.stringify({ type: "CloseStream" })); }
  close() {
    if (this.ended || this.stopping) return this.done;
    this.stopping = true;
    clearInterval(this.keepAlive);
    this.closeTimer = setTimeout(() => this.fail("Deepgram 收尾超时，最后一段字幕可能不完整"), this.timeoutMs);
    if (this.ws?.readyState === WebSocket.OPEN) this.closeStream();
    return this.done;
  }
  fail(msg) {
    if (this.ended) return;
    this.emit("message", { type: "error", msg });
    this.finish(1);
  }
  finish(code) {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.openTimer); clearTimeout(this.closeTimer); clearInterval(this.keepAlive);
    this.pending = []; this.pendingBytes = 0;
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) this.ws.terminate();
    this.emit("message", { type: "partial", text: "" });
    this.emit("exit", code);
    this.resolveDone();
  }
  kill() { this.finish(-1); }
}
