#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"

if [[ ! -f "$VENV_DIR/pyvenv.cfg" ]]; then
  uv venv "$VENV_DIR"
fi
