#!/usr/bin/env bash
# Install the DSH AtomCode CodingPlan plugin into a local DSH profile.
set -euo pipefail

PROFILE="${1:-desktop}"
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
VERSION="$(node -p "require('$HERE/package.json').version" 2>/dev/null || echo 0.2.0)"
PACKAGE="$HERE/dsh-atomcode-codingplan-$VERSION.tgz"

if ! command -v dsh >/dev/null 2>&1; then
  echo "错误：未找到 dsh 命令。请确认 DeepSeek Harness CLI 已安装并加入 PATH。" >&2
  exit 1
fi
if [[ ! -f "$PACKAGE" ]]; then
  echo "错误：找不到插件包：$PACKAGE" >&2
  echo "请先在本目录执行 npm pack 生成 .tgz。" >&2
  exit 1
fi

echo "正在将 DSH AtomCode CodingPlan 插件 $VERSION 安装到 profile: $PROFILE"
dsh plugin --profile "$PROFILE" add "$PACKAGE"

cat <<NEXT

插件已交给 DSH 安装器。

如果 profile 的 cordis.patch.yml 里存在形如 "- id: <某插件 id>" 且带
"disabled: true" 的条目，说明该插件被显式停用了；请确认其中没有指向
dsh-atomcode-codingplan 的停用行，然后重新安装。

接下来：
  1. 重启对应的 DeepSeek Harness 进程。
  2. dsh plugin --profile $PROFILE exec dsh-atomcode-codingplan doctor
  3. dsh plugin --profile $PROFILE exec dsh-atomcode-codingplan setup
     setup 会自动下载并启动本机桥接程序，并打开 AtomGit 授权页。
NEXT
