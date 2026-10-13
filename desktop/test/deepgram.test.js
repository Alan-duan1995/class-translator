import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DeepgramASR } from "../src/main/cloud/deepgram-asr.js";

class Socket extends EventEmitter {
  readyState = 0; bufferedAmount = 0; sent = [];
  send(data, cb) { this.sent.push(data); cb?.(); }
  terminate() { this.readyState = 3; this.emit("close", 1006); }
  open() { this.readyState = 1; this.emit("open"); }
  result(data) { this.emit("message", Buffer.from(JSON.stringify(data))); }
}
function setup(options = {}) {
  const ws = new Socket(), messages = [], exits = [];
  let connection;
  const asr = new DeepgramASR({ key: "test-secret-key", speaker: "en", offset: 12,
    connect: (url, opts) => { connection = { url, opts }; return ws; }, ...options });
  asr.on("message", m => messages.push(m));
  asr.on("exit", n => exits.push(n));
  asr.start();
  return { asr, ws, messages, exits, connection };
}
const result = (is_final, transcript, words = []) => ({ type: "Results", is_final, start: 0.5, channel: { alternatives: [{ transcript, words }] } });

test("Deepgram authenticates in headers and streams queued PCM with correct format", () => {
  const { asr, ws, connection } = setup();
  const url = new URL(connection.url);
  assert.equal(url.searchParams.get("sample_rate"), "16000");
  assert.equal(url.searchParams.get("model"), "nova-3");
  assert.equal(url.searchParams.get("diarize"), "true");
  assert.equal(connection.opts.headers.Authorization, "Token test-secret-key");
  assert.equal(url.href.includes("test-secret-key"), false);
  const audio = Buffer.from([0, 1, 2, 3]);
  asr.feed(audio); assert.equal(ws.sent.length, 0);
  ws.open(); asr.feed(audio);
  assert.deepEqual(ws.sent, [audio, audio]);
  asr.kill();
});
test("Deepgram interim text is replaced; final words retain speaker turns and timestamps", () => {
  const { asr, ws, messages } = setup(); ws.open();
  ws.result(result(false, "Hello")); ws.result(result(false, "Hello there"));
  ws.result(result(true, "Hello there. Yes.", [
    { word: "hello", punctuated_word: "Hello", speaker: 0, start: 0.5 },
    { word: "there", punctuated_word: "there.", speaker: 0, start: 0.8 },
    { word: "yes", punctuated_word: "Yes.", speaker: 1, start: 1.2 },
  ]));
  assert.deepEqual(messages.filter(m => m.type === "partial").slice(0, 3).map(m => m.text), ["Hello", "Hello there", ""]);
  assert.deepEqual(messages.filter(m => m.type === "final").map(m => [m.text, m.start, m.speakerId]),
    [["Hello there.", 0.5, 0], ["Yes.", 1.2, 1]]);
  asr.kill();
});
test("Deepgram stopping flushes final results before completion, including stop during connect", async () => {
  const { asr, ws, messages, exits } = setup();
  asr.feed(Buffer.alloc(2)); const done = asr.close(); ws.open();
  assert.equal(JSON.parse(ws.sent.at(-1)).type, "CloseStream");
  ws.result(result(true, "Last sentence."));
  ws.readyState = 3; ws.emit("close", 1000); await done;
  assert.equal(messages.find(m => m.type === "final").text, "Last sentence.");
  assert.deepEqual(exits, [0]); assert.equal(asr.keepAlive, undefined);
});
test("Deepgram errors never echo remote secrets and exit only once", () => {
  const { asr, ws, messages, exits } = setup(); ws.open();
  ws.emit("error", new Error("test-secret-key")); ws.emit("close", 1006);
  assert.deepEqual(exits, [1]);
  assert.equal(JSON.stringify(messages).includes("test-secret-key"), false);
  asr.feed(Buffer.alloc(2)); assert.equal(asr.pendingBytes, 0);
});
test("Deepgram bounds queued audio and blocked network buffers", () => {
  const a = setup(); a.asr.feed(Buffer.alloc(320001)); assert.deepEqual(a.exits, [1]);
  const b = setup(); b.ws.open(); b.ws.bufferedAmount = 160001;
  b.asr.feed(Buffer.alloc(2)); assert.deepEqual(b.exits, [1]);
});
test("Deepgram connection and close timeouts terminate without hanging", async () => {
  const a = setup({ timeoutMs: 10 }); await a.asr.done; assert.deepEqual(a.exits, [1]);
  const b = setup({ timeoutMs: 10 }); b.ws.open(); await b.asr.close(); assert.deepEqual(b.exits, [1]);
});
test("Deepgram missing key or unsupported language never connects", async () => {
  for (const opts of [{ key: "" }, { speaker: "zh" }]) {
    const x = setup(opts); await x.asr.done;
    assert.equal(x.connection, undefined); assert.deepEqual(x.exits, [1]);
  }
});
