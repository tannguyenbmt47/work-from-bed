"""Chụp màn hình, tìm vùng vừa thay đổi và nén JPEG để gửi sang điện thoại.

Mỗi gói gửi đi:  <gen:u16> <số mảnh:u16>  rồi từng mảnh  <x:u16> <y:u16> <w:u16> <h:u16> <len:u32> <jpeg>
(little-endian, toạ độ tính trên ảnh đã thu nhỏ).
"""

import io
import struct
from fractions import Fraction
from math import ceil

import mss
import numpy as np
from PIL import Image

# Chỉ dùng tỉ lệ p/q. Cắt ảnh gốc theo bội số của q thì mỗi mảnh sau khi thu nhỏ khớp đúng
# từng điểm ảnh với khung hình đầy đủ, nên chỉ cần thu nhỏ phần thay đổi mà không lộ đường ghép.
SCALES = [Fraction(1), Fraction(3, 4), Fraction(2, 3), Fraction(1, 2), Fraction(2, 5), Fraction(1, 3), Fraction(1, 4)]

PRESETS = {
    "low": {"maxw": 1024, "quality": 45, "subsampling": 2, "fps": 8},
    "mid": {"maxw": 1440, "quality": 60, "subsampling": 0, "fps": 12},
    "high": {"maxw": 1 << 16, "quality": 75, "subsampling": 0, "fps": 15},
}


class Capturer:
    """Mỗi kết nối có một Capturer chạy trên thread riêng (đối tượng mss gắn với thread tạo ra nó)."""

    def __init__(self):
        self._sct = None
        self._prev = None
        self._prev_raw = None

    def configure(self, region, preset):
        p = PRESETS[preset]
        self.region = {k: region[k] for k in ("left", "top", "width", "height")}
        w, h = region["width"], region["height"]
        self.scale = next((s for s in SCALES if w * s <= p["maxw"]), SCALES[-1])
        self.size = (ceil(w * self.scale), ceil(h * self.scale))
        self.quality, self.subsampling, self.fps = p["quality"], p["subsampling"], p["fps"]
        q = self.scale.denominator
        self._band, self._align = 16 * q, 8 * q
        self._prev = self._prev_raw = None
        return self.size

    def grab(self, force, gen):
        """Trả về gói cập nhật, hoặc None nếu màn hình không đổi."""
        if self._sct is None:
            self._sct = mss.MSS()
        shot = self._sct.grab(self.region)
        raw = shot.raw
        if not force and self._prev_raw is not None and raw == self._prev_raw:
            return None
        w, h = shot.size
        cur = np.frombuffer(raw, np.uint32).reshape(h, w)
        rects = [(0, 0, w, h)] if force or self._prev is None else self._dirty(cur, self._prev)
        self._prev, self._prev_raw = cur, raw
        return self._encode(cur, rects, gen) if rects else None

    def _dirty(self, cur, prev):
        h, w = cur.shape
        band, align = self._band, self._align
        nbands = -(-h // band)
        changed = cur != prev
        if nbands * band != h:
            changed = np.vstack([changed, np.zeros((nbands * band - h, w), bool)])
        cols = changed.reshape(nbands, band, w).any(axis=1)
        rects = []
        for b in np.flatnonzero(cols.any(axis=1)):
            xs = np.flatnonzero(cols[b])
            x0 = int(xs[0]) // align * align
            x1 = min(w, -(-(int(xs[-1]) + 1) // align) * align)
            y0, y1 = int(b) * band, min(h, (int(b) + 1) * band)
            if rects and rects[-1][3] == y0:  # nối với dải ngay phía trên
                px0, py0, px1, _ = rects[-1]
                rects[-1] = (min(px0, x0), py0, max(px1, x1), y1)
            else:
                rects.append((x0, y0, x1, y1))
        if sum((x1 - x0) * (y1 - y0) for x0, y0, x1, y1 in rects) > 0.6 * w * h:
            return [(0, 0, w, h)]
        return rects

    def _encode(self, cur, rects, gen):
        s = self.scale
        out_w, out_h = self.size
        h, w = cur.shape
        parts = []
        for x0, y0, x1, y1 in rects:
            X0, Y0 = int(x0 * s), int(y0 * s)
            X1 = out_w if x1 == w else int(x1 * s)
            Y1 = out_h if y1 == h else int(y1 * s)
            block = np.ascontiguousarray(cur[y0:y1, x0:x1])
            img = Image.frombuffer("RGB", (x1 - x0, y1 - y0), block, "raw", "BGRX", 0, 1)
            if s != 1:
                if s.numerator == 1:
                    img = img.reduce(s.denominator)
                else:
                    img = img.resize((X1 - X0, Y1 - Y0), Image.BOX)
            buf = io.BytesIO()
            img.save(buf, "JPEG", quality=self.quality, subsampling=self.subsampling)
            data = buf.getvalue()
            parts.append(struct.pack("<HHHHI", X0, Y0, img.width, img.height, len(data)) + data)
        return struct.pack("<HH", gen & 0xFFFF, len(parts)) + b"".join(parts)

    def close(self):
        if self._sct is not None:
            self._sct.close()
            self._sct = None
