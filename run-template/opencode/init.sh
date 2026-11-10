#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
set -a
# shellcheck disable=SC1091
source "$SCRIPT_DIR/.env"
set +a

npx -y supergateway@4.2.2 \
  --config "$SCRIPT_DIR/mcp-gateway.json" \
  --exitWithProcess "$$" \
  </dev/null >>"$SCRIPT_DIR/mcp-gateway.log" 2>&1 &
