#!/usr/bin/env bash
# Mở Work From Bed từ menu ứng dụng hoặc khi đăng nhập.
#   launch.sh              chạy nền nếu chưa chạy, rồi mở bảng điều khiển trên trình duyệt
#   launch.sh --autostart  chỉ chạy nền (dùng khi đăng nhập), không mở trình duyệt
DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
PORT="${WFB_PORT:-8765}"
LOG="${XDG_CACHE_HOME:-$HOME/.cache}/work-from-bed.log"
ICON="$DIR/static/icon-512.png"

running() { (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; }

if ! running; then
  mkdir -p "$(dirname "$LOG")"
  [ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt 1000000 ] && mv -f "$LOG" "$LOG.1"
  setsid bash "$DIR/run.sh" --port "$PORT" --wait-display >> "$LOG" 2>&1 < /dev/null &
  [ "$1" = "--autostart" ] && exit 0
  command -v notify-send > /dev/null && notify-send -i "$ICON" "Work From Bed" "Đang khởi động…"
  # Lần chạy đầu cần cài thư viện, có thể mất khoảng một phút.
  for _ in $(seq 240); do running && break; sleep 0.5; done
  if ! running; then
    command -v notify-send > /dev/null && notify-send -u critical -i "$ICON" "Work From Bed" "Không khởi động được. Xem nhật ký: $LOG"
    exit 1
  fi
fi

[ "$1" = "--autostart" ] || xdg-open "http://localhost:$PORT/admin" > /dev/null 2>&1
