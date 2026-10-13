#!/usr/bin/env bash
# Cài Work From Bed: tải thư viện, thêm biểu tượng vào menu ứng dụng, rồi mở bảng điều khiển.
set -e
DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
bash "$DIR/run.sh" --install
exec bash "$DIR/launch.sh"
