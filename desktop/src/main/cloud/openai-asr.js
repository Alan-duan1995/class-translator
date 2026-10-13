import { checkBase, isLocalBase } from "../llm/openai.js";
import { NoKey, TimeoutError } from "../llm/errors.js";

export function normalizeSpeechBase(value) {
  return String(value ?? "").trim().replace(/\/+$/, "").replace(/\/audio\/transcriptions$/, "").replace(/\/+$/, "");
}
export function speechConfig(settings) {
  return { base: settings.pref("speechBase", ""), model: settings.pref("speechModel", ""), key: settings.getKey("speech") };
}
export function validateSpeechConfig({ base, model, key }) {
  if (!base) return "请填写语音识别接口地址";
  const bad = checkBase(base);
  if (bad) return bad;
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash) return "语音接口地址不能包含账号、密码、查询参数或 #；Key 请填在独立输入框";
  if (!model || model.length > 200) return "请填写语音模型名（最多 200 字符）";
  if (!key && !isLocalBase(base)) return "请填写语音服务 Key（只有本机服务可留空）";
  return "";
}

/** Dedicated transcription endpoint; never send audio to a chat-completions model. */
export class SpeechClient {
  constructor(settings, { fetch = globalThis.fetch, timeoutMs = 30_000 } = {}) {
    Object.assign(this, { settings, fetch, timeoutMs });
  }
  async recognize(wav, speaker = "auto") {
    const config = speechConfig(this.settings);
    const bad = validateSpeechConfig(config);
    if (bad) throw new NoKey(bad);
    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "speech.wav");
    form.append("model", config.model);
    form.append("response_format", "json");
    if (speaker !== "auto") form.append("language", speaker);
    const ctl = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { ctl.abort(); reject(new TimeoutError("语音接口超过 30 秒未响应")); }, this.timeoutMs);
    });
    try {
      return await Promise.race([this.request(config, form, ctl.signal, speaker), timeout]);
    } finally { clearTimeout(timer); }
  }
  async request(config, body, signal, speaker) {
    let response;
    try {
      response = await this.fetch(`${config.base}/audio/transcriptions`, {
        method: "POST", body, signal, redirect: "error",
        headers: config.key ? { Authorization: `Bearer ${config.key}` } : {},
      });
    } catch {
      throw new Error("无法连接语音接口，请检查地址和网络");
    }
    // Do not echo provider error bodies: they may contain keys, audio or proxy diagnostics.
    if (!response.ok) {
      const messages = { 400: "请求不兼容，请确认模型支持音频转写", 401: "语音服务 Key 无效", 403: "没有使用该语音模型的权限", 404: "未找到语音接口或模型，请检查地址和模型名", 413: "音频片段超过服务商限制", 429: "语音服务限流或额度不足，请稍后重试" };
      throw Object.assign(new Error(messages[response.status] || `语音服务返回错误 ${response.status}`), { status: response.status });
    }
    let data;
    try { data = await response.json(); } catch { throw new Error("语音接口未返回有效 JSON，请确认支持音频转写接口"); }
    if (typeof data?.text !== "string") throw new Error("语音接口返回格式不兼容：缺少 text 字段");
    const names = { english: "en", chinese: "zh", japanese: "ja", korean: "ko", french: "fr", german: "de", spanish: "es" };
    const language = String(data.language ?? "").toLowerCase();
    const lang = names[language] ?? (['en','zh','ja','ko','fr','de','es'].includes(language) ? language : "other");
    return { text: data.text.trim(), lang: speaker === "auto" ? lang : speaker };
  }
}
