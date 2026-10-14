#!/usr/bin/env python3
"""Work From Bed: điều khiển laptop từ điện thoại qua trình duyệt.

Chạy:  ./run.sh                    (lần đầu sẽ tự cài thư viện)
       ./run.sh --show             in lại địa chỉ và mã QR rồi thoát
       ./run.sh --install          thêm Work From Bed vào menu ứng dụng
       ./run.sh --autostart on     tự chạy mỗi khi đăng nhập (off để tắt)
Bảng điều khiển trên laptop: http://localhost:8765/admin
"""

import argparse
import asyncio
import contextlib
import hmac
import ipaddress
import itertools
import json
import logging
import os
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from aiohttp import WSMsgType, web
from Xlib.error import ConnectionClosedError

from capture import PRESETS, Capturer
from desktop import MODIFIERS, Desktop

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
CONFIG_HOME = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
CONFIG_FILE = CONFIG_HOME / "work_from_bed" / "config.json"
DATA_HOME = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
MENU_FILE = DATA_HOME / "applications" / "work-from-bed.desktop"
AUTOSTART_FILE = CONFIG_HOME / "autostart" / "work-from-bed.desktop"
IN_DOCKER = os.environ.get("WFB_DOCKER") == "1"
TOKEN_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"
DEFAULT_PORT = 8765
TAILSCALE_NET = ipaddress.ip_network("100.64.0.0/10")

# Lệnh có tiền tố này được nhờ systemd của người dùng chạy thẳng trên máy, qua D-Bus phiên.
# Cần cho bản Docker: tiến trình trong container không thuộc phiên đăng nhập nên polkit đòi mật khẩu
# khi tự gọi systemctl, còn tiến trình do systemd người dùng chạy thì được phép.
VIA_USER_SYSTEMD = "via-user-systemd"
# Thử lần lượt từng cách cho tới khi một cách thành công.
SYSTEM_ACTIONS = {
    "lock": [
        ["loginctl", "lock-session"],
        ["dbus-send", "--session", "--print-reply", "--dest=org.gnome.ScreenSaver",
         "/org/gnome/ScreenSaver", "org.gnome.ScreenSaver.Lock"],
        ["xdg-screensaver", "lock"],
    ],
    "suspend": [["systemctl", "suspend"], [VIA_USER_SYSTEMD, "/usr/bin/systemctl", "suspend"]],
    "reboot": [["systemctl", "reboot"], [VIA_USER_SYSTEMD, "/usr/bin/systemctl", "reboot"]],
    "poweroff": [["systemctl", "poweroff"], [VIA_USER_SYSTEMD, "/usr/bin/systemctl", "poweroff"]],
}
# Âm thanh: "hi" stereo 48 kHz (~1,5 Mbit/s), "lo" mono 24 kHz (~0,4 Mbit/s); PCM 16-bit, gói 20 ms.
AUDIO_FORMATS = {"hi": (48000, 2), "lo": (24000, 1)}

SYSTEM_MESSAGES = {
    "lock": "Đã khoá màn hình laptop.",
    "suspend": "Laptop đang chuyển sang chế độ ngủ…",
    "reboot": "Laptop đang khởi động lại…",
    "poweroff": "Laptop đang tắt…",
}

log = logging.getLogger("wfb")


# ---------- cấu hình & bảo mật ----------

def load_config(new_token=False):
    try:
        cfg = json.loads(CONFIG_FILE.read_text())
    except (OSError, ValueError):
        cfg = {}
    if new_token or not cfg.get("token"):
        raw = "".join(secrets.choice(TOKEN_ALPHABET) for _ in range(12))
        cfg["token"] = "-".join(raw[i:i + 4] for i in range(0, 12, 4))
        CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
        CONFIG_FILE.write_text(json.dumps(cfg, indent=2))
        CONFIG_FILE.chmod(0o600)
    return cfg


def token_matches(given, expected):
    def norm(t):
        return "".join(c for c in t.lower() if c.isascii() and c.isalnum()).encode()
    return hmac.compare_digest(norm(given), norm(expected))


class Guard:
    """Chặn tạm thời một IP sau 5 lần nhập sai mã (1 phút, rồi 2, 4, 8… phút)."""

    def __init__(self):
        self.fails = {}

    def blocked(self, ip):
        return time.monotonic() < self.fails.get(ip, (0, 0))[1]

    def fail(self, ip):
        n = self.fails.get(ip, (0, 0))[0] + 1
        self.fails[ip] = (n, time.monotonic() + 60 * 2 ** (n - 5) if n >= 5 else 0)

    def ok(self, ip):
        self.fails.pop(ip, None)


def x_lost():
    # Phiên đồ hoạ đã đóng (đăng xuất, tắt máy): không còn gì để điều khiển. Thoát với mã lỗi
    # để Docker (restart: on-failure) khởi động lại và chờ phiên mới.
    log.error("Mất kết nối tới màn hình X11 (đã đăng xuất?). Thoát.")
    os._exit(3)


def _report_error(future):
    exc = future.exception()
    if exc is None:
        return
    if isinstance(exc, (ConnectionClosedError, OSError)):
        x_lost()
    log.error("Lỗi khi điều khiển: %r", exc)


def run_via_user_systemd(argv):
    """Như `systemd-run --user argv`: chạy lệnh trên máy dưới systemd của người dùng."""
    from jeepney import DBusAddress, new_method_call
    from jeepney.io.blocking import open_dbus_connection
    from jeepney.wrappers import unwrap_msg

    manager = DBusAddress("/org/freedesktop/systemd1", bus_name="org.freedesktop.systemd1",
                          interface="org.freedesktop.systemd1.Manager")
    unit = f"work-from-bed-{time.time_ns()}.service"
    props = [("ExecStart", ("a(sasb)", [(argv[0], list(argv), False)]))]
    msg = new_method_call(manager, "StartTransientUnit", "ssa(sv)a(sa(sv))", (unit, "fail", props, []))
    with open_dbus_connection(bus="SESSION") as conn:
        unwrap_msg(conn.send_and_get_reply(msg, timeout=10))  # lỗi D-Bus sẽ nổ thành exception


def audio_command(rate, channels):
    """Lệnh ghi lại những gì đang phát ra loa mặc định (monitor), xuất PCM s16le ra stdout.
    Đặt WFB_AUDIO_SOURCE để ghi từ nguồn khác (tên lấy từ `ffmpeg -sources pulse`)."""
    source = os.environ.get("WFB_AUDIO_SOURCE", "@DEFAULT_MONITOR@")
    if shutil.which("parec"):
        return ["parec", f"--device={source}", "--format=s16le", f"--rate={rate}",
                f"--channels={channels}", "--latency-msec=20"]
    if shutil.which("ffmpeg"):
        return ["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "pulse", "-sample_rate", str(rate),
                "-channels", str(channels), "-fragment_size", str(rate * channels * 2 // 50),
                "-i", source, "-f", "s16le", "-flush_packets", "1", "-"]
    return None


class LaptopSpeaker:
    """Tắt tiếng loa laptop khi có điện thoại đang nghe, bật lại khi không còn ai nghe.

    Monitor của loa trong PipeWire không bị ảnh hưởng khi loa tắt tiếng, nên điện thoại vẫn nghe đủ.
    Chỉ bật lại những loa do mình tắt; danh sách được ghi ra file để lỡ server bị tắt ngang thì lần
    chạy sau vẫn bật lại được."""

    STATE = CONFIG_FILE.parent / "muted-speakers.json"

    def __init__(self):
        self.listeners = 0
        self.lock = asyncio.Lock()
        self.watcher = None
        try:
            self.muted = set(json.loads(self.STATE.read_text()))
        except (OSError, ValueError):
            self.muted = set()

    def _save(self):
        if self.muted:
            self.STATE.write_text(json.dumps(sorted(self.muted)))
        else:
            self.STATE.unlink(missing_ok=True)

    @staticmethod
    def _target(pulse):
        """Loa đang được ghi tiếng: loa mặc định, hoặc loa có monitor đặt trong WFB_AUDIO_SOURCE."""
        source = os.environ.get("WFB_AUDIO_SOURCE", "@DEFAULT_MONITOR@")
        if source == "@DEFAULT_MONITOR@":
            return pulse.server_info().default_sink_name
        return source[: -len(".monitor")] if source.endswith(".monitor") else None  # micro…: không tắt gì

    def _mute_default(self):
        """Tắt tiếng loa đang được ghi (nếu chưa ai tắt). Trả về True nếu loa đang im nhờ mình."""
        import pulsectl
        with pulsectl.Pulse("work-from-bed") as pulse:
            name = self._target(pulse)
            if name is None:
                return False
            if name in self.muted:
                return True
            sink = pulse.get_sink_by_name(name)
            if sink.mute:  # người dùng đã tự tắt tiếng: không đụng tới, sau này cũng không bật lại
                return False
            pulse.sink_mute(sink.index, True)
            self.muted.add(name)
            self._save()
            log.info("Đã tắt tiếng loa laptop (%s) vì đang phát trên điện thoại.", name)
            return True

    def _restore(self):
        if not self.muted:
            return
        import pulsectl
        with pulsectl.Pulse("work-from-bed") as pulse:
            for name in self.muted:
                with contextlib.suppress(Exception):
                    pulse.sink_mute(pulse.get_sink_by_name(name).index, False)
        log.info("Đã bật lại loa laptop.")
        self.muted.clear()
        self._save()

    async def _call(self, fn):
        try:
            return await asyncio.to_thread(fn)
        except Exception as e:  # không có PulseAudio/PipeWire, thiếu libpulse…: vẫn truyền tiếng bình thường
            log.warning("Không điều khiển được loa laptop: %r", e)
            return False

    async def _follow_default(self):
        while True:  # đổi loa trong lúc nghe (cắm tai nghe…) thì tắt tiếng luôn loa mới
            await asyncio.sleep(3)
            await self._call(self._mute_default)

    async def acquire(self):
        async with self.lock:
            self.listeners += 1
            if self.listeners == 1:
                self.watcher = asyncio.create_task(self._follow_default())
            return await self._call(self._mute_default)

    async def release(self):
        async with self.lock:
            self.listeners -= 1
            if self.listeners == 0:
                self.watcher.cancel()
                await self._call(self._restore)

    async def restore_leftovers(self):
        if self.muted:
            await self._call(self._restore)


def add_event(app, kind, text):
    app["events"].appendleft({"ts": time.time(), "kind": kind, "text": text})


def device_label(ua):
    ua = ua or ""
    system = next((name for key, name in (
        ("iPhone", "iPhone"), ("iPad", "iPad"), ("Android", "Android"), ("Macintosh", "Mac"),
        ("Windows", "Windows"), ("Linux", "Linux"),
    ) if key in ua), "Thiết bị lạ")
    browser = next((name for keys, name in (
        (("Edg/",), "Edge"), (("SamsungBrowser",), "Samsung Internet"), (("Firefox", "FxiOS"), "Firefox"),
        (("Chrome", "CriOS"), "Chrome"), (("Safari",), "Safari"),
    ) if any(k in ua for k in keys)), "")
    return f"{system} · {browser}" if browser else system


# ---------- một phiên kết nối từ điện thoại ----------

class Session:
    _ids = itertools.count(1)

    def __init__(self, app, ws, request):
        self.id = next(self._ids)
        self.ws = ws
        self.ip = request.remote
        self.device = device_label(request.headers.get("User-Agent"))
        self.since = time.time()
        self.kicked = False
        self.desk = app["desktop"]
        self.input = app["input"]  # một thread dùng chung cho mọi thao tác X11, giữ đúng thứ tự
        self.cap = Capturer()
        self.cap_exec = ThreadPoolExecutor(1, thread_name_prefix="capture")
        self.region = None
        self.preset = "mid"
        self.gen = 0
        self.force = True
        self.ready = asyncio.Event()
        self.acked = asyncio.Event()
        self.acked.set()
        self.send_lock = asyncio.Lock()
        self.last_input = 0.0
        self.keys_down = set()
        self.buttons_down = set()

    def info(self):
        return {"id": self.id, "ip": self.ip, "device": self.device, "since": self.since,
                "monitor": self.region["name"] if self.region else None, "preset": self.preset}

    def run(self, fn, *args):
        self.input.submit(fn, *args).add_done_callback(_report_error)

    async def call(self, fn, *args):
        try:
            return await asyncio.get_running_loop().run_in_executor(self.input, fn, *args)
        except (ConnectionClosedError, OSError):
            x_lost()

    async def send_json(self, obj):
        async with self.send_lock:
            if not self.ws.closed:
                await self.ws.send_str(json.dumps(obj))

    async def configure(self, preset, mon):
        mons = await self.call(self.desk.monitors)
        sel = (next((m for m in mons if m["name"] == mon), None)
               or next((m for m in mons if m["primary"]), mons[0]))
        self.preset = preset if preset in PRESETS else "mid"
        loop = asyncio.get_running_loop()
        w, h = await loop.run_in_executor(self.cap_exec, self.cap.configure, sel, self.preset)
        self.region = sel
        self.gen = (self.gen + 1) & 0xFFFF
        self.force = True
        await self.send_json({
            "t": "screen", "gen": self.gen, "w": w, "h": h, "nw": sel["width"], "nh": sel["height"],
            "mon": sel["name"], "preset": self.preset, "mons": mons,
        })
        self.acked.set()
        self.ready.set()

    async def stream(self):
        loop = asyncio.get_running_loop()
        await self.ready.wait()
        last_change = 0.0
        while not self.ws.closed:
            try:
                await asyncio.wait_for(self.acked.wait(), 10)
            except asyncio.TimeoutError:
                self.force = True  # điện thoại im lặng quá lâu: gửi lại cả khung hình
            started = loop.time()
            force, self.force = self.force, False
            try:
                frame = await loop.run_in_executor(self.cap_exec, self.cap.grab, force, self.gen)
            except Exception as e:  # thường do vừa đổi độ phân giải hoặc rút màn hình
                log.warning("Không chụp được màn hình (%r), cấu hình lại.", e)
                await asyncio.sleep(1)
                await self.configure(self.preset, self.region["name"])
                continue
            if frame:
                self.acked.clear()
                async with self.send_lock:
                    await self.ws.send_bytes(frame)
                last_change = loop.time()
            # Khi màn hình đứng yên và không ai thao tác thì chụp thưa lại cho đỡ tốn CPU.
            active = loop.time() - max(last_change, self.last_input) < 3
            delay = 1 / self.cap.fps if active else 0.25
            await asyncio.sleep(max(0.0, delay - (loop.time() - started)))

    async def track_cursor(self):
        await self.ready.wait()
        last = None
        while not self.ws.closed:
            x, y = await self.call(self.desk.pointer)
            pos = (x - self.region["left"], y - self.region["top"])
            if pos != last:
                last = pos
                await self.send_json({"t": "cur", "x": pos[0], "y": pos[1]})
            await asyncio.sleep(0.05)

    async def handle(self, m):
        t = m.get("t")
        if t == "ack":
            self.acked.set()
            return
        if t == "ping":
            await self.send_json({"t": "pong", "ts": m.get("ts")})
            return
        if t == "cfg":
            await self.configure(m.get("preset"), m.get("mon"))
            return
        if t == "sys":
            await self.system(str(m.get("a")))
            return
        if self.region is None:
            return
        self.last_input = asyncio.get_running_loop().time()
        d, r = self.desk, self.region
        if t == "move":
            x = r["left"] + min(max(float(m["x"]), 0.0), 1.0) * (r["width"] - 1)
            y = r["top"] + min(max(float(m["y"]), 0.0), 1.0) * (r["height"] - 1)
            self.run(d.move, x, y)
        elif t == "rel":
            self.run(d.move_by, int(m["dx"]), int(m["dy"]), r)
        elif t == "btn":
            button, down = int(m["b"]), bool(m["down"])
            if button in (1, 2, 3):
                (self.buttons_down.add if down else self.buttons_down.discard)(button)
                self.run(d.button, button, down)
        elif t == "click":
            button = int(m.get("b", 1))
            if button in (1, 2, 3):
                self.run(d.click, button, max(1, min(int(m.get("n", 1)), 3)))
        elif t == "scroll":
            dx = max(-50, min(int(m.get("dx", 0)), 50))
            dy = max(-50, min(int(m.get("dy", 0)), 50))
            self.run(d.scroll, dx, dy)
        elif t == "text":
            self.run(d.type_text, str(m["s"])[:10000])
        elif t == "key":
            mods = [x for x in m.get("mods") or [] if x in MODIFIERS]
            self.run(d.key, str(m["k"]), mods, max(1, min(int(m.get("n", 1)), 500)))
        elif t in ("keydown", "keyup"):
            name, down = str(m["k"]), t == "keydown"
            (self.keys_down.add if down else self.keys_down.discard)(name)
            self.run(d.key_state, name, down)

    async def system(self, action):
        commands = SYSTEM_ACTIONS.get(action)
        if not commands:
            return
        if action != "lock":  # máy sắp ngủ/tắt: báo trước vì sau đó kết nối sẽ đứt
            await self.send_json({"t": "toast", "s": SYSTEM_MESSAGES[action]})
        for cmd in commands:
            try:
                if cmd[0] == VIA_USER_SYSTEMD:
                    await asyncio.to_thread(run_via_user_systemd, cmd[1:])
                    code = 0
                else:
                    proc = await asyncio.create_subprocess_exec(
                        *cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    code = await asyncio.wait_for(proc.wait(), 15)
            except Exception as e:  # không có lệnh này, hết giờ, hoặc D-Bus từ chối
                log.debug("Cách %s không được: %r", cmd[0], e)
                continue
            if code == 0:
                if action == "lock":
                    await self.send_json({"t": "toast", "s": SYSTEM_MESSAGES[action]})
                log.info("Đã thực hiện lệnh hệ thống: %s", action)
                return
        log.warning("Không thực hiện được lệnh hệ thống: %s", action)
        await self.send_json({"t": "toast", "s": "Laptop không thực hiện được lệnh này."})

    def release_all(self):
        """Nhả mọi nút/phím đang giữ, tránh kẹt chuột khi điện thoại mất kết nối giữa chừng."""
        for button in self.buttons_down:
            self.run(self.desk.button, button, False)
        for name in self.keys_down:
            self.run(self.desk.key_state, name, False)
        self.buttons_down.clear()
        self.keys_down.clear()


# ---------- trang cho điện thoại ----------

async def until_disconnected(coro):
    """Kết nối đứt giữa lúc đang gửi (ws.closed chưa kịp thành True) thì dừng lặng lẽ."""
    with contextlib.suppress(ConnectionError):
        await coro


async def ws_handler(request):
    app, ip = request.app, request.remote
    ws = web.WebSocketResponse(heartbeat=20, max_msg_size=1 << 20)
    await ws.prepare(request)
    guard = app["guard"]
    if guard.blocked(ip):
        await ws.close(code=4003, message=b"too many attempts")
        return ws
    if not token_matches(request.query.get("k", ""), app["token"]):
        guard.fail(ip)
        log.warning("Từ chối %s: sai mã kết nối.", ip)
        add_event(app, "reject", f"{ip} nhập sai mã kết nối")
        await ws.close(code=4001, message=b"bad token")
        return ws
    guard.ok(ip)

    session = Session(app, ws, request)
    log.info("Điện thoại %s (%s) đã kết nối.", ip, session.device)
    add_event(app, "connect", f"{session.device} ({ip}) đã kết nối")
    app["sessions"].add(session)
    tasks = [asyncio.create_task(until_disconnected(session.stream())),
             asyncio.create_task(until_disconnected(session.track_cursor()))]
    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            try:
                m = json.loads(msg.data)
                if isinstance(m, dict):
                    await session.handle(m)
            except (ValueError, KeyError, TypeError) as e:
                log.debug("Bỏ qua tin nhắn lỗi %r: %s", e, msg.data[:200])
    except ConnectionError:
        pass
    finally:
        app["sessions"].discard(session)
        for task in tasks:
            task.cancel()
        session.release_all()
        session.cap_exec.submit(session.cap.close)
        session.cap_exec.shutdown(wait=False)
        log.info("Điện thoại %s đã ngắt kết nối.", ip)
        if not session.kicked:
            add_event(app, "disconnect", f"{session.device} ({ip}) đã ngắt kết nối")
    return ws


async def audio_handler(request):
    app, ip = request.app, request.remote
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    if app["guard"].blocked(ip):
        await ws.close(code=4003, message=b"too many attempts")
        return ws
    if not token_matches(request.query.get("k", ""), app["token"]):
        app["guard"].fail(ip)
        await ws.close(code=4001, message=b"bad token")
        return ws
    rate, channels = AUDIO_FORMATS.get(request.query.get("q"), AUDIO_FORMATS["hi"])
    cmd = audio_command(rate, channels)
    if not cmd:
        log.warning("Không có parec hay ffmpeg để ghi âm thanh.")
        await ws.close(code=4005, message=b"no audio capture tool")
        return ws

    proc = await asyncio.create_subprocess_exec(
        *cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    chunk = rate * channels * 2 // 50  # 20 ms
    queue = asyncio.Queue(maxsize=10)  # mạng chậm thì bỏ đoạn cũ, giữ độ trễ dưới ~200 ms

    async def capture():
        try:
            while True:
                data = await proc.stdout.readexactly(chunk)
                if not data.strip(b"\0"):
                    continue  # im lặng tuyệt đối (không có gì đang phát): không gửi cho đỡ tốn mạng
                if queue.full():
                    queue.get_nowait()
                queue.put_nowait(data)
        except asyncio.IncompleteReadError:
            log.warning("Chương trình ghi âm thanh đã dừng.")
            await ws.close(code=4006, message=b"audio capture stopped")

    async def pump():
        while True:
            await ws.send_bytes(await queue.get())

    mute = request.query.get("mute") == "1"
    laptop_muted = await app["speaker"].acquire() if mute else False
    await ws.send_json({"t": "audio", "rate": rate, "channels": channels, "laptop_muted": laptop_muted})
    device = device_label(request.headers.get("User-Agent"))
    log.info("Điện thoại %s bật âm thanh (%d Hz, %d kênh).", ip, rate, channels)
    add_event(app, "audio", f"{device} ({ip}) bật âm thanh" + (", loa laptop tạm tắt" if laptop_muted else ""))
    app["audio_sockets"].add(ws)
    tasks = [asyncio.create_task(until_disconnected(capture())), asyncio.create_task(until_disconnected(pump()))]
    try:
        async for _ in ws:
            pass
    except ConnectionError:
        pass
    finally:
        app["audio_sockets"].discard(ws)
        for task in tasks:
            task.cancel()
        with contextlib.suppress(ProcessLookupError):
            proc.kill()
        await proc.wait()
        if mute:
            await app["speaker"].release()
        log.info("Điện thoại %s tắt âm thanh.", ip)
        add_event(app, "audio", f"{device} ({ip}) tắt âm thanh")
    return ws


async def index(request):
    return web.FileResponse(STATIC / "index.html")


async def manifest(request):
    return web.FileResponse(STATIC / "manifest.webmanifest",
                            headers={"Content-Type": "application/manifest+json"})


async def no_cache(request, response):
    # Luôn hỏi lại server, để trình duyệt không giữ bản giao diện cũ sau khi cập nhật.
    response.headers["Cache-Control"] = "no-cache"


# ---------- bảng điều khiển trên laptop (/admin) ----------

def is_local_request(request):
    """Chỉ chấp nhận trình duyệt trên chính laptop. Kiểm tra cả Host để chặn DNS rebinding."""
    try:
        ip = ipaddress.ip_address(request.remote or "")
    except ValueError:
        return False
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_loopback and request.url.host in ("localhost", "127.0.0.1", "::1")


@web.middleware
async def admin_guard(request, handler):
    if request.path == "/admin" or request.path.startswith("/admin/"):
        if not is_local_request(request):
            raise web.HTTPForbidden(
                text=f"Bảng điều khiển chỉ mở được trên chính laptop: http://localhost:{request.app['port']}/admin")
        # Header tự đặt buộc trình duyệt hỏi CORS trước, nên trang web lạ không gửi lệnh thay được.
        if request.method != "GET" and request.headers.get("X-WFB-Admin") != "1":
            raise web.HTTPForbidden(text="Thiếu header X-WFB-Admin.")
    return await handler(request)


async def admin_page(request):
    return web.FileResponse(STATIC / "admin.html")


async def admin_state(request):
    app = request.app
    return web.json_response({
        "token": app["token"],
        "port": app["port"],
        "started": app["started"],
        "urls": app["urls"](),
        "clients": sorted((s.info() for s in app["sessions"]), key=lambda c: c["since"]),
        "events": list(app["events"]),
        "docker": IN_DOCKER,
        "autostart": None if IN_DOCKER else AUTOSTART_FILE.exists(),
        "menu": None if IN_DOCKER else MENU_FILE.exists(),
    })


async def admin_qr(request):
    import qrcode
    import qrcode.image.svg

    urls = request.app["urls"]()
    try:
        url = urls[int(request.query.get("i", 0))]["url"]
    except (ValueError, IndexError):
        raise web.HTTPNotFound()
    img = qrcode.make(url, image_factory=qrcode.image.svg.SvgPathImage, box_size=10, border=2)
    return web.Response(body=img.to_string(), content_type="image/svg+xml")


async def admin_kick(request):
    app, data = request.app, await request.json()
    for s in list(app["sessions"]):
        if s.id == data.get("id"):
            s.kicked = True
            add_event(app, "kick", f"Đã ngắt {s.device} ({s.ip}) từ bảng điều khiển")
            await s.ws.close(code=4002, message=b"kicked")
    return web.json_response({"ok": True})


async def admin_token(request):
    app = request.app
    app["token"] = load_config(new_token=True)["token"]
    add_event(app, "token", "Đã đổi mã kết nối. Mọi điện thoại phải quét lại mã QR mới")
    for s in list(app["sessions"]):
        s.kicked = True
        await s.ws.close(code=4004, message=b"token changed")
    for ws in list(app["audio_sockets"]):
        await ws.close(code=4004, message=b"token changed")
    return web.json_response({"token": app["token"]})


async def admin_autostart(request):
    if IN_DOCKER:
        raise web.HTTPBadRequest(text="Bản Docker bật tự chạy bằng: ./docker.sh autostart on")
    on = bool((await request.json()).get("on"))
    set_autostart(on)
    return web.json_response({"autostart": on})


async def admin_menu(request):
    if IN_DOCKER:
        raise web.HTTPBadRequest(text="Không áp dụng cho bản Docker.")
    install_menu()
    return web.json_response({"menu": True})


async def admin_stop(request):
    log.info("Dừng theo yêu cầu từ bảng điều khiển.")
    asyncio.get_running_loop().call_later(0.3, os.kill, os.getpid(), signal.SIGINT)
    return web.json_response({"ok": True})


async def on_shutdown(app):
    for s in list(app["sessions"]):
        await s.ws.close(code=1001, message=b"server shutdown")
    for ws in list(app["audio_sockets"]):
        await ws.close(code=1001, message=b"server shutdown")


async def on_startup(app):
    await app["speaker"].restore_leftovers()


async def on_cleanup(app):
    await app["speaker"].restore_leftovers()
    loop = asyncio.get_running_loop()
    with contextlib.suppress(ConnectionClosedError, OSError):
        await loop.run_in_executor(app["input"], app["desktop"].restore_keymap)
    app["input"].shutdown(wait=True)


# ---------- menu ứng dụng & tự chạy ----------

def _desktop_entry(args, extra=""):
    return (
        "[Desktop Entry]\n"
        "Type=Application\n"
        "Name=Work From Bed\n"
        "Comment=Điều khiển laptop từ điện thoại\n"
        f"Icon={STATIC / 'icon-512.png'}\n"
        f'Exec=bash "{ROOT / "launch.sh"}"{args}\n'
        "Terminal=false\n"
        "Categories=Network;RemoteAccess;\n"
        f"{extra}"
    )


def install_menu():
    MENU_FILE.parent.mkdir(parents=True, exist_ok=True)
    MENU_FILE.write_text(_desktop_entry(""))


def set_autostart(on):
    if on:
        AUTOSTART_FILE.parent.mkdir(parents=True, exist_ok=True)
        AUTOSTART_FILE.write_text(_desktop_entry(" --autostart", "NoDisplay=true\nX-GNOME-Autostart-enabled=true\n"))
    else:
        AUTOSTART_FILE.unlink(missing_ok=True)


# ---------- khởi động ----------

def local_addresses():
    lan = None
    with contextlib.suppress(OSError), socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.connect(("8.8.8.8", 80))  # UDP: không gửi gói nào, chỉ để biết card mạng ra Internet
        lan = s.getsockname()[0]
    try:
        out = subprocess.run(["hostname", "-I"], capture_output=True, text=True, timeout=3).stdout.split()
    except (OSError, subprocess.TimeoutExpired):
        out = []
    tailnet = []
    for ip in out:
        with contextlib.suppress(ValueError):
            if ipaddress.ip_address(ip) in TAILSCALE_NET and ip != lan:
                tailnet.append(ip)
    if lan and ipaddress.ip_address(lan) in TAILSCALE_NET:
        tailnet.insert(0, lan)
        lan = None
    return lan, tailnet


def connection_urls(port, token, host="0.0.0.0"):
    wildcard = host in ("0.0.0.0", "::", "")
    lan, tailnet = local_addresses() if wildcard else (None, [])
    urls = []
    if lan:
        urls.append({"kind": "lan", "label": "Cùng mạng Wi-Fi", "url": f"http://{lan}:{port}/?k={token}"})
    for ip in tailnet:
        urls.append({"kind": "tailscale", "label": "Qua Tailscale, ở đâu cũng được",
                     "url": f"http://{ip}:{port}/?k={token}"})
    if not urls:
        urls.append({"kind": "local", "label": "Trên chính laptop này",
                     "url": f"http://{'localhost' if wildcard else host}:{port}/?k={token}"})
    return urls


def print_banner(port, token, host="0.0.0.0"):
    urls = connection_urls(port, token, host)
    print("\n  Mở một trong các địa chỉ sau trên điện thoại:")
    for u in urls:
        print(f"   • {u['label']}:\n     {u['url']}")
    print(f"\n  Mã kết nối: {token}")
    print(f"  Bảng điều khiển trên laptop: http://localhost:{port}/admin")
    try:
        import qrcode
        qr = qrcode.QRCode(border=2)
        qr.add_data(urls[0]["url"])
        qr.make(fit=True)
        print(f"\n  Hoặc quét mã QR này bằng camera điện thoại ({urls[0]['label'].lower()}):")
        qr.print_ascii(invert=True)
    except Exception:
        pass
    sys.stdout.flush()


def connect_display(wait):
    announced = False
    while True:
        try:
            return Desktop()
        except Exception as e:
            if not wait:
                sys.exit(f"Không kết nối được tới màn hình X11: {e}")
            if not announced:
                log.info("Đang chờ màn hình X11 %s (%s)…", os.environ.get("DISPLAY"), e)
                announced = True
            time.sleep(3)


def main():
    ap = argparse.ArgumentParser(description="Điều khiển laptop từ điện thoại qua trình duyệt.")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"cổng (mặc định {DEFAULT_PORT})")
    ap.add_argument("--host", default="0.0.0.0", help="địa chỉ lắng nghe (mặc định: mọi card mạng)")
    ap.add_argument("--new-token", action="store_true", help="tạo mã kết nối mới; điện thoại cũ phải nhập lại")
    ap.add_argument("--show", action="store_true", help="chỉ in địa chỉ và mã QR rồi thoát")
    ap.add_argument("--install", action="store_true", help="thêm Work From Bed vào menu ứng dụng rồi thoát")
    ap.add_argument("--autostart", choices=("on", "off"), help="bật/tắt tự chạy khi đăng nhập rồi thoát")
    ap.add_argument("--wait-display", action="store_true", help="chờ tới khi màn hình X11 sẵn sàng thay vì báo lỗi")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="  %(asctime)s  %(message)s", datefmt="%H:%M:%S")
    if args.install:
        install_menu()
        print(f"Đã thêm Work From Bed vào menu ứng dụng ({MENU_FILE}).")
        print("Mở menu ứng dụng, gõ \"Work From Bed\" để chạy; bảng điều khiển sẽ tự mở trên trình duyệt.")
        return
    if args.autostart:
        set_autostart(args.autostart == "on")
        print("Đã bật tự chạy khi đăng nhập." if args.autostart == "on" else "Đã tắt tự chạy khi đăng nhập.")
        return
    cfg = load_config(args.new_token)
    if args.show:
        print_banner(args.port, cfg["token"])
        return

    if not os.environ.get("DISPLAY"):
        sys.exit("Không tìm thấy màn hình X11 (biến DISPLAY trống). Hãy chạy trong phiên đồ hoạ của laptop.")
    if os.environ.get("XDG_SESSION_TYPE") == "wayland":
        print("  Cảnh báo: phiên Wayland chưa được hỗ trợ đầy đủ. Hãy đăng nhập bằng 'Ubuntu on Xorg'.")
    desktop = connect_display(args.wait_display)

    app = web.Application(middlewares=[admin_guard])
    app["token"] = cfg["token"]
    app["port"] = args.port
    app["started"] = time.time()
    app["desktop"] = desktop
    app["input"] = ThreadPoolExecutor(1, thread_name_prefix="input")
    app["guard"] = Guard()
    app["sessions"] = set()
    app["audio_sockets"] = set()
    app["speaker"] = LaptopSpeaker()
    app["events"] = deque(maxlen=50)
    url_cache = {"at": 0.0, "urls": None, "token": None}

    def urls():  # địa chỉ mạng có thể đổi (đổi Wi-Fi); dò lại tối đa 10 giây một lần
        if time.monotonic() - url_cache["at"] > 10 or url_cache["token"] != app["token"]:
            url_cache.update(at=time.monotonic(), token=app["token"],
                             urls=connection_urls(args.port, app["token"], args.host))
        return url_cache["urls"]
    app["urls"] = urls

    app.router.add_get("/", index)
    app.router.add_get("/manifest.webmanifest", manifest)
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/audio", audio_handler)
    app.router.add_get("/admin", admin_page)
    app.router.add_get("/admin/api/state", admin_state)
    app.router.add_get("/admin/qr.svg", admin_qr)
    app.router.add_post("/admin/api/kick", admin_kick)
    app.router.add_post("/admin/api/token", admin_token)
    app.router.add_post("/admin/api/autostart", admin_autostart)
    app.router.add_post("/admin/api/menu", admin_menu)
    app.router.add_post("/admin/api/stop", admin_stop)
    app.router.add_static("/s", STATIC)
    app.on_response_prepare.append(no_cache)
    app.on_startup.append(on_startup)
    app.on_shutdown.append(on_shutdown)
    app.on_cleanup.append(on_cleanup)

    print("\n  Work From Bed đang chạy" + (" trong Docker." if IN_DOCKER else "."), end="")
    print_banner(args.port, cfg["token"], args.host)
    print("  Nhấn Ctrl+C để dừng.\n", flush=True)
    add_event(app, "start", "Work From Bed đã khởi động")
    try:
        # access_log=None: không ghi URL ra log vì URL có chứa mã kết nối.
        web.run_app(app, host=args.host, port=args.port, access_log=None, print=None)
    except OSError as e:
        sys.exit(f"Không mở được cổng {args.port}: {e}. Có thể Work From Bed đang chạy rồi?")


if __name__ == "__main__":
    main()
