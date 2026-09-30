#!/bin/zsh
set -eu

PROJECT_DIR="${0:A:h}"
PYTHON="$PROJECT_DIR/.venv/bin/python"

if [[ ! -x "$PYTHON" ]]; then
  print -u2 "未找到项目 Python 环境：$PYTHON"
  print -u2 "请先用 Python 3.12 创建 .venv 并安装 requirements-expression.txt。"
  exit 1
fi

cd "$PROJECT_DIR"
exec "$PYTHON" simulator.py server "$@"
