import fs from "node:fs";
import path from "node:path";

const KEY_RE = /^[\w\-.]{10,300}$/;
const PROVIDERS = ["gemini", "claude", "openai"];

const V2 = "v2:"; // 用 App 自己的加密存的 key 带这个开头；没有的是以前用系统钥匙串存的

/**
 * 偏好存普通 JSON；API key 加密后再存，绝不存明文。
 * Windows 用系统加密（DPAPI）。Mac 用 App 自己的加密（见 filecrypto.js），这时 legacy 是系统钥匙串，
 * 只用来把旧版存的 key 读出来转存一次，之后不再碰钥匙串。
 */
export class Settings {
  constructor(file, crypto, legacy = null) {
    this.file = file;
    this.crypto = crypto;
    this.legacy = legacy;
    try { this.data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { this.data = {}; }
    this.data.prefs ??= {};
    this.data.keys ??= {};
  }
  #save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.chmodSync(this.file, 0o600);
  }
  pref(key, def) { return this.data.prefs[key] ?? def; }
  setPref(key, value) { this.data.prefs[key] = value; this.#save(); }
  getKey(provider) {
    const enc = this.data.keys[provider];
    if (!enc) return "";
    try {
      if (!this.legacy) return this.crypto.decryptString(Buffer.from(enc, "base64"));
      if (enc.startsWith(V2)) return this.crypto.decryptString(Buffer.from(enc.slice(V2.length), "base64"));
      const v = this.legacy.decryptString(Buffer.from(enc, "base64")); // 旧版存的：读出来（系统会最后问一次密码），马上转存
      if (v) { try { this.setKey(provider, v); } catch {} }
      return v;
    } catch { return ""; }
  }
  setKey(provider, value) {
    if (!PROVIDERS.includes(provider)) throw new Error("未知的服务");
    const v = String(value).trim();
    if (!KEY_RE.test(v)) throw new Error("API key 格式不对（不能有空格或中文）");
    if (!this.crypto.isEncryptionAvailable()) throw new Error("加密不可用，无法安全保存 key");
    this.data.keys[provider] = (this.legacy ? V2 : "") + this.crypto.encryptString(v).toString("base64");
    this.#save();
  }
  clearKey(provider) { delete this.data.keys[provider]; this.#save(); }
  keyState(provider) {
    const v = this.getKey(provider);
    return { set: !!v, tail: v.length > 8 ? v.slice(-4) : "" }; // 只给末 4 位
  }
}
