#!/usr/bin/env bash
# Chạy Work From Bed. Lần đầu sẽ tự tạo môi trường Python và cài thư viện.
set -e
cd "$(dirname "$(readlink -f "$0")")"

if [ ! -x .venv/bin/python ]; then
  echo "Lần chạy đầu: đang cài thư viện…"
  if command -v uv >/dev/null 2>&1; then
    uv venv -q .venv
    uv pip install -q -p .venv -r requirements.txt
  else
    python3 -m venv .venv
    .venv/bin/pip install -q -r requirements.txt
  fi
fi

exec .venv/bin/python server.py "$@"
