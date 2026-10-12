#!/bin/bash
# 下载随安装包分发的模型，都不进 git。
# 本地实时识别用的英语模型（Kroko 社区模型，CC-BY-SA）。66 MB。
set -euo pipefail
cd "$(dirname "$0")/.."
NAME=sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06
OUT=models/kroko-en
if [ ! -f "$OUT/encoder.onnx" ] || [ ! -f "$OUT/tokens.txt" ]; then
TMP=$(mktemp -d)
gh release download asr-models -R k2-fsa/sherpa-onnx -p "$NAME.tar.bz2" -D "$TMP"
tar xjf "$TMP/$NAME.tar.bz2" -C "$TMP"
mkdir -p "$OUT"
cp "$TMP/$NAME/encoder.onnx" "$TMP/$NAME/decoder.onnx" "$TMP/$NAME/joiner.onnx" "$TMP/$NAME/tokens.txt" "$OUT/"
rm -rf "$TMP"
echo "已下载模型到 $OUT"
fi

# 本地翻译用的英语 → 简体中文模型（Mozilla Firefox Translations，MPL-2.0，2.2 版）。52 MB，不进 git。下载后核对 SHA256。
MT=models/mt-en-zh
BASE=https://firefox-settings-attachments.cdn.mozilla.net/main-workspace/translations-models
fetch_mt() { # 文件名 远程文件 SHA256
  if [ -f "$MT/$1" ] && [ "$(shasum -a 256 "$MT/$1" | cut -d' ' -f1)" = "$3" ]; then return; fi
  mkdir -p "$MT"
  curl -fsSL --retry 3 -o "$MT/$1.part" "$BASE/$2"
  if [ "$(shasum -a 256 "$MT/$1.part" | cut -d' ' -f1)" != "$3" ]; then rm -f "$MT/$1.part"; echo "模型文件 $1 校验不对" >&2; exit 1; fi
  mv "$MT/$1.part" "$MT/$1"
  echo "已下载 $MT/$1"
}
fetch_mt model.bin a7ff7d5e-e67e-406c-a34b-a7edea35b10e.bin 4e5accc141373565ddc8fa1565bceaa8d0c3482a82cab8131c719ebcc6c2157c
fetch_mt src.spm ea98c52c-58dc-45d5-af23-38f2b029d020.spm bd9b65504acc6d9726dd281f7defc2adb7c2c22d0688fe2f84697de25197c8c5
fetch_mt trg.spm bddbda68-d4d2-4317-a0a1-119caa47525e.spm aded6993c36e440284d11cec3f6b8aef9c0e43188a772d80be342a713adf223d
fetch_mt lex.bin da8fccc0-31df-4665-9703-96d36606e019.bin 4a5e5827788060f1d718a8132b69440929387514a045796e9b77f935db68c055
