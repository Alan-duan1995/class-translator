import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

const LOAD_TIMEOUT_MS = 30_000; // 第一句要等模型加载好
const TIMEOUT_MS = 10_000;
const CJK = "[\\u4e00-\\u9fff]";
const FULL = { ",": "，", "?": "？", "!": "！", ";": "；", ":": "：" };

/** 模型输出的是英文标点：挨着汉字的换成中文标点，汉字之间多余的空格去掉（1,000 和 10:30 这种不动） */
export function zhPunct(s) {
  return String(s)
    .replace(new RegExp(`(?<=${CJK})\\s*([,?!;:])\\s*|\\s*([,?!;:])\\s*(?=${CJK})`, "g"), (_m, a, b) => FULL[a ?? b])
    .replace(new RegExp(`(?<=${CJK})\\s+(?=${CJK})`, "g"), "")
    .trim();
}

/** 本地翻译（英语 → 简体中文，直译）：模型在后台线程里跑，第一次用到才加载。接口和 AppleTranslator 一样 */
export class LocalTranslator {
  constructor({ workerPath, modelDir, engineDir, makeWorker }) {
    Object.assign(this, { workerPath, modelDir, engineDir });
    this.makeWorker = makeWorker ?? ((file, workerData) => new Worker(file, { workerData }));
    this.worker = null;
    this.ready = false;
    this.pending = new Map();
    this.nextId = 0;
  }
  #supported(src, tgt) { return src === "en" && tgt === "zh" && fs.existsSync(path.join(this.modelDir, "model.bin")); }
  #fail(w) { // 线程出错或退出：没回的请求都按失败处理，下次再用时重新启动
    if (this.worker !== w) return;
    this.worker = null;
    this.ready = false;
    for (const done of this.pending.values()) done({ error: "本地翻译线程退出了" });
    this.pending.clear();
  }
  #ensure() {
    if (this.worker) return;
    const w = this.makeWorker(this.workerPath, { modelDir: this.modelDir, engineDir: this.engineDir });
    w.on("message", (m) => {
      if (m.type === "ready") { this.ready = true; return; }
      if (m.type === "error") return this.#fail(w);
      const done = this.pending.get(m.id);
      if (done) { this.pending.delete(m.id); done(m); }
    });
    w.on("error", () => this.#fail(w));
    w.on("exit", () => this.#fail(w));
    w.unref?.(); // 不让它拦着 App 退出
    this.worker = w;
  }
  warmup() { if (this.#supported("en", "zh")) this.#ensure(); }
  /** 返回 {tr, code}：code 为空表示成功，unsupported 表示不是英语译简体中文 */
  async translate(text, src, tgt) {
    if (!this.#supported(src, tgt)) return { tr: "", code: "unsupported" };
    this.#ensure();
    const id = ++this.nextId;
    let timer;
    const m = await new Promise((resolve) => {
      this.pending.set(id, resolve);
      timer = setTimeout(() => resolve({ error: "超时" }), this.ready ? TIMEOUT_MS : LOAD_TIMEOUT_MS);
      this.worker.postMessage({ id, text });
    });
    clearTimeout(timer);
    this.pending.delete(id);
    return m.tr ? { tr: zhPunct(m.tr), code: "" } : { tr: "", code: "failed" };
  }
  status(src, tgt) { return Promise.resolve(this.#supported(src, tgt) ? "installed" : "unsupported"); }
  stop() { const w = this.worker; this.worker = null; this.ready = false; w?.terminate(); }
}
