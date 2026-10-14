'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const now = () => performance.now();
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const buzz = (ms) => { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (_) { /* không hỗ trợ */ } };

  // ---------- cài đặt lưu trên điện thoại ----------

  const store = {
    get(k, d) { try { const v = localStorage.getItem('wfb.' + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem('wfb.' + k, JSON.stringify(v)); } catch (_) { /* chế độ ẩn danh */ } },
  };
  // iPadOS báo mình là "Macintosh", nhận ra nhờ màn hình cảm ứng.
  const isApple = /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  const S = {
    mode: store.get('mode', 'touchpad'), // 'touchpad' | 'touch'
    sens: store.get('sens', 1.6),
    natural: store.get('natural', true),
    cmdCtrl: store.get('cmdCtrl', isApple), // phím ⌘ Command gửi sang laptop thành Ctrl
    audioQ: store.get('audioQ', 'hi'), // âm thanh: 'hi' stereo 48 kHz, 'lo' mono 24 kHz
    muteLaptop: store.get('muteLaptop', true), // nghe trên điện thoại thì tắt tiếng loa laptop
    preset: store.get('preset', 'mid'),
    mon: store.get('mon', null),
  };
  const save = (k, v) => { S[k] = v; store.set(k, v); };

  const shell = $('#shell'), viewport = $('#viewport'), stage = $('#stage'), canvas = $('#screen');
  const ctx = canvas.getContext('2d');
  const cursorEl = $('#cursor'), kbd = $('#kbd');

  // ---------- kết nối ----------

  const qs = new URLSearchParams(location.search);
  if (qs.get('k')) {
    store.set('token', qs.get('k'));
    history.replaceState(null, '', location.pathname); // không để mã nằm trên thanh địa chỉ
  }
  let token = store.get('token', '');
  let ws = null, retries = 0, retryTimer = 0, everConnected = false, paused = false;
  let gen = -1, screenW = 0, screenH = 0, nativeW = 1, nativeH = 1, monitors = [], curMon = null;
  let rtt = 0;

  function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

  function connect() {
    clearTimeout(retryTimer);
    paused = false;
    if (!token) { showLogin(); return; }
    if (ws) return;
    setStatus(everConnected ? 'Đang kết nối lại…' : 'Đang kết nối tới laptop…');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new WebSocket(`${proto}://${location.host}/ws?k=${encodeURIComponent(token)}`);
    sock.binaryType = 'arraybuffer';
    ws = sock;
    sock.onopen = () => { retries = 0; send({ t: 'cfg', preset: S.preset, mon: S.mon }); };
    sock.onmessage = onMessage;
    sock.onclose = (e) => {
      if (ws !== sock) return;
      ws = null;
      frames.length = 0;
      if ([4001, 4002, 4004].includes(e.code)) stopAudio(false);
      if (e.code === 4001 || e.code === 4004) {
        token = '';
        store.set('token', '');
        showLogin(e.code === 4004
          ? 'Mã kết nối vừa được đổi trên laptop. Quét mã QR mới trong bảng điều khiển Work From Bed.'
          : 'Mã kết nối không đúng. Xem lại mã trong bảng điều khiển Work From Bed trên laptop.');
        return;
      }
      if (e.code === 4002) { // bị ngắt từ bảng điều khiển: không tự kết nối lại
        paused = true;
        setStatus('Laptop đã ngắt kết nối với điện thoại này.', 'Kết nối lại');
        return;
      }
      if (e.code === 4003) {
        setStatus('Nhập sai mã quá nhiều lần. Đợi vài phút rồi thử lại.');
        retryTimer = setTimeout(connect, 60000);
        return;
      }
      const wait = Math.min(10, 1 + retries++);
      setStatus(`Mất kết nối tới laptop. Thử lại sau ${wait} giây…`);
      retryTimer = setTimeout(connect, wait * 1000);
    };
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !ws && token && !paused) connect(); });

  function onMessage(e) {
    if (typeof e.data !== 'string') { frames.push(e.data); pump(); return; }
    const m = JSON.parse(e.data);
    if (m.t === 'screen') {
      const centre = viewCentre();
      gen = m.gen; screenW = m.w; screenH = m.h; nativeW = m.nw; nativeH = m.nh;
      monitors = m.mons; curMon = m.mon; S.preset = m.preset;
      canvas.width = screenW; canvas.height = screenH;
      canvas.style.width = screenW + 'px'; canvas.style.height = screenH + 'px';
      everConnected = true;
      setStatus(null);
      if (!store.get('helpSeen', false)) { store.set('helpSeen', true); openSheet('help'); }
      layout(centre);
      renderSettings();
    } else if (m.t === 'cur') {
      if (now() - lastLocalMove > 400) { cur.x = m.x; cur.y = m.y; placeCursor(); }
    } else if (m.t === 'pong') {
      rtt = Math.round(now() - m.ts);
    } else if (m.t === 'toast') {
      toast(m.s);
    }
  }

  // ---------- vẽ hình nhận được ----------

  const frames = [];
  const stats = { frames: 0, bytes: 0 };
  let drawing = false;

  const decode = window.createImageBitmap
    ? (blob) => createImageBitmap(blob)
    : (blob) => new Promise((ok, fail) => {
      const img = new Image(), url = URL.createObjectURL(blob);
      img.onload = () => { URL.revokeObjectURL(url); ok(img); };
      img.onerror = fail;
      img.src = url;
    });

  async function pump() {
    if (drawing) return;
    drawing = true;
    while (frames.length) {
      const buf = frames.shift();
      try { await drawFrame(buf); } catch (err) { console.warn('Lỗi vẽ khung hình', err); }
      send({ t: 'ack' }); // server chỉ gửi khung tiếp theo sau khi nhận ack, nên hình không bị dồn trễ
    }
    drawing = false;
  }

  async function drawFrame(buf) {
    const dv = new DataView(buf);
    const g = dv.getUint16(0, true), n = dv.getUint16(2, true);
    if (g !== gen) return;
    const parts = [];
    let off = 4;
    for (let i = 0; i < n; i++) {
      const x = dv.getUint16(off, true), y = dv.getUint16(off + 2, true), len = dv.getUint32(off + 8, true);
      off += 12;
      parts.push({ x, y, blob: new Blob([new Uint8Array(buf, off, len)], { type: 'image/jpeg' }) });
      off += len;
    }
    const imgs = await Promise.all(parts.map((p) => decode(p.blob)));
    if (g === gen) imgs.forEach((img, i) => ctx.drawImage(img, parts[i].x, parts[i].y));
    imgs.forEach((img) => { if (img.close) img.close(); });
    stats.frames++;
    stats.bytes += buf.byteLength;
  }

  // ---------- khung nhìn: vừa khung, phóng to, kéo ----------

  const view = { zoom: 1, x: 0, y: 0, fit: 1 }; // điểm trên màn = (x, y) + điểm trên ảnh * fit * zoom
  let vw = 0, vh = 0, vleft = 0, vtop = 0;
  let rotateMode = 'off'; // 'off' | 'lock': khoá hướng ngang thật (Android) | 'css': xoay giao diện 90° (iPhone)
  let toLocal = new DOMMatrix(); // đổi toạ độ chạm trên màn điện thoại sang toạ độ trong #shell
  const scale = () => view.fit * view.zoom;

  function viewCentre() { // điểm ảnh đang nằm giữa khung nhìn, tính theo tỉ lệ 0..1
    if (!screenW || !vw) return { u: 0.5, v: 0.5 };
    const s = scale();
    return { u: (vw / 2 - view.x) / s / screenW, v: (vh / 2 - view.y) / s / screenH };
  }

  function layout(centre) {
    const c = centre || viewCentre(); // giữ nguyên chỗ đang nhìn khi xoay máy hoặc bật bàn phím
    // Bàn phím điện thoại chỉ thu nhỏ visual viewport, nên ứng dụng tự co theo nó.
    const vv = window.visualViewport;
    const W = vv ? vv.width : window.innerWidth, H = vv ? vv.height : window.innerHeight;
    const ox = vv ? vv.offsetLeft : 0, oy = vv ? vv.offsetTop : 0;
    const el = document.activeElement;
    if (!el || !/^(INPUT|TEXTAREA)$/.test(el.tagName)) fullHeight = H;
    // Xoay bằng CSS chỉ khi máy đang dựng dọc; tạm thôi xoay lúc bàn phím mở vì bàn phím vẫn nằm dọc.
    const turn = rotateMode === 'css' && H > W && !keyboardShown();
    const w = turn ? H : W, h = turn ? W : H;
    shell.style.width = w + 'px';
    shell.style.height = h + 'px';
    shell.style.transform = turn ? `translate(${ox + W}px, ${oy}px) rotate(90deg)` : `translate(${ox}px, ${oy}px)`;
    shell.classList.toggle('land', w > h);
    shell.classList.toggle('short', w > h && h < 360);
    toLocal = new DOMMatrix(getComputedStyle(shell).transform).inverse();
    let x = 0, y = 0;
    for (let n = viewport; n && n !== shell; n = n.offsetParent) { x += n.offsetLeft; y += n.offsetTop; }
    vleft = x; vtop = y; vw = viewport.clientWidth; vh = viewport.clientHeight;
    $('#b-kbd').classList.toggle('active', keyboardShown());
    $('#b-rotate').classList.toggle('active', rotateMode !== 'off');
    if (!screenW) return;
    view.fit = Math.min(vw / screenW, vh / screenH);
    view.x = vw / 2 - c.u * screenW * scale();
    view.y = vh / 2 - c.v * screenH * scale();
    clampView();
    applyView();
  }

  function clampView() {
    const s = scale(), cw = screenW * s, ch = screenH * s;
    view.x = cw <= vw ? (vw - cw) / 2 : clamp(view.x, vw - cw, 0);
    view.y = ch <= vh ? (vh - ch) / 2 : clamp(view.y, vh - ch, 0);
  }

  function applyView() {
    stage.style.transform = `translate3d(${view.x}px, ${view.y}px, 0) scale(${scale()})`;
    placeCursor();
    const z = view.zoom;
    $('#zoom-level').textContent = (z < 1.05 ? '1' : z.toFixed(1)) + '×';
    $('#zoom-out').disabled = z <= 1.001;
    $('#zoom-in').disabled = z >= ZOOM_MAX - 0.001;
  }

  // Nút − / +: Touchpad giữ con trỏ đứng yên khi phóng; Chạm trực tiếp giữ tâm khung nhìn.
  const ZOOM_MAX = 8, ZOOM_STEP = 1.5;
  let animTimer = 0;
  function zoomTo(z) {
    if (!screenW) return;
    const c = cursorPos();
    const onScreen = cursorEl.style.visibility !== 'hidden' && c.x >= 0 && c.y >= 0 && c.x <= vw && c.y <= vh;
    const a = S.mode === 'touchpad' && onScreen ? c : { x: vw / 2, y: vh / 2 };
    const s0 = scale(), px = (a.x - view.x) / s0, py = (a.y - view.y) / s0;
    view.zoom = clamp(z, 1, ZOOM_MAX);
    view.x = a.x - px * scale();
    view.y = a.y - py * scale();
    clampView();
    stage.classList.add('anim');
    cursorEl.classList.add('anim');
    applyView();
    clearTimeout(animTimer);
    animTimer = setTimeout(() => { stage.classList.remove('anim'); cursorEl.classList.remove('anim'); }, 220);
  }
  $('#zoom-in').addEventListener('click', () => zoomTo(view.zoom * ZOOM_STEP));
  $('#zoom-out').addEventListener('click', () => zoomTo(view.zoom / ZOOM_STEP));
  $('#zoom-level').addEventListener('click', () => zoomTo(1));

  // ---------- con trỏ ----------

  const cur = { x: -1, y: -1 }; // toạ độ trên màn hình laptop đang xem (pixel thật)
  let lastLocalMove = -1e9;

  function cursorPos() {
    const s = scale();
    return { x: view.x + (cur.x / nativeW) * screenW * s, y: view.y + (cur.y / nativeH) * screenH * s };
  }

  function placeCursor() {
    const inside = screenW && cur.x >= 0 && cur.y >= 0 && cur.x < nativeW && cur.y < nativeH;
    cursorEl.style.visibility = inside ? 'visible' : 'hidden';
    const c = cursorPos();
    cursorEl.style.transform = `translate3d(${c.x - 1}px, ${c.y - 1}px, 0)`;
  }

  function follow() { // khi đang phóng to, kéo khung nhìn theo con trỏ
    if (view.zoom <= 1.01) return;
    const c = cursorPos(), m = Math.min(vw, vh) * 0.15;
    let dx = 0, dy = 0;
    if (c.x < m) dx = m - c.x; else if (c.x > vw - m) dx = vw - m - c.x;
    if (c.y < m) dy = m - c.y; else if (c.y > vh - m) dy = vh - m - c.y;
    if (dx || dy) { view.x += dx; view.y += dy; clampView(); applyView(); }
  }

  // ---------- thao tác chuột ----------

  const relAcc = { x: 0, y: 0 };

  function relMove(dx, dy) {
    relAcc.x += dx; relAcc.y += dy;
    const ix = Math.trunc(relAcc.x), iy = Math.trunc(relAcc.y);
    if (!ix && !iy) return;
    relAcc.x -= ix; relAcc.y -= iy;
    send({ t: 'rel', dx: ix, dy: iy });
    cur.x = clamp(cur.x + ix, 0, nativeW - 1);
    cur.y = clamp(cur.y + iy, 0, nativeH - 1);
    lastLocalMove = now();
    placeCursor();
    follow();
  }

  function absMove(p) {
    const s = scale();
    const nx = clamp((p.x - view.x) / s / screenW, 0, 1), ny = clamp((p.y - view.y) / s / screenH, 0, 1);
    send({ t: 'move', x: nx, y: ny });
    cur.x = nx * (nativeW - 1);
    cur.y = ny * (nativeH - 1);
    lastLocalMove = now();
    placeCursor();
  }

  function click(b, n = 1) { send({ t: 'click', b, n }); releaseMods(); }
  function mouseButton(b, down) { send({ t: 'btn', b, down }); if (!down) releaseMods(); }

  // ---------- cử chỉ trên màn hình ----------

  const TAP_MS = 220, SLOP = 9, LONG_MS = 550, SCROLL_STEP = 24;
  const ptrs = new Map();
  let g = null; // cử chỉ đang diễn ra
  let pendingTap = 0, lastTap = { t: -1e9, x: 0, y: 0 };
  let fling = 0;

  const pt = (e) => {
    const p = toLocal.transformPoint(new DOMPoint(e.clientX, e.clientY));
    return { x: p.x - vleft, y: p.y - vtop };
  };

  viewport.addEventListener('pointerdown', (e) => {
    e.preventDefault(); // không cướp focus của ô gõ phím, bàn phím điện thoại vẫn mở
    stopFling();
    try { viewport.setPointerCapture(e.pointerId); } catch (_) { /* con trỏ đã mất */ }
    const p = pt(e);
    ptrs.set(e.pointerId, { x: p.x, y: p.y, sx: p.x, sy: p.y });
    if (ptrs.size === 1) startOne(p);
    else if (ptrs.size === 2) startTwo();
    else if (ptrs.size === 3) startThree();
  });

  viewport.addEventListener('pointermove', (e) => {
    const q = ptrs.get(e.pointerId);
    if (!q) return;
    const p = pt(e);
    q.x = p.x; q.y = p.y;
    if (!g) return;
    if (g.type === 'one') moveOne(p);
    else if (g.type === 'two') moveTwo();
    else if (g.type === 'three' && dist(q, { x: q.sx, y: q.sy }) > SLOP) g.moved = true;
  });

  function onUp(e) {
    const q = ptrs.get(e.pointerId);
    if (!q) return;
    ptrs.delete(e.pointerId);
    const cancelled = e.type === 'pointercancel';
    if (g) {
      if (g.type === 'one') endOne(q, cancelled);
      else if (g.type === 'two' && ptrs.size < 2) endTwo(cancelled);
      else if (g.type === 'three' && ptrs.size < 3) endThree(cancelled);
    }
    if (!ptrs.size) g = null;
  }
  viewport.addEventListener('pointerup', onUp);
  viewport.addEventListener('pointercancel', onUp);
  viewport.addEventListener('contextmenu', (e) => e.preventDefault());
  // Không cho trình duyệt tự xử lý cú vuốt: Chrome coi vuốt nhanh là "cuộn quán tính" và nuốt
  // cú chạm kế tiếp lên các nút (để dừng quán tính), khiến nút không ăn ngay sau khi rê chuột.
  ['touchstart', 'touchmove'].forEach((ev) => viewport.addEventListener(ev, (e) => e.preventDefault(), { passive: false }));

  function flushTap() {
    if (!pendingTap) return;
    clearTimeout(pendingTap);
    pendingTap = 0;
    click(1);
  }

  function startOne(p) {
    const t = now();
    g = { type: 'one', t0: t, x0: p.x, y0: p.y, lx: p.x, ly: p.y, lt: t, moved: false, drag: false, second: false, timer: 0 };
    if (S.mode === 'touchpad') {
      // Chạm lần hai ngay sau một cú chạm: nhấc lên là nhấp đúp, kéo đi là kéo thả.
      if (pendingTap && dist(p, lastTap) < 70) {
        clearTimeout(pendingTap);
        pendingTap = 0;
        g.second = true;
      } else {
        flushTap();
      }
    } else {
      // Chạm lần hai gần chỗ cũ thì giữ con trỏ đứng yên để laptop nhận ra nhấp đúp.
      if (!(t - lastTap.t < 400 && dist(p, lastTap) < 30)) absMove(p);
      g.timer = setTimeout(() => {
        if (g && g.type === 'one' && !g.moved) { click(3); buzz(25); g.type = 'done'; }
      }, LONG_MS);
    }
  }

  function moveOne(p) {
    const t = now(), dx = p.x - g.lx, dy = p.y - g.ly, dt = Math.max(8, t - g.lt);
    g.lx = p.x; g.ly = p.y; g.lt = t;
    if (!g.moved && Math.hypot(p.x - g.x0, p.y - g.y0) > SLOP) {
      g.moved = true;
      clearTimeout(g.timer);
      if (S.mode === 'touch' || g.second) { mouseButton(1, true); g.drag = true; buzz(10); }
    }
    if (S.mode === 'touchpad') {
      // Gia tốc: rê chậm thì chính xác, vuốt nhanh thì đi xa.
      const speed = Math.hypot(dx, dy) / dt;
      const gain = (S.sens * (0.6 + Math.min(speed, 3) * 0.9) * nativeW) / (scale() * screenW);
      relMove(dx * gain, dy * gain);
    } else if (g.moved) {
      absMove(p);
    }
  }

  function endOne(q, cancelled) {
    clearTimeout(g.timer);
    const t = now();
    if (g.drag) {
      mouseButton(1, false);
    } else if (!cancelled && !g.moved) {
      if (S.mode === 'touchpad') {
        if (t - g.t0 < 300) {
          if (g.second) {
            click(1, 2);
          } else {
            lastTap = { t, x: q.x, y: q.y };
            pendingTap = setTimeout(() => { pendingTap = 0; click(1); }, TAP_MS);
          }
        }
      } else if (t - g.t0 < LONG_MS) {
        click(1);
        lastTap = { t, x: q.x, y: q.y };
      }
    }
    g.type = 'done';
  }

  function startTwo() {
    if (g && g.type === 'one') {
      clearTimeout(g.timer);
      if (g.drag) mouseButton(1, false);
    }
    flushTap();
    const [a, b] = [...ptrs.values()];
    const c = mid(a, b), t = now();
    g = {
      type: 'two', t0: t, lt: t, d0: Math.max(1, dist(a, b)), c0: c, lc: c, mode: null, axis: null,
      zoom0: view.zoom, x0: view.x, y0: view.y, ax: 0, ay: 0, vx: 0, vy: 0, first: { x: a.sx, y: a.sy }, scrolled: false,
    };
  }

  function moveTwo() {
    const [a, b] = [...ptrs.values()];
    const d = dist(a, b), c = mid(a, b);
    if (!g.mode) {
      if (Math.abs(d - g.d0) > 30) {
        g.mode = 'pinch';
      } else if (dist(c, g.c0) > 14) {
        g.mode = 'drag';
        g.axis = Math.abs(c.x - g.c0.x) > Math.abs(c.y - g.c0.y) * 1.5 ? 'x' : 'y';
      } else {
        return;
      }
    }
    if (g.mode === 'pinch') {
      const z = clamp((g.zoom0 * d) / g.d0, 1, 8);
      const s0 = view.fit * g.zoom0, s1 = view.fit * z;
      const sx = (g.c0.x - g.x0) / s0, sy = (g.c0.y - g.y0) / s0; // điểm ảnh nằm dưới hai ngón lúc bắt đầu
      view.zoom = z;
      view.x = c.x - sx * s1;
      view.y = c.y - sy * s1;
      clampView();
      applyView();
      return;
    }
    const t = now(), dt = Math.max(8, t - g.lt);
    const dx = c.x - g.lc.x, dy = c.y - g.lc.y;
    g.lc = c; g.lt = t;
    g.vx = g.vx * 0.6 + (dx / dt) * 0.4;
    g.vy = g.vy * 0.6 + (dy / dt) * 0.4;
    if (panOrScroll(dx, dy, g, g.axis, true)) g.scrolled = true;
  }

  // Kéo hai ngón: đang phóng to thì di chuyển khung nhìn trước; phần kéo vượt mép màn hình laptop
  // (hoặc khi đang vừa khung) thì cuộn trang trên laptop, giống trang web phóng to trên điện thoại.
  function panOrScroll(dx, dy, acc, axis, allowScroll) {
    const x0 = view.x, y0 = view.y;
    if (view.zoom > 1.01) {
      view.x += dx;
      view.y += dy;
      clampView();
      if (view.x !== x0 || view.y !== y0) applyView();
    }
    if (!allowScroll) return false;
    acc.ax += axis === 'x' ? dx - (view.x - x0) : 0;
    acc.ay += axis === 'y' ? dy - (view.y - y0) : 0;
    return scrollSteps(acc);
  }

  function scrollSteps(acc) {
    const nx = Math.trunc(acc.ax / SCROLL_STEP), ny = Math.trunc(acc.ay / SCROLL_STEP);
    if (!nx && !ny) return false;
    acc.ax -= nx * SCROLL_STEP;
    acc.ay -= ny * SCROLL_STEP;
    const sign = S.natural ? -1 : 1;
    send({ t: 'scroll', dx: sign * nx, dy: sign * ny });
    return true;
  }

  function endTwo(cancelled) {
    if (!cancelled && !g.mode && now() - g.t0 < 350) {
      if (S.mode === 'touch') absMove(g.first);
      click(3);
      buzz(15);
    } else if (!cancelled && g.mode === 'drag' && now() - g.lt < 60) {
      // Vuốt để di chuyển khung nhìn thì quán tính cũng chỉ di chuyển khung nhìn, không cuộn trang.
      startFling(g.vx, g.vy, g.axis, g.scrolled || view.zoom <= 1.01);
    }
    g = { type: 'done' };
  }

  // Quán tính sau khi vuốt nhanh hai ngón, như trên điện thoại.
  function startFling(vx, vy, axis, allowScroll) {
    if (Math.hypot(vx, vy) < 0.4) return;
    const acc = { ax: 0, ay: 0 };
    let last = now();
    const tick = () => {
      const t = now(), dt = t - last;
      last = t;
      panOrScroll(vx * dt, vy * dt, acc, axis, allowScroll);
      const decay = Math.pow(0.996, dt);
      vx *= decay; vy *= decay;
      fling = Math.hypot(vx, vy) > 0.06 ? requestAnimationFrame(tick) : 0;
    };
    fling = requestAnimationFrame(tick);
  }
  function stopFling() { if (fling) cancelAnimationFrame(fling); fling = 0; }

  function startThree() {
    flushTap();
    g = { type: 'three', t0: now(), moved: !!(g && g.mode) };
  }

  function endThree(cancelled) {
    if (!cancelled && !g.moved && now() - g.t0 < 400) click(2);
    g = { type: 'done' };
  }

  // Lăn chuột khi mở bằng trình duyệt máy tính (tiện để thử).
  let wheelAcc = 0;
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    wheelAcc += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    const n = Math.trunc(wheelAcc / 100);
    if (n) { wheelAcc -= n * 100; send({ t: 'scroll', dx: 0, dy: n }); }
  }, { passive: false });

  // ---------- phím bổ trợ dính (Ctrl, Alt, Shift, Super) ----------

  const MOD_KEYS = { ctrl: 'Control_L', alt: 'Alt_L', shift: 'Shift_L', super: 'Super_L' };
  const modState = { ctrl: 0, alt: 0, shift: 0, super: 0 }; // 0 nhả, 1 giữ cho phím kế tiếp, 2 khoá
  const modTapAt = {};

  function setMod(m, state) {
    const was = modState[m];
    modState[m] = state;
    if (!was && state) send({ t: 'keydown', k: MOD_KEYS[m] });
    if (was && !state) send({ t: 'keyup', k: MOD_KEYS[m] });
    $$(`[data-mod="${m}"]`).forEach((b) => {
      b.classList.toggle('on', state > 0);
      b.classList.toggle('lock', state === 2);
    });
  }

  function tapMod(m) {
    const t = now(), s = modState[m];
    if (s === 1 && t - (modTapAt[m] || 0) < 350) setMod(m, 2);
    else setMod(m, s ? 0 : 1);
    modTapAt[m] = t;
  }

  const anyMod = () => Object.values(modState).some(Boolean);
  function releaseMods() { for (const m in modState) if (modState[m] === 1) setMod(m, 0); }
  function sendKey(k, mods = [], n = 1) { send({ t: 'key', k, mods, n }); releaseMods(); }

  let altTabTimer = 0;
  function altTab() { // giữ Alt trong lúc chạm liên tiếp, nhả khi ngừng chạm một lúc
    if (!altTabTimer && !modState.alt) send({ t: 'keydown', k: 'Alt_L' });
    clearTimeout(altTabTimer);
    send({ t: 'key', k: 'Tab' });
    altTabTimer = setTimeout(() => {
      altTabTimer = 0;
      if (!modState.alt) send({ t: 'keyup', k: 'Alt_L' });
    }, 1200);
  }

  // ---------- bàn phím điện thoại ----------
  // Ô nhập ẩn luôn bắt đầu bằng một dấu cách, sau đó là chữ vừa gõ. Mỗi lần nội dung đổi, so với bản
  // trước để biết cần xoá mấy ký tự và gõ thêm gì. Cách này chạy được cả với bộ gõ có gợi ý từ, tự sửa
  // chữ và gõ tiếng Việt (Telex/VNI) trên điện thoại. Dấu cách đầu giúp phím xoá luôn có tác dụng.

  const SENTINEL = ' ';
  let kVal = SENTINEL, kCaret = 1, composing = false;

  function resetKbd() {
    kbd.value = SENTINEL;
    try { kbd.setSelectionRange(1, 1); } catch (_) { /* chưa focus */ }
    kVal = SENTINEL;
    kCaret = 1;
  }
  resetKbd();

  const caretMove = (n) => { if (n) send({ t: 'key', k: n < 0 ? 'Left' : 'Right', n: Math.abs(n) }); };

  function syncKbd() {
    const v = kbd.value;
    if (v !== kVal) {
      let p = 0;
      const max = Math.min(v.length, kVal.length);
      while (p < max && v[p] === kVal[p]) p++;
      let s = 0;
      while (s < max - p && v[v.length - 1 - s] === kVal[kVal.length - 1 - s]) s++;
      const removed = kVal.length - p - s, added = v.slice(p, v.length - s);
      if (anyMod()) {
        // Đang giữ Ctrl/Alt…: phím gõ vào là phím tắt, không phải chữ.
        if (removed > 0) send({ t: 'key', k: 'BackSpace', n: removed });
        for (const ch of added) send({ t: 'key', k: ch === '\n' ? 'Return' : ch });
        releaseMods();
        resetKbd();
        return;
      }
      caretMove(kVal.length - s - kCaret);
      if (removed > 0) send({ t: 'key', k: 'BackSpace', n: removed });
      if (added) send({ t: 'text', s: added });
      kVal = v;
      kCaret = p + added.length;
    }
    const c = kbd.selectionStart;
    if (kbd.selectionEnd === c && c !== kCaret) { caretMove(c - kCaret); kCaret = c; }
    if (!composing && (c <= 0 || !v.startsWith(SENTINEL) || v.length > 60 || v.includes('\n'))) resetKbd();
  }

  kbd.addEventListener('compositionstart', () => { composing = true; });
  kbd.addEventListener('compositionend', () => { composing = false; syncKbd(); });
  kbd.addEventListener('input', syncKbd);

  // Vuốt phím cách trên Gboard / giữ phím cách trên iPhone để dời con trỏ.
  document.addEventListener('selectionchange', () => {
    if (document.activeElement !== kbd || composing || kbd.value !== kVal) return;
    const c = kbd.selectionStart;
    if (kbd.selectionEnd !== c || c === kCaret) return;
    caretMove(c - kCaret);
    kCaret = c;
    if (c <= 0) resetKbd();
  });

  // ---------- bàn phím rời (máy tính bảng, điện thoại gắn bàn phím) ----------
  // Khi không có ô nhập nào đang mở, phím trên bàn phím rời được gửi thẳng sang laptop theo vị trí phím,
  // như cắm bàn phím vào laptop (bộ gõ tiếng Việt trên laptop vẫn dùng được). Ctrl/Alt/Shift/⌘ được giữ
  // thật trên laptop trong lúc bạn giữ, nên giữ Alt rồi bấm Tab nhiều lần vẫn chuyển cửa sổ. Các phím
  // khác gửi kiểu bấm-nhả mỗi lần trình duyệt báo (kể cả khi giữ phím), nên không bao giờ bị kẹt phím.
  const HW_SPECIAL = {
    Enter: 'Return', Backspace: 'BackSpace', Tab: 'Tab', Escape: 'Escape', Delete: 'Delete', Insert: 'Insert',
    ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
    Home: 'Home', End: 'End', PageUp: 'Prior', PageDown: 'Next',
    CapsLock: 'Caps_Lock', NumLock: 'Num_Lock', ScrollLock: 'Scroll_Lock', Pause: 'Pause', PrintScreen: 'Print',
    ContextMenu: 'Menu', AudioVolumeUp: 'XF86_AudioRaiseVolume', AudioVolumeDown: 'XF86_AudioLowerVolume',
    AudioVolumeMute: 'XF86_AudioMute', MediaPlayPause: 'XF86_AudioPlay', MediaTrackNext: 'XF86_AudioNext',
    MediaTrackPrevious: 'XF86_AudioPrev', MediaStop: 'XF86_AudioStop',
    BrightnessUp: 'XF86_MonBrightnessUp', BrightnessDown: 'XF86_MonBrightnessDown',
  };
  const HW_CODES = {
    Space: 'space', Minus: 'minus', Equal: 'equal', BracketLeft: 'bracketleft', BracketRight: 'bracketright',
    Backslash: 'backslash', Semicolon: 'semicolon', Quote: 'apostrophe', Comma: 'comma', Period: 'period',
    Slash: 'slash', Backquote: 'grave', NumpadAdd: 'KP_Add', NumpadSubtract: 'KP_Subtract',
    NumpadMultiply: 'KP_Multiply', NumpadDivide: 'KP_Divide', NumpadDecimal: 'KP_Decimal', NumpadEnter: 'KP_Enter',
  };
  const hwHeld = new Map(); // phím bổ trợ đang giữ: e.code -> tên phím trên laptop
  let hwHinted = false;

  function hwModifier(e) {
    const right = e.code.endsWith('Right');
    if (e.key === 'Control') return right ? 'Control_R' : 'Control_L';
    if (e.key === 'Shift') return right ? 'Shift_R' : 'Shift_L';
    if (e.key === 'Alt') return right ? 'Alt_R' : 'Alt_L';
    if (e.key === 'AltGraph') return 'ISO_Level3_Shift';
    if (e.key === 'Meta' || e.key === 'OS') return S.cmdCtrl ? (right ? 'Control_R' : 'Control_L') : (right ? 'Super_R' : 'Super_L');
    return null;
  }

  function hwKey(e) {
    if (HW_SPECIAL[e.key]) return HW_SPECIAL[e.key];
    if (/^F\d{1,2}$/.test(e.key)) return e.key;
    // Theo vị trí phím (e.code), không theo ký tự: Shift đang được giữ thật trên laptop nên laptop tự
    // ra chữ hoa/ký hiệu; Option+F trên bàn phím Apple ra "ƒ" nhưng ý người dùng là Alt+F.
    let m;
    if ((m = /^Key([A-Z])$/.exec(e.code))) return m[1].toLowerCase();
    if ((m = /^(?:Digit|Numpad)(\d)$/.exec(e.code))) return m[1]; // số bên bàn phím số cũng gửi như số thường
    if (HW_CODES[e.code]) return HW_CODES[e.code];
    return e.key.length === 1 ? e.key : null; // phím lạ: gửi theo ký tự
  }

  function hwActive() {
    const el = document.activeElement;
    if (el && /^(INPUT|TEXTAREA)$/.test(el.tagName)) return false; // đang gõ vào ô nhập hoặc bàn phím ảo
    return ws && screenW && $('#login').hidden && $('#backdrop').hidden;
  }

  // Trạng thái Ctrl/Shift/Alt mà trình duyệt báo kèm mỗi phím là chuẩn. Nếu lỡ mất sự kiện bấm/nhả phím
  // bổ trợ (giữ Shift từ trước khi trang có focus…), bù thêm vào phím này hoặc nhả phím đang giữ thừa.
  const HW_MODS = { Shift_: 'shift', Control_: 'ctrl', Alt_: 'alt', Super_: 'super' };
  function hwSyncMods(e) {
    const want = {
      Shift_: e.shiftKey, Control_: e.ctrlKey || (S.cmdCtrl && e.metaKey), Alt_: e.altKey, Super_: !S.cmdCtrl && e.metaKey,
    };
    const extra = [];
    for (const prefix in want) {
      const held = [...hwHeld].filter(([, n]) => n.startsWith(prefix));
      if (want[prefix] && !held.length) extra.push(HW_MODS[prefix]);
      if (!want[prefix]) held.forEach(([code, n]) => { hwHeld.delete(code); send({ t: 'keyup', k: n }); });
    }
    // Chữ hoa mà không có Shift lẫn Caps Lock (bàn phím ảo của hệ điều hành, công cụ gõ hộ…)
    if (/^Key[A-Z]$/.test(e.code) && e.key.length === 1 && e.key !== e.key.toLowerCase()
      && !e.shiftKey && !(e.getModifierState && e.getModifierState('CapsLock'))) extra.push('shift');
    return extra;
  }

  function hwReleaseAll() {
    hwHeld.forEach((name) => send({ t: 'keyup', k: name }));
    hwHeld.clear();
  }

  document.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (!$('#backdrop').hidden && e.key === 'Escape') { e.preventDefault(); closeSheets(); return; }
    if (!hwActive()) return;
    const mod = hwModifier(e);
    const name = mod || hwKey(e);
    if (!name) return;
    e.preventDefault(); // chặn phím tắt của trình duyệt (Ctrl+S, Ctrl+F, F5…) khi trình duyệt cho phép
    if (mod) {
      if (!hwHeld.has(e.code)) { hwHeld.set(e.code, mod); send({ t: 'keydown', k: mod }); }
    } else {
      send({ t: 'key', k: name, mods: hwSyncMods(e) });
      releaseMods(); // phím bổ trợ "dính" trên dải Phím tắt chỉ áp dụng cho một phím
    }
    if (!hwHinted) { hwHinted = true; toast('Đã nhận bàn phím rời: phím bấm được gửi thẳng sang laptop.'); }
  });
  document.addEventListener('keyup', (e) => {
    const name = hwHeld.get(e.code);
    if (name) { hwHeld.delete(e.code); send({ t: 'keyup', k: name }); }
    if (name || (hwActive() && hwKey(e))) e.preventDefault(); // không để Space/Enter "bấm" nút đang được focus
  });
  // Chuyển ứng dụng (⌘+Tab trên iPad…) thì trang không nhận được lúc nhả phím: nhả hết cho chắc.
  window.addEventListener('blur', hwReleaseAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) hwReleaseAll(); });

  // Ô nhập ẩn (bàn phím ảo đang mở) mà gõ bằng bàn phím rời: phím mũi tên, F1–F12, tổ hợp Ctrl/Alt.
  const KEYMAP = {
    ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Escape: 'Escape', Tab: 'Tab',
    Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'Prior', PageDown: 'Next', Insert: 'Insert',
  };
  kbd.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    const name = KEYMAP[e.key] || (/^F\d{1,2}$/.test(e.key) ? e.key : '');
    const mods = [(e.ctrlKey || (e.metaKey && S.cmdCtrl)) && 'ctrl', e.altKey && 'alt', e.metaKey && !S.cmdCtrl && 'super']
      .filter(Boolean);
    if (!name && !(mods.length && e.key.length === 1)) return; // chữ, Enter, xoá: đi qua sự kiện input
    e.preventDefault();
    if (e.shiftKey) mods.push('shift');
    sendKey(name || e.key.toLowerCase(), mods);
  });

  let fullHeight = 0; // chiều cao trang lúc bàn phím điện thoại đang đóng
  function keyboardShown() {
    if (document.activeElement !== kbd) return false;
    const vv = window.visualViewport;
    return !fullHeight || (vv ? vv.height : window.innerHeight) < fullHeight * 0.85;
  }

  function toggleKeyboard() {
    if (keyboardShown()) { kbd.blur(); return; }
    kbd.blur(); // đã focus nhưng bàn phím bị tắt bằng nút Back: focus lại để hiện ra
    kbd.focus();
    resetKbd();
  }
  kbd.addEventListener('focus', () => $('#b-kbd').classList.add('active'));
  kbd.addEventListener('blur', () => $('#b-kbd').classList.remove('active'));

  // ---------- nút bấm ----------

  // Chặn mousedown để chạm nút không làm mất focus ô gõ phím (bàn phím điện thoại không bị đóng).
  $$('#bar button, #keys button, #ctrl button').forEach((b) => b.addEventListener('mousedown', (e) => e.preventDefault()));

  function bindPress(el, fire, repeat) {
    let timer = 0, repeated = false;
    el.addEventListener('pointerdown', () => {
      repeated = false;
      if (!repeat) return;
      timer = setTimeout(function again() { repeated = true; fire(); timer = setTimeout(again, 70); }, 450);
    });
    const stop = () => clearTimeout(timer);
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => el.addEventListener(ev, stop));
    el.addEventListener('click', () => { if (!repeated) fire(); repeated = false; });
  }

  $$('#keys [data-k]').forEach((b) => bindPress(b, () => sendKey(b.dataset.k), b.hasAttribute('data-rep')));
  $$('#keys [data-combo]').forEach((b) => {
    const parts = b.dataset.combo.split('+'), key = parts.pop();
    bindPress(b, () => sendKey(key, parts), b.hasAttribute('data-rep'));
  });
  $$('#keys [data-mod]').forEach((b) => b.addEventListener('click', () => tapMod(b.dataset.mod)));
  $('#keys [data-act="alttab"]').addEventListener('click', altTab);

  // Nút chuột trái/phải trên thanh công cụ: giữ nút + rê ngón khác trên màn hình để kéo thả.
  [['#b-left', 1], ['#b-right', 3]].forEach(([sel, button]) => {
    const el = $(sel);
    let down = false;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch (_) { /* bỏ qua */ }
      flushTap();
      down = true;
      el.classList.add('pressed');
      mouseButton(button, true);
      buzz(8);
    });
    const release = () => {
      if (!down) return;
      down = false;
      el.classList.remove('pressed');
      mouseButton(button, false);
    };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
  });

  $('#b-mode').addEventListener('click', () => {
    setMode(S.mode === 'touchpad' ? 'touch' : 'touchpad');
    toast(S.mode === 'touchpad' ? 'Chế độ Touchpad: rê ngón để di chuột' : 'Chế độ Chạm trực tiếp: chạm vào đâu, click vào đó');
  });
  $('#b-kbd').addEventListener('click', toggleKeyboard);
  $('#b-keys').addEventListener('click', () => {
    const keys = $('#keys');
    keys.hidden = !keys.hidden;
    $('#b-keys').classList.toggle('active', !keys.hidden);
    layout();
  });
  $('#b-menu').addEventListener('click', () => openSheet('sheet'));

  const fsEl = document.documentElement;
  const canFullscreen = !!(fsEl.requestFullscreen || fsEl.webkitRequestFullscreen);
  const inFullscreen = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
  $('#b-full').hidden = $('#full-title').hidden = !canFullscreen;
  $('#b-full').addEventListener('click', () => {
    const call = inFullscreen()
      ? (document.exitFullscreen || document.webkitExitFullscreen).call(document)
      : (fsEl.requestFullscreen || fsEl.webkitRequestFullscreen).call(fsEl, { navigationUI: 'hide' });
    Promise.resolve(call).catch(() => toast('Trình duyệt không cho bật toàn màn hình.'));
  });
  const onFullscreenChange = () => {
    $('#b-full span').textContent = inFullscreen() ? 'Thoát toàn màn hình' : 'Toàn màn hình';
    if (!inFullscreen() && rotateMode === 'lock') rotateMode = 'off'; // thoát toàn màn hình thì hết khoá hướng
    // Toàn màn hình: xin giữ cả tổ hợp trình duyệt hay dành riêng (Ctrl+W, Ctrl+T…) cho bàn phím rời.
    if (inFullscreen() && navigator.keyboard && navigator.keyboard.lock) navigator.keyboard.lock().catch(() => {});
    setTimeout(layout, 100);
  };
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  // Xoay ngang: Android vào toàn màn hình rồi khoá hướng ngang thật (bàn phím xoay theo).
  // iPhone không cho khoá hướng, nên xoay cả giao diện 90° bằng CSS, dùng được cả khi máy khoá xoay.
  $('#b-rotate').addEventListener('click', async () => {
    if (rotateMode !== 'off') {
      if (rotateMode === 'lock') { try { screen.orientation.unlock(); } catch (_) { /* không hỗ trợ */ } }
      rotateMode = 'off';
      layout();
      return;
    }
    let mode = 'css';
    try {
      if (!inFullscreen() && fsEl.requestFullscreen) await fsEl.requestFullscreen({ navigationUI: 'hide' });
      await screen.orientation.lock('landscape');
      mode = 'lock';
    } catch (_) { /* không khoá được hướng: dùng cách xoay giao diện */ }
    rotateMode = mode;
    layout();
    if (mode === 'css') toast('Xoay ngang điện thoại để xem.');
  });

  function setMode(mode) {
    save('mode', mode);
    const tp = mode === 'touchpad';
    $('#b-mode use').setAttribute('href', tp ? '#i-touchpad' : '#i-touch');
    $('#b-mode span').textContent = tp ? 'Touchpad' : 'Chạm';
    $('#b-left').hidden = $('#b-right').hidden = !tp;
    segSelect('#seg-mode', mode);
  }

  // ---------- bảng cài đặt ----------

  function openSheet(id) {
    closeSheets();
    if (id === 'sheet') renderSettings();
    $('#backdrop').hidden = false;
    $('#' + id).hidden = false;
  }
  function closeSheets() {
    $$('.sheet').forEach((s) => { s.hidden = true; });
    $('#backdrop').hidden = true;
  }
  $$('[data-close]').forEach((b) => b.addEventListener('click', closeSheets));
  $('#backdrop').addEventListener('click', closeSheets);
  $('#open-help').addEventListener('click', () => openSheet('help'));

  function segSelect(sel, value) {
    $$(sel + ' button').forEach((b) => b.classList.toggle('sel', b.dataset.v === value));
  }

  function monitorLabel(m) {
    const builtIn = /^(eDP|LVDS|DSI)/i.test(m.name);
    return builtIn ? 'Màn laptop' : m.name === 'screen' ? 'Toàn màn hình' : 'Màn rời';
  }

  function renderSettings() {
    segSelect('#seg-mode', S.mode);
    segSelect('#seg-preset', S.preset);
    $('#sens').value = S.sens;
    $('#sens-out').textContent = Number(S.sens).toFixed(1);
    $('#natural').checked = S.natural;
    $('#cmdctrl').checked = S.cmdCtrl;
    $('#mutelaptop').checked = S.muteLaptop;
    segSelect('#seg-audio', audio.on ? S.audioQ : 'off');
    const box = $('#seg-mon');
    box.textContent = '';
    monitors.forEach((m) => {
      const b = document.createElement('button');
      b.dataset.v = m.name;
      b.append(monitorLabel(m));
      const small = document.createElement('small');
      small.textContent = `${m.name} · ${m.width}×${m.height}`;
      b.append(small);
      box.append(b);
    });
    box.hidden = monitors.length < 2;
    box.previousElementSibling.hidden = monitors.length < 2;
    segSelect('#seg-mon', curMon);
  }

  $('#seg-mode').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setMode(b.dataset.v); });
  $('#seg-preset').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    save('preset', b.dataset.v);
    segSelect('#seg-preset', b.dataset.v);
    send({ t: 'cfg', preset: S.preset, mon: curMon });
  });
  $('#seg-mon').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    save('mon', b.dataset.v);
    view.zoom = 1;
    send({ t: 'cfg', preset: S.preset, mon: b.dataset.v });
  });
  $('#sens').addEventListener('input', (e) => {
    save('sens', Number(e.target.value));
    $('#sens-out').textContent = S.sens.toFixed(1);
  });
  $('#natural').addEventListener('change', (e) => save('natural', e.target.checked));
  $('#cmdctrl').addEventListener('change', (e) => { hwReleaseAll(); save('cmdCtrl', e.target.checked); });

  function sendText(enter) {
    const ta = $('#sendtext');
    if (!ta.value) return;
    send({ t: 'text', s: ta.value + (enter ? '\n' : '') });
    ta.value = '';
    toast('Đã gửi sang laptop.');
  }
  $('#send-text').addEventListener('click', () => sendText(false));
  $('#send-enter').addEventListener('click', () => sendText(true));

  const SYS_CONFIRM = {
    suspend: 'Cho laptop ngủ? Kết nối sẽ ngắt cho tới khi laptop được đánh thức.',
    reboot: 'Khởi động lại laptop? Sau khi khởi động, cần mở lại Work From Bed trên laptop.',
    poweroff: 'Tắt hẳn laptop? Bạn sẽ không bật lại được từ điện thoại.',
  };
  $$('[data-sys]').forEach((b) => b.addEventListener('click', () => {
    const a = b.dataset.sys;
    if (SYS_CONFIRM[a] && !confirm(SYS_CONFIRM[a])) return;
    send({ t: 'sys', a });
    closeSheets();
  }));

  $('#forget').addEventListener('click', () => {
    if (!confirm('Xoá mã kết nối đã lưu trên điện thoại này?')) return;
    token = '';
    store.set('token', '');
    if (ws) { const s = ws; ws = null; s.close(); }
    closeSheets();
    showLogin();
  });

  setInterval(() => {
    const fps = stats.frames, kbs = Math.round(stats.bytes / 1024);
    stats.frames = 0;
    stats.bytes = 0;
    send({ t: 'ping', ts: now() });
    if (!$('#sheet').hidden) {
      $('#stats').textContent = ws ? `Độ trễ ${rtt} ms · ${fps} lần cập nhật/giây · ${kbs} KB/s` : 'Chưa kết nối.';
    }
  }, 1000);

  // ---------- âm thanh từ laptop ----------
  // Phát qua Web Audio: mỗi gói PCM 20 ms thành một AudioBuffer, xếp nối tiếp trên đồng hồ của
  // AudioContext, đệm ~120 ms để chịu được mạng chập chờn. (AudioWorklet cần https nên không dùng.)
  const AUDIO_LEAD = 0.12, AUDIO_MAX = 0.35; // giây
  const audio = { on: false, live: false, ctx: null, out: null, ws: null, next: 0, rate: 48000, ch: 2, retry: 0, timer: 0, announce: false };

  function renderAudio() {
    const b = $('#b-audio');
    b.classList.toggle('on', audio.on && audio.live);
    b.classList.toggle('wait', audio.on && !audio.live);
    b.querySelector('use').setAttribute('href', audio.on ? '#i-sound' : '#i-mute');
    b.setAttribute('aria-label', audio.on ? 'Tắt âm thanh' : 'Bật âm thanh');
    segSelect('#seg-audio', audio.on ? S.audioQ : 'off');
  }

  function startAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { toast('Trình duyệt này không phát được âm thanh.'); return; }
    if (!audio.ctx) {
      try { audio.ctx = new AC({ sampleRate: 48000, latencyHint: 'interactive' }); } catch (_) { audio.ctx = new AC(); }
      audio.out = audio.ctx.createGain();
      audio.out.connect(audio.ctx.destination);
    }
    // iPhone: Web Audio mặc định câm khi gạt nút im lặng; xin phát như một trình nghe nhạc.
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (_) { /* không hỗ trợ */ }
    audio.ctx.resume();
    audio.on = true;
    audio.announce = true; // báo một lần khi luồng tiếng đầu tiên chạy
    save('audio', true);
    openAudio();
    renderAudio();
  }

  function stopAudio(remember = true) {
    audio.on = false;
    audio.live = false;
    if (remember) save('audio', false);
    clearTimeout(audio.timer);
    closeAudioSocket();
    if (audio.ctx) audio.ctx.suspend();
    renderAudio();
  }

  function closeAudioSocket() {
    if (audio.ws) { const s = audio.ws; audio.ws = null; s.close(); }
  }

  function openAudio() {
    clearTimeout(audio.timer);
    if (!audio.on || audio.ws || !token || document.hidden) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new WebSocket(
      `${proto}://${location.host}/audio?k=${encodeURIComponent(token)}&q=${S.audioQ}&mute=${S.muteLaptop ? 1 : 0}`);
    sock.binaryType = 'arraybuffer';
    audio.ws = sock;
    audio.next = 0;
    sock.onmessage = (e) => {
      if (typeof e.data !== 'string') { playChunk(e.data); return; }
      const m = JSON.parse(e.data);
      audio.rate = m.rate;
      audio.ch = m.channels;
      audio.retry = 0;
      audio.live = true;
      if (audio.announce) {
        audio.announce = false;
        toast(m.laptop_muted ? 'Đang phát trên điện thoại, loa laptop tạm tắt.' : 'Đang phát âm thanh trên điện thoại.');
      }
      renderAudio();
    };
    sock.onclose = (e) => {
      if (audio.ws !== sock) return;
      audio.ws = null;
      audio.live = false;
      if (!audio.on) return;
      if (e.code === 4005) { toast('Laptop chưa ghi được âm thanh: cần cài ffmpeg hoặc pulseaudio-utils.'); stopAudio(); return; }
      if ([4001, 4002, 4003, 4004].includes(e.code)) { stopAudio(false); return; }
      audio.timer = setTimeout(openAudio, Math.min(10, 1 + audio.retry++) * 1000);
      renderAudio();
    };
  }

  function playChunk(buf) {
    const ctx = audio.ctx, ch = audio.ch;
    if (!ctx || ctx.state !== 'running') return;
    const pcm = new Int16Array(buf), frames = pcm.length / ch;
    const ab = ctx.createBuffer(ch, frames, audio.rate);
    for (let c = 0; c < ch; c++) {
      const out = ab.getChannelData(c);
      for (let i = 0, j = c; i < frames; i++, j += ch) out[i] = pcm[j] / 32768;
    }
    const now = ctx.currentTime;
    if (audio.next < now + 0.005) audio.next = now + AUDIO_LEAD; // thiếu dữ liệu (mới bật, mạng chậm): đệm lại
    else if (audio.next > now + AUDIO_MAX) return; // dồn quá nhiều: bỏ gói này để giữ độ trễ thấp
    const src = ctx.createBufferSource();
    src.buffer = ab;
    src.connect(audio.out);
    src.start(audio.next);
    audio.next += ab.duration;
  }

  $('#b-audio').addEventListener('click', () => (audio.on ? stopAudio() : startAudio()));
  $('#seg-audio').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.v === 'off') { stopAudio(); return; }
    save('audioQ', b.dataset.v);
    if (!audio.on) { startAudio(); return; }
    closeAudioSocket();
    audio.live = false;
    openAudio();
    renderAudio();
  });
  $('#mutelaptop').addEventListener('change', (e) => {
    save('muteLaptop', e.target.checked);
    if (!audio.on) return;
    closeAudioSocket(); // nối lại để laptop biết lựa chọn mới
    audio.live = false;
    audio.announce = true;
    openAudio();
    renderAudio();
  });
  // Trình duyệt chỉ cho phát tiếng sau một thao tác của người dùng: lần trước có bật thì bật lại ở lần chạm đầu.
  if (store.get('audio', false)) {
    const resume = (e) => {
      if (e.target.closest && e.target.closest('#b-audio, #seg-audio')) return;
      document.removeEventListener('pointerup', resume, true);
      document.removeEventListener('keydown', resume, true);
      if (!audio.on) startAudio();
    };
    document.addEventListener('pointerup', resume, true);
    document.addEventListener('keydown', resume, true);
  }
  // Ẩn trang thì ngắt luồng tiếng cho đỡ tốn mạng; mở lại thì nối lại.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { closeAudioSocket(); audio.live = false; } else openAudio();
    renderAudio();
  });

  // ---------- trạng thái, đăng nhập, thông báo ----------

  function setStatus(text, action) {
    const el = $('#status');
    if (!text) { el.hidden = true; return; }
    $('#status-text').textContent = text;
    $('#status .spinner').hidden = !!action;
    $('#status-retry').hidden = !action;
    if (action) $('#status-retry').textContent = action;
    el.classList.toggle('banner', everConnected && !action);
    el.hidden = false;
    $('#login').hidden = true;
  }

  function showLogin(err) {
    setStatus(null);
    $('#login').hidden = false;
    const e = $('#login-err');
    e.textContent = err || '';
    e.hidden = !err;
  }

  $('#status-retry').addEventListener('click', connect);

  $('#login form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#token').value.trim();
    if (!v) return;
    token = v;
    store.set('token', v);
    $('#token').blur();
    $('#login').hidden = true;
    connect();
  });

  let toastTimer = 0;
  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  // ---------- khởi động ----------

  const relayout = () => requestAnimationFrame(layout);
  window.addEventListener('resize', relayout);
  if (window.visualViewport) {
    visualViewport.addEventListener('resize', relayout);
    visualViewport.addEventListener('scroll', relayout);
  }
  document.addEventListener('gesturestart', (e) => e.preventDefault()); // Safari: chặn phóng to cả trang

  setMode(S.mode);
  renderAudio();
  layout();
  connect();
})();
