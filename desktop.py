"""Điều khiển chuột, bàn phím (qua XTest) và liệt kê màn hình của phiên X11 đang chạy."""

import time

from Xlib import X, XK, display
from Xlib.ext import xtest

XK.load_keysym_group("xf86")
XK.load_keysym_group("xkb")  # ISO_Level3_Shift (AltGr)

MODIFIERS = {"ctrl": "Control_L", "shift": "Shift_L", "alt": "Alt_L", "super": "Super_L"}
CHAR_KEYS = {"\n": "Return", "\r": "Return", "\t": "Tab"}


def char_keysym(ch):
    if ch in CHAR_KEYS:
        return XK.string_to_keysym(CHAR_KEYS[ch])
    code = ord(ch)
    if 0x20 <= code <= 0x7E or 0xA0 <= code <= 0xFF:  # keysym Latin-1 trùng với mã Unicode
        return code
    return 0x01000000 | code


class Desktop:
    """python-xlib không an toàn đa luồng: mọi lời gọi phải đi qua cùng một thread."""

    def __init__(self):
        self.d = display.Display()
        self.root = self.d.screen().root
        lo, hi = self.d.display.info.min_keycode, self.d.display.info.max_keycode
        mapping = self.d.get_keyboard_mapping(lo, hi - lo + 1)
        # Keycode chưa gán ký tự nào: mượn tạm để gõ ký tự không có trên bàn phím (ví dụ "ệ").
        self._spare = [lo + i for i, syms in enumerate(mapping) if not any(syms) and lo + i > 8]
        self._borrowed = {}  # keysym -> keycode, cũ nhất đứng đầu
        self._shift = self._keycode(XK.XK_Shift_L)[0]

    # ---------- màn hình ----------

    def monitors(self):
        try:
            found = self.root.xrandr_get_monitors(is_active=True).monitors
            mons = [
                {
                    "name": self.d.get_atom_name(m.name),
                    "left": m.x,
                    "top": m.y,
                    "width": m.width_in_pixels,
                    "height": m.height_in_pixels,
                    "primary": bool(m.primary),
                }
                for m in found
            ]
        except Exception:
            mons = []
        if not mons:
            g = self.root.get_geometry()
            mons = [{"name": "screen", "left": 0, "top": 0, "width": g.width, "height": g.height, "primary": True}]
        return mons

    def pointer(self):
        p = self.root.query_pointer()
        return p.root_x, p.root_y

    # ---------- chuột ----------

    def move(self, x, y):
        xtest.fake_input(self.d, X.MotionNotify, x=int(x), y=int(y))
        self.d.flush()

    def move_by(self, dx, dy, region):
        """Di chuyển tương đối nhưng giữ con trỏ trong màn hình đang xem."""
        x, y = self.pointer()
        left, top = region["left"], region["top"]
        self.move(
            min(max(x + dx, left), left + region["width"] - 1),
            min(max(y + dy, top), top + region["height"] - 1),
        )

    def button(self, button, down):
        xtest.fake_input(self.d, X.ButtonPress if down else X.ButtonRelease, button)
        self.d.flush()

    def click(self, button, count=1):
        for _ in range(count):
            self.button(button, True)
            self.button(button, False)

    def scroll(self, dx, dy):
        # Nút 4/5: cuộn lên/xuống, 6/7: cuộn trái/phải.
        for button, steps in ((5 if dy > 0 else 4, abs(dy)), (7 if dx > 0 else 6, abs(dx))):
            for _ in range(steps):
                self.button(button, True)
                self.button(button, False)

    # ---------- bàn phím ----------

    def _keysym(self, name):
        if len(name) == 1:
            return char_keysym(name)
        return XK.string_to_keysym(name)

    def _keycode(self, keysym):
        """Trả về (keycode, có cần Shift không); mượn keycode trống nếu bàn phím không có keysym này."""
        for code, index in sorted(self.d.keysym_to_keycodes(keysym), key=lambda ci: ci[1]):
            if index in (0, 1):  # nhóm bàn phím đầu tiên, thường hoặc có Shift
                return code, index == 1
        code = self._borrowed.pop(keysym, None)
        if code is None:
            if not self._spare:
                return None, False
            if len(self._borrowed) < len(self._spare):
                used = set(self._borrowed.values())
                code = next(c for c in self._spare if c not in used)
            else:
                code = self._borrowed.pop(next(iter(self._borrowed)))
            self.d.change_keyboard_mapping(code, [(keysym, keysym)])
            self.d.sync()
            time.sleep(0.03)  # cho các ứng dụng kịp cập nhật bảng phím trước khi phím tới
        self._borrowed[keysym] = code
        return code, False

    def _press(self, code, down):
        xtest.fake_input(self.d, X.KeyPress if down else X.KeyRelease, code)

    def key(self, name, mods=(), repeat=1):
        keysym = self._keysym(name)
        if not keysym:
            return
        code, shift = self._keycode(keysym)
        if code is None:
            return
        held = [self._keycode(XK.string_to_keysym(MODIFIERS[m]))[0] for m in mods]
        if shift and self._shift not in held:
            held.append(self._shift)
        for c in held:
            self._press(c, True)
        for _ in range(repeat):
            self._press(code, True)
            self._press(code, False)
        for c in reversed(held):
            self._press(c, False)
        self.d.flush()

    def key_state(self, name, down):
        keysym = self._keysym(name)
        code = self._keycode(keysym)[0] if keysym else None
        if code:
            self._press(code, down)
            self.d.flush()

    def type_text(self, text):
        for ch in text:
            code, shift = self._keycode(char_keysym(ch))
            if code is None:
                continue
            if shift:
                self._press(self._shift, True)
            self._press(code, True)
            self._press(code, False)
            if shift:
                self._press(self._shift, False)
            self.d.flush()
            time.sleep(0.002)

    def restore_keymap(self):
        for code in self._borrowed.values():
            self.d.change_keyboard_mapping(code, [(X.NoSymbol, X.NoSymbol)])
        self._borrowed.clear()
        self.d.sync()
