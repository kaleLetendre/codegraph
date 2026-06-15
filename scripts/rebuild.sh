#!/usr/bin/env bash
# Regenerate the codegraph graph after code changes.
# Does a full --reset rebuild so deleted code doesn't linger as stale nodes.
# Default target is the parent of this plugin dir; pass a different path as $1 to
# scope elsewhere. No daemon — writes the embedded
# SQLite db at <target>/.codegraph/graph.db.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-$(cd "$HERE/.." && pwd)}"

node "$HERE/src/build.js" "$TARGET" --reset
