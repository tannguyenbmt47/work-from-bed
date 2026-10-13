#!/usr/bin/env bash
# Chạy Work From Bed trong Docker.
#   ./docker.sh up [--no-open]    dựng image (lần đầu) rồi chạy nền và mở bảng điều khiển
#   ./docker.sh down              dừng
#   ./docker.sh logs              xem nhật ký
#   ./docker.sh autostart on|off  tự chạy bản Docker mỗi khi đăng nhập
set -e
DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
cd "$DIR"

export WFB_UID="$(id -u)" WFB_GID="$(id -g)" WFB_PORT="${WFB_PORT:-8765}"
export WFB_STATE="${XDG_CACHE_HOME:-$HOME/.cache}/work_from_bed"
export WFB_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/work_from_bed"
AUTOSTART="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/work-from-bed-docker.desktop"

running() { (exec 3<>"/dev/tcp/127.0.0.1/$WFB_PORT") 2>/dev/null; }

case "${1:-up}" in
  up)
    if [ -z "$DISPLAY" ]; then
      echo "Hãy chạy lệnh này trong phiên đồ hoạ của laptop (biến DISPLAY đang trống)." >&2
      exit 1
    fi
    mkdir -p "$WFB_STATE" "$WFB_CONFIG"
    # Chép cookie X11 của phiên hiện tại ra file riêng, đổi sang dạng dùng được với mọi tên máy.
    : > "$WFB_STATE/xauth"
    xauth nlist "$DISPLAY" | sed -e 's/^..../ffff/' | xauth -q -f "$WFB_STATE/xauth" nmerge -
    chmod 600 "$WFB_STATE/xauth"
    # --force-recreate: mỗi lần đăng nhập, container phải nhận cookie và D-Bus của phiên mới.
    docker compose up -d --build --force-recreate
    for _ in $(seq 60); do running && break; sleep 0.5; done
    if ! running; then
      echo "Container chưa mở được cổng $WFB_PORT. Xem nhật ký: ./docker.sh logs" >&2
      exit 1
    fi
    docker compose logs --no-log-prefix work-from-bed | sed -n '/Mở một trong/,/Bảng điều khiển/p'
    [ "$2" = "--no-open" ] || xdg-open "http://localhost:$WFB_PORT/admin" > /dev/null 2>&1 || true
    ;;
  down)
    docker compose down
    ;;
  logs)
    docker compose logs -f --no-log-prefix
    ;;
  autostart)
    case "$2" in
      on)
        mkdir -p "$(dirname "$AUTOSTART")"
        cat > "$AUTOSTART" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Work From Bed (Docker)
Exec=bash "$DIR/docker.sh" up --no-open
NoDisplay=true
X-GNOME-Autostart-enabled=true
DESKTOP
        echo "Đã bật: mỗi lần đăng nhập, bản Docker sẽ tự chạy."
        ;;
      off)
        rm -f "$AUTOSTART"
        echo "Đã tắt tự chạy bản Docker."
        ;;
      *) echo "Cách dùng: $0 autostart on|off" >&2; exit 1 ;;
    esac
    ;;
  *)
    sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
