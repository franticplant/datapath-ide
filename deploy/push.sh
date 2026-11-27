#!/bin/sh
# Ship this checkout to the bridge host and (re)install it.
#   deploy/push.sh SSH-HOST [install.sh options...]     (root SSH access to the bridge host)
# Sends only what the bridge needs (tracked + new non-ignored files of web/ server/ mcp/
# tests/correctness/ deploy/ and package.json), never .git, node_modules, build/ or workspace/.
set -eu
[ $# -ge 1 ] || { echo "usage: deploy/push.sh SSH-HOST [install.sh options...]" >&2; exit 2; }
HOST=$1
[ $# -gt 0 ] && shift
cd "$(dirname "$0")/.."
id=$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD 2>/dev/null || echo nogit)
git diff --quiet HEAD -- 2>/dev/null || id="$id-dirty"
dest=/opt/datapath-studio/releases/$id
echo "release $id -> $HOST:$dest"
git ls-files -z -co --exclude-standard -- web server mcp tests/correctness deploy package.json LICENSE THIRD_PARTY_NOTICES.md \
  | tar --null -T - -cf - \
  | ssh "$HOST" "set -e; umask 022; mkdir -p '$dest'; tar -xf - -C '$dest' --no-same-owner"
ssh -t "$HOST" "bash '$dest/deploy/install.sh' $*"
