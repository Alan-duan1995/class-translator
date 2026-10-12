import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { LocalTranslator, zhPunct } from "../src/main/local/translate.js";

function setup(reply = (m) => ({ id: m.id, tr: `[${m.text}]` })) {
  const modelDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-mt-"));
  fs.writeFileSync(path.join(modelDir, "model.bin"), "x");
  const workers = [];
  const makeWorker = (file, data) => {
    const w = Object.assign(new EventEmitter(), { file, data, terminated: false,
      postMessage: (m) => setImmediate(() => { const r = reply(m, w); if (r) w.emit("message", r); }),
      terminate: () => { w.terminated = true; } });
    workers.push(w);
    setImmediate(() => w.emit("message", { type: "ready" }));
    return w;
  };
  return { tr: new LocalTranslator({ workerPath: "w.cjs", modelDir, engineDir: "e", makeWorker }), workers, modelDir };
}

test("标点：挨着汉字的换成中文标点，数字和英文里的不动", () => {
  assert.equal(zhPunct("如果学习率过高,损失就会反弹,永不收敛。"), "如果学习率过高，损失就会反弹，永不收敛。");
  assert.equal(zhPunct("好吗? 好! 第一: 记住"), "好吗？好！第一：记住");
  assert.equal(zhPunct("一共 1,000 个,10:30 开始"), "一共 1,000 个，10:30 开始");
  assert.equal(zhPunct("调用 NumPy 库的 a, b 两个函数"), "调用 NumPy 库的 a, b 两个函数");
  assert.equal(zhPunct("热力学 第二 定律"), "热力学第二定律");
});

test("本地翻译：只支持英语译简体中文；第一次用到才启动线程，之后共用", async () => {
  const { tr, workers } = setup();
  assert.deepEqual(await tr.translate("hi", "ja", "zh"), { tr: "", code: "unsupported" });
  assert.deepEqual(await tr.translate("hi", "en", "ja"), { tr: "", code: "unsupported" });
  assert.equal(workers.length, 0);
  assert.equal(await tr.status("en", "zh"), "installed");
  assert.equal(await tr.status("en", "ja"), "unsupported");
  assert.deepEqual(await tr.translate("hi", "en", "zh"), { tr: "[hi]", code: "" });
  assert.deepEqual(await Promise.all([tr.translate("a", "en", "zh"), tr.translate("b", "en", "zh")]),
    [{ tr: "[a]", code: "" }, { tr: "[b]", code: "" }]);
  assert.equal(workers.length, 1);
  assert.deepEqual(workers[0].data, { modelDir: tr.modelDir, engineDir: "e" });
  tr.stop();
  assert.equal(workers[0].terminated, true);
});

test("本地翻译：没有模型文件就是不支持；线程崩了这一句算失败，下一句重新启动", async () => {
  const none = setup();
  fs.rmSync(path.join(none.modelDir, "model.bin"));
  assert.deepEqual(await none.tr.translate("hi", "en", "zh"), { tr: "", code: "unsupported" });

  let crash = true;
  const { tr, workers } = setup((m, w) => { if (crash) { crash = false; w.emit("exit", 1); return null; } return { id: m.id, tr: "好" }; });
  assert.deepEqual(await tr.translate("hi", "en", "zh"), { tr: "", code: "failed" });
  assert.deepEqual(await tr.translate("hi", "en", "zh"), { tr: "好", code: "" });
  assert.equal(workers.length, 2);
});
