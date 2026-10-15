#!/bin/sh
set -eu
cd "$(dirname "$0")"
build_dir=$(mktemp -d)
trap 'rm -rf "$build_dir"' EXIT
swiftc -module-cache-path "$build_dir/module-cache" ClassTranslator/Transcript.swift Tests/main.swift -o "$build_dir/core-tests"
"$build_dir/core-tests"
