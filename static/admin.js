'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const PRESETS = { low: 'Tiết kiệm', mid: 'Cân bằng', high: 'Nét nhất' };
  const TABS = { lan: 'Wi-Fi nhà', tailscale: 'Tailscale', local: 'Laptop này' };
  const STEPS = {
    lan: [
      'Cho điện thoại bắt cùng Wi-Fi với laptop.',
      'Mở camera, quét mã QR, rồi chạm vào đường dẫn hiện ra.',
      'Trong trình duyệt điện thoại, chọn <b>Thêm vào màn hình chính</b> để lần sau mở như một ứng dụng.',
    ],
    tailscale: [
      'Cài Tailscale trên điện thoại, đăng nhập cùng tài khoản với laptop.',
      'Mở camera, quét mã QR. Cách này dùng được cả khi không ở nhà.',
      'Chọn <b>Thêm vào màn hình chính</b> để lần sau mở nhanh.',
    ],
    local: [
      'Laptop chưa kết nối mạng nào, nên điện thoại chưa vào được.',
      'Nối Wi-Fi rồi đợi vài giây, mã QR sẽ tự cập nhật.',
    ],
  };

  let state = null, tab = 0, shownQr = '', busy = false;

  const api = (path, body) => fetch('/admin/api/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-WFB-Admin': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((r) => {
    if (!r.ok) return r.text().then((t) => { throw new Error(t || r.statusText); });
    return r.json();
  });

  function ago(ts) {
    const s = Math.max(0, Date.now() / 1000 - ts);
    if (s < 60) return 'vừa xong';
    if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
    if (s < 86400) return `${Math.floor(s / 3600)} giờ trước`;
    return `${Math.floor(s / 86400)} ngày trước`;
  }

  function uptime(ts) {
    const m = Math.floor((Date.now() / 1000 - ts) / 60);
    if (m < 1) return 'vừa khởi động';
    if (m < 60) return `${m} phút`;
    return `${Math.floor(m / 60)} giờ ${m % 60} phút`;
  }

  const clock = (ts) => new Date(ts * 1000).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  const monitorName = (name) => (/^(eDP|LVDS|DSI)/i.test(name || '') ? 'Màn laptop' : name ? `Màn rời ${name}` : '');

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    children.forEach((c) => node.append(c));
    return node;
  }

  function icon(id) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'i');
    const use = document.createElementNS(ns, 'use');
    use.setAttribute('href', id);
    svg.append(use);
    return svg;
  }

  function render() {
    const s = state;
    $('#status').className = 'pill ok';
    $('#status-text').textContent = `Đang chạy${s.docker ? ' trong Docker' : ''} · ${uptime(s.started)}`;

    // Thẻ kết nối
    tab = Math.min(tab, s.urls.length - 1);
    const tabs = $('#tabs');
    const keys = s.urls.map((u) => u.kind + u.url);
    if (tabs.dataset.keys !== keys.join('|')) {
      tabs.dataset.keys = keys.join('|');
      tabs.textContent = '';
      s.urls.forEach((u, i) => {
        const b = el('button', { type: 'button', textContent: TABS[u.kind] + (s.urls.filter((x) => x.kind === u.kind).length > 1 ? ` ${i + 1}` : '') });
        b.setAttribute('role', 'tab');
        b.addEventListener('click', () => { tab = i; render(); });
        tabs.append(b);
      });
    }
    [...tabs.children].forEach((b, i) => b.setAttribute('aria-selected', String(i === tab)));
    tabs.hidden = s.urls.length < 2;
    const u = s.urls[tab];
    if (shownQr !== u.url) {
      shownQr = u.url;
      $('#qr').src = `/admin/qr.svg?i=${tab}&v=${encodeURIComponent(u.url)}`;
      $('#steps').innerHTML = STEPS[u.kind].map((t) => `<li>${t}</li>`).join('');
    }
    $('#url').textContent = u.url;
    $('#token').textContent = s.token;
    $('#try-local').href = `/?k=${encodeURIComponent(s.token)}`;

    // Điện thoại đang kết nối
    const list = $('#clients');
    list.textContent = '';
    s.clients.forEach((c) => {
      const meta = [c.ip, `kết nối ${ago(c.since)}`, monitorName(c.monitor), PRESETS[c.preset]].filter(Boolean).join(' · ');
      const kick = el('button', { className: 'btn', type: 'button', textContent: 'Ngắt' });
      kick.addEventListener('click', () => act(() => api('kick', { id: c.id }), `Đã ngắt ${c.device}.`));
      list.append(el('li', {},
        el('span', { className: 'avatar' }, icon('#i-phone')),
        el('span', { className: 'who' }, el('b', { textContent: c.device }), el('span', { textContent: meta })),
        kick));
    });
    $('#clients-empty').hidden = s.clients.length > 0;
    const count = $('#client-count');
    count.textContent = s.clients.length;
    count.classList.toggle('live', s.clients.length > 0);

    // Cài đặt
    $('#autostart-row').hidden = s.docker;
    $('#menu-row').hidden = s.docker;
    $('#docker-note').hidden = !s.docker;
    if (!busy) $('#autostart').checked = !!s.autostart;
    $('#menu').disabled = !!s.menu;
    $('#menu').textContent = s.menu ? 'Đã có trong menu' : 'Thêm vào menu';

    // Hoạt động gần đây
    const ev = $('#events');
    ev.textContent = '';
    s.events.forEach((e) => {
      ev.append(el('li', { className: e.kind },
        el('time', { textContent: clock(e.ts) }), el('i', { className: `k ${e.kind}` }), el('span', { textContent: e.text })));
    });
  }

  async function refresh() {
    try {
      state = await api('state');
      $('#offline').hidden = true;
      render();
    } catch (_) {
      $('#offline').hidden = false;
      $('#status').className = 'pill bad';
      $('#status-text').textContent = 'Không chạy';
    }
  }

  async function act(fn, done) {
    try {
      await fn();
      if (done) toast(done);
    } catch (e) {
      toast('Lỗi: ' + e.message);
    }
    refresh();
  }

  let toastTimer = 0;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    const text = $('#' + b.dataset.copy).textContent;
    navigator.clipboard.writeText(text).then(() => toast('Đã sao chép.'), () => toast('Không sao chép được, hãy bôi đen rồi Ctrl+C.'));
  });

  $('#new-token').addEventListener('click', () => {
    if (!confirm('Đổi mã kết nối? Mọi điện thoại đang dùng sẽ bị ngắt và phải quét lại mã QR mới.')) return;
    shownQr = '';
    act(() => api('token', {}), 'Đã đổi mã. Quét lại mã QR trên điện thoại.');
  });

  $('#autostart').addEventListener('change', (e) => {
    const on = e.target.checked;
    busy = true;
    act(() => api('autostart', { on }), on ? 'Từ lần đăng nhập sau, Work From Bed sẽ tự chạy.' : 'Đã tắt tự chạy khi đăng nhập.')
      .finally(() => { busy = false; });
  });

  $('#menu').addEventListener('click', () => act(() => api('menu', {}), 'Đã thêm vào menu ứng dụng.'));

  $('#stop').addEventListener('click', () => {
    if (!confirm('Dừng Work From Bed? Điện thoại sẽ mất kết nối.')) return;
    act(() => api('stop', {}));
  });

  refresh();
  setInterval(refresh, 2000);
})();
