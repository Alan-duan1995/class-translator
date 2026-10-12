import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { LocalTranslator } from "../src/main/local/translate.js";

const modelDir = path.resolve("models/mt-en-zh");
const engineDir = path.resolve("node_modules/@browsermt/bergamot-translator/worker");
const skip = !fs.existsSync(path.join(modelDir, "model.bin")) && "需要先 npm run models";

test("真模型：英语课堂句子翻成简体中文，用中文标点", { skip, timeout: 60_000 }, async () => {
  const tr = new LocalTranslator({ workerPath: path.resolve("src/main/local/mt-worker.cjs"), modelDir, engineDir });
  try {
    const a = await tr.translate("The second law of thermodynamics tells us that the entropy of an isolated system never decreases.", "en", "zh");
    assert.equal(a.code, "");
    assert.match(a.tr, /热力学第二定律/);
    assert.match(a.tr, /熵/);
    const b = await tr.translate("If the learning rate is too high, the loss will bounce around and never converge.", "en", "zh");
    assert.match(b.tr, /学习率/);
    assert.match(b.tr, /，/);
    assert.equal(/[A-Za-z一-鿿],/.test(b.tr), false);
  } finally { tr.stop(); }
});
