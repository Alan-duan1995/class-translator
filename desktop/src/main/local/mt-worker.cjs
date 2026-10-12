// 后台线程：加载本地翻译模型（英语 → 简体中文），一句一句翻。放在线程里是为了加载和翻译都不卡窗口。
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// 引擎里没有带加速指令的矩阵运算时，用它自带的普通实现
const GEMM = {
  int8_prepare_a: "int8PrepareAFallback", int8_prepare_b: "int8PrepareBFallback",
  int8_prepare_b_from_transposed: "int8PrepareBFromTransposedFallback",
  int8_prepare_b_from_quantized_transposed: "int8PrepareBFromQuantizedTransposedFallback",
  int8_prepare_bias: "int8PrepareBiasFallback", int8_multiply_and_add_bias: "int8MultiplyAndAddBiasFallback",
  int8_select_columns_of_b: "int8SelectColumnsOfBFallback",
};
const CONFIG = ["beam-size: 1", "normalize: 1.0", "word-penalty: 0", "cpu-threads: 0", "gemm-precision: int8shiftAlphaAll",
  "skip-cost: true", "alignment: soft", "quiet: true", "quiet-translation: true", "max-length-break: 128",
  "mini-batch-words: 1024", "workspace: 128", "max-length-factor: 2.0", ""].join("\n");

function loadEngine(dir) {
  return new Promise((resolve, reject) => {
    const M = globalThis.Module = {
      instantiateWasm: (info, accept) => {
        const gemm = Object.fromEntries(Object.entries(GEMM).map(([k, n]) => [k, (...a) => M.asm[n](...a)]));
        WebAssembly.instantiate(fs.readFileSync(path.join(dir, "bergamot-translator-worker.wasm")), { ...info, wasm_gemm: gemm })
          .then(({ instance }) => accept(instance)).catch(reject);
        return {};
      },
      onRuntimeInitialized: () => resolve(M),
      print: () => {}, printErr: () => {},
    };
    globalThis.require = require; // 引擎的启动脚本按普通脚本运行，要自己找得到 require
    vm.runInThisContext(fs.readFileSync(path.join(dir, "bergamot-translator-worker.js"), "utf8"));
  });
}

(async () => {
  const { modelDir, engineDir } = workerData;
  const files = ["model.bin", "lex.bin", "src.spm", "trg.spm"];
  for (const f of files) if (!fs.existsSync(path.join(modelDir, f))) throw new Error(`找不到模型文件 ${f}`);
  const M = await loadEngine(engineDir);
  const mem = (file, align) => {
    const b = fs.readFileSync(path.join(modelDir, file));
    const m = new M.AlignedMemory(b.byteLength, align);
    m.getByteArrayView().set(b);
    return m;
  };
  const vocabs = new M.AlignedMemoryList();
  vocabs.push_back(mem("src.spm", 64));
  vocabs.push_back(mem("trg.spm", 64));
  const model = new M.TranslationModel(CONFIG, mem("model.bin", 256), mem("lex.bin", 64), vocabs, null);
  const service = new M.BlockingService({ cacheSize: 0 });

  parentPort.on("message", ({ id, text }) => {
    let input, opts, res;
    try {
      input = new M.VectorString(); input.push_back(text);
      opts = new M.VectorResponseOptions(); opts.push_back({ alignment: false, html: false, qualityScores: false });
      res = service.translate(model, input, opts);
      parentPort.postMessage({ id, tr: res.get(0).getTranslatedText() });
    } catch (e) {
      parentPort.postMessage({ id, error: String(e?.message ?? e) });
    } finally {
      input?.delete(); opts?.delete(); res?.delete();
    }
  });
  parentPort.postMessage({ type: "ready" });
})().catch((e) => {
  parentPort.postMessage({ type: "error", msg: String(e?.message ?? e) });
  process.exit(1);
});
