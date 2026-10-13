import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Settings } from "../src/main/store/settings.js";

const fakeCrypto = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from("ENC:" + [...s].reverse().join("")),
  decryptString: (b) => [...b.toString().slice(4)].reverse().join(""),
});
const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ct-set-")), "settings.json");
const KEY = "AIzaTestKey1234567890";

test("粘贴时带的空格换行会去掉；文件里没有明文 key；权限 600", () => {
  const f = file();
  const s = new Settings(f, fakeCrypto());
  s.setKey("gemini", `  ${KEY}\n`);
  assert.equal(s.getKey("gemini"), KEY);
  assert.deepEqual(s.keyState("gemini"), { set: true, tail: "7890" });
  assert.equal(fs.readFileSync(f, "utf8").includes(KEY), false);
  // Windows uses ACLs rather than POSIX permission bits.
  if (process.platform !== "win32") assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(new Settings(f, fakeCrypto()).getKey("gemini"), KEY, "重新打开还能读出来");
});

test("中间有空格或中文的 key 拒绝", () => {
  const s = new Settings(file(), fakeCrypto());
  assert.throws(() => s.setKey("gemini", "有 空格 的key"), /格式不对/);
  assert.throws(() => s.setKey("claude", "sk-ant-中文abcdefghij"), /格式不对/);
  assert.deepEqual(s.keyState("gemini"), { set: false, tail: "" });
});

test("系统加密不可用时拒绝保存，绝不存明文", () => {
  const f = file();
  const s = new Settings(f, fakeCrypto(false));
  assert.throws(() => s.setKey("gemini", KEY), /加密不可用/);
  assert.equal(fs.existsSync(f) && fs.readFileSync(f, "utf8").includes(KEY), false);
});

test("删除 key", () => {
  const s = new Settings(file(), fakeCrypto());
  s.setKey("claude", "sk-ant-abcdefghijklmnop");
  s.clearKey("claude");
  assert.equal(s.getKey("claude"), "");
});

test("偏好设置能保存读回", () => {
  const f = file();
  new Settings(f, fakeCrypto()).setPref("geminiModel", "gemini-3.7-flash");
  assert.equal(new Settings(f, fakeCrypto()).pref("geminiModel", "auto"), "gemini-3.7-flash");
  assert.equal(new Settings(f, fakeCrypto()).pref("claudeModel", "claude-opus-5-5"), "claude-opus-5-5");
});

// ---------- Mac：App 自己加密，不用系统钥匙串 ----------
const { FileCrypto } = await import("../src/main/store/filecrypto.js");

test("App 自己加密：能加密解密；密钥文件只有本人能读；换一把密钥或改动密文都解不开", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-fc-"));
  const a = new FileCrypto(path.join(dir, "sub", "secret.key"));
  assert.equal(a.isEncryptionAvailable(), true);
  const enc = a.encryptString(KEY);
  assert.equal(enc.toString("latin1").includes(KEY), false);
  assert.equal(a.decryptString(enc), KEY);
  assert.notDeepEqual(a.encryptString(KEY), enc, "每次加密结果不同");
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(dir, "sub", "secret.key")).mode & 0o777, 0o600);
  assert.equal(new FileCrypto(path.join(dir, "sub", "secret.key")).decryptString(enc), KEY, "重新打开用同一把密钥");
  assert.throws(() => new FileCrypto(path.join(dir, "other.key")).decryptString(enc));
  enc[enc.length - 1] ^= 1;
  assert.throws(() => a.decryptString(enc));
});

test("Mac：新 key 用 App 自己的加密保存，完全不碰钥匙串", () => {
  const f = file();
  let touched = 0;
  const keychain = { isEncryptionAvailable: () => { touched += 1; return true; }, encryptString: () => { touched += 1; return Buffer.from("x"); }, decryptString: () => { touched += 1; return "x"; } };
  const s = new Settings(f, new FileCrypto(path.join(path.dirname(f), "secret.key")), keychain);
  s.setKey("gemini", KEY);
  assert.equal(s.getKey("gemini"), KEY);
  assert.equal(new Settings(f, new FileCrypto(path.join(path.dirname(f), "secret.key")), keychain).getKey("gemini"), KEY);
  assert.equal(s.getKey("claude"), "");
  assert.equal(touched, 0);
  assert.equal(fs.readFileSync(f, "utf8").includes(KEY), false);
});

test("Mac：旧版存在钥匙串里的 key 读一次就转存，之后不再碰钥匙串；用户不允许读就先当没有，下次再问", () => {
  const f = file();
  new Settings(f, fakeCrypto()).setKey("gemini", KEY); // 旧版：用系统钥匙串存的
  let reads = 0, deny = true;
  const keychain = { ...fakeCrypto(), decryptString: (b) => { reads += 1; if (deny) throw new Error("用户拒绝"); return fakeCrypto().decryptString(b); } };
  const open = () => new Settings(f, new FileCrypto(path.join(path.dirname(f), "secret.key")), keychain);
  const first = open();
  assert.equal(first.getKey("gemini"), "");
  assert.equal(reads, 0, "窗口出来之前不读钥匙串");
  assert.equal(first.migrateLegacy(), false);
  assert.equal(first.getKey("gemini"), "");
  reads = 1;
  deny = false;
  const s = open();
  assert.equal(s.migrateLegacy(), true);
  assert.equal(s.getKey("gemini"), KEY);
  assert.equal(s.getKey("gemini"), KEY);
  const again = open();
  assert.equal(again.getKey("gemini"), KEY);
  assert.equal(again.migrateLegacy(), false);
  assert.equal(reads, 2, "拒绝一次、成功一次，之后都不再读钥匙串");
});

test("Windows：仍然用系统加密，保存的格式和以前一样", () => {
  const f = file();
  new Settings(f, fakeCrypto()).setKey("gemini", KEY);
  const stored = JSON.parse(fs.readFileSync(f, "utf8")).keys.gemini;
  assert.equal(Buffer.from(stored, "base64").toString().startsWith("ENC:"), true);
});
