#!/usr/bin/env bash
# 配布用ソースZIPを作る（git 管理下のファイルのみ。秘密情報・実DB・node_modules・キャッシュ・ログは含まれない）
set -euo pipefail
cd "$(dirname "$0")/.."
ver=$(node -p "require('./package.json').version")
mkdir -p release
out="release/stockpilot-operations-${ver}-source.zip"
rm -f "$out"
git ls-files -z . | grep -zv '^release/' | xargs -0 zip -q "$out"
echo "created $out"
unzip -l "$out" | grep -Ei '\.env$|node_modules|\.data|\.log$|\.sqlite|dump' && { echo 'NG: 除外すべきファイルが含まれています'; exit 1; } || echo 'OK: 除外対象なし'
