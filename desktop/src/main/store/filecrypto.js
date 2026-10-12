import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * App 自己加密（Mac 用）：密钥是一份随机数，存在只有本人能读的文件里，用它给 API key 做 AES-256-GCM 加密。
 * 不用系统钥匙串，是因为没有开发者签名的 App 每次更新后，钥匙串都会弹窗要电脑密码。
 * 保护比钥匙串弱：能读到这个用户文件的程序可以解开。接口和 Electron 的 safeStorage 一样。
 */
export class FileCrypto {
  constructor(keyFile) {
    this.keyFile = keyFile;
    this.key = null;
  }
  #load() {
    if (this.key) return this.key;
    try {
      const k = fs.readFileSync(this.keyFile);
      if (k.length === 32) return (this.key = k);
    } catch {}
    const k = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(this.keyFile), { recursive: true });
    fs.writeFileSync(this.keyFile, k, { mode: 0o600 });
    fs.chmodSync(this.keyFile, 0o600);
    return (this.key = k);
  }
  isEncryptionAvailable() {
    try { this.#load(); return true; } catch { return false; }
  }
  /** 输出：12 字节随机数 + 16 字节校验 + 密文 */
  encryptString(text) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", this.#load(), iv);
    const body = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]);
  }
  decryptString(buf) {
    const d = crypto.createDecipheriv("aes-256-gcm", this.#load(), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
  }
}
