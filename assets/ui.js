/* 共用 UI 工具與元件（依 ECOCO_DESIGN.md） */

window.UI = (function () {

  /* ── 基本工具 ─────────────────────────────────────────── */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 純文字 → HTML，順便把網址變連結（內容已先 esc 過）
  function linkify(text) {
    return esc(text).replace(/(https?:\/\/[^\s<]+)/g,
      '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  }

  function initials(name, email) {
    var s = (name || email || '?').trim();
    // 中文取最後一個字（姓名末字辨識度較高），英文取首字母
    if (/[一-鿿]/.test(s)) return s.slice(-1);
    return s.slice(0, 1).toUpperCase();
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return String(iso);
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) +
           ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function fmtRelative(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return String(iso);
    var s = (Date.now() - d.getTime()) / 1000;
    if (s < 60) return '剛剛';
    if (s < 3600) return Math.floor(s / 60) + ' 分鐘前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小時前';
    if (s < 86400 * 7) return Math.floor(s / 86400) + ' 天前';
    return fmtDate(iso).slice(0, 10);
  }

  function fmtSize(bytes) {
    var b = Number(bytes) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
    return (b / 1024 / 1024).toFixed(1) + ' MB';
  }

  /* ── 元件 ─────────────────────────────────────────────── */

  function statusBadge(status) {
    var st = (window.STATUS_STYLE || {})[status] ||
             { dot: '#6B7280', chip: 'bg-card text-muted border-line' };
    return '<span class="inline-flex items-center gap-1.5 border rounded-lg px-2.5 py-1 ' +
           'text-[10px] font-bold tracking-widest ' + st.chip + '">' +
           '<span class="w-1.5 h-1.5 rounded-full" style="background:' + st.dot + '"></span>' +
           esc(status) + '</span>';
  }

  function typeBadge(type) {
    return '<span class="inline-block border rounded-lg px-2.5 py-1 text-[10px] ' +
           'font-bold tracking-widest ' + window.TYPE_CHIP + '">' + esc(type) + '</span>';
  }

  function avatar(name, email, size) {
    var cls = size === 'sm' ? 'w-7 h-7 text-[11px]' : 'w-9 h-9 text-sm';
    return '<span class="' + cls + ' shrink-0 rounded-full bg-ecoco-blue text-white ' +
           'font-black flex items-center justify-center">' + esc(initials(name, email)) + '</span>';
  }

  function field(label, value) {
    if (value == null || value === '') return '';
    return '<div>' +
      '<p class="text-[10px] font-bold tracking-widest uppercase text-muted mb-1">' + esc(label) + '</p>' +
      '<p class="text-sm font-bold text-ink break-words">' + esc(value) + '</p></div>';
  }

  function skeleton(n) {
    var out = '';
    for (var i = 0; i < (n || 3); i++) {
      out += '<div class="bg-white rounded-2xl border border-line p-5">' +
             '<div class="fa-skel h-4 w-24 rounded mb-3"></div>' +
             '<div class="fa-skel h-5 w-2/3 rounded mb-3"></div>' +
             '<div class="fa-skel h-3 w-1/3 rounded"></div></div>';
    }
    return '<div class="space-y-3">' + out + '</div>';
  }

  function empty(title, hint) {
    return '<div class="bg-white rounded-2xl border border-line py-16 text-center">' +
      '<p class="text-lg font-black tracking-tight text-ink">' + esc(title) + '</p>' +
      (hint ? '<p class="mt-2 text-sm font-medium text-ink2">' + esc(hint) + '</p>' : '') +
      '</div>';
  }

  /* ── Toast ───────────────────────────────────────────── */

  function toast(msg, kind) {
    var root = document.getElementById('toastRoot');
    if (!root) return;
    var color = kind === 'error' ? 'bg-red-600'
              : kind === 'ok'    ? 'bg-green-500'
              :                    'bg-ink';
    var el = document.createElement('div');
    el.className = 'fa-pop ' + color + ' text-white text-sm font-bold rounded-full ' +
                   'px-5 py-2.5 shadow-panel max-w-[90vw] text-center';
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .25s';
      el.style.opacity = '0';
      setTimeout(function () { el.remove(); }, 250);
    }, kind === 'error' ? 5000 : 2600);
  }

  /* ── Modal ───────────────────────────────────────────── */

  var openModals = [];

  function modal(opts) {
    var root = document.getElementById('modalRoot');
    var wrap = document.createElement('div');
    wrap.className = 'fixed inset-0 z-[65] flex items-end sm:items-center justify-center px-0 sm:px-4 py-0 sm:py-8';
    wrap.innerHTML =
      '<div data-mask class="absolute inset-0 bg-[#1A1A1A]/20 backdrop-blur-sm"></div>' +
      '<div class="fa-pop relative bg-white w-full ' + (opts.width || 'sm:max-w-2xl') +
        ' rounded-t-2xl sm:rounded-2xl shadow-panel max-h-[92vh] flex flex-col">' +
        '<div class="flex items-center gap-3 px-6 py-5 border-b border-line shrink-0">' +
          '<h2 class="text-lg font-black tracking-tight text-ink">' + esc(opts.title || '') + '</h2>' +
          '<div class="flex-1"></div>' +
          '<button data-close class="text-muted hover:text-ink hover:bg-card rounded-full w-8 h-8 ' +
            'flex items-center justify-center transition-colors text-xl leading-none">&times;</button>' +
        '</div>' +
        '<div data-body class="px-6 py-5 overflow-y-auto flex-1"></div>' +
        (opts.footer === false ? '' :
          '<div data-footer class="px-6 py-4 border-t border-line shrink-0 flex items-center justify-end gap-2"></div>') +
      '</div>';

    root.appendChild(wrap);
    var body = wrap.querySelector('[data-body]');
    if (typeof opts.body === 'string') body.innerHTML = opts.body;
    else if (opts.body) body.appendChild(opts.body);

    function close() {
      wrap.remove();
      openModals = openModals.filter(function (m) { return m !== close; });
      if (!openModals.length) document.body.style.overflow = '';
      if (opts.onClose) opts.onClose();
    }
    openModals.push(close);
    document.body.style.overflow = 'hidden';

    wrap.querySelector('[data-close]').addEventListener('click', close);
    wrap.querySelector('[data-mask]').addEventListener('click', close);

    return { el: wrap, body: body, footer: wrap.querySelector('[data-footer]'), close: close };
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && openModals.length) openModals[openModals.length - 1]();
  });

  /* ── 按鈕樣式（依設計規範） ───────────────────────────── */

  var btn = {
    primary: 'bg-ecoco-orange text-white font-bold text-[15px] rounded-full px-5 py-2.5 ' +
             'shadow-ecoco-cta hover:bg-ecoco-orange-d hover:scale-105 transition-all ' +
             'disabled:opacity-50 disabled:hover:scale-100 disabled:cursor-not-allowed',
    secondary: 'bg-ecoco-blue text-white font-bold text-[15px] rounded-full px-5 py-2.5 ' +
               'shadow-lg hover:bg-ecoco-orange hover:-translate-y-0.5 transition-all ' +
               'disabled:opacity-50 disabled:hover:translate-y-0 disabled:cursor-not-allowed',
    ghost: 'text-muted hover:text-ink hover:bg-card font-bold text-[15px] ' +
           'rounded-full px-5 py-2.5 transition-colors',
    danger: 'bg-red-600 hover:bg-red-700 text-white font-bold text-[15px] ' +
            'rounded-full px-5 py-2.5 transition-colors',
  };

  var input = 'w-full bg-white border border-line rounded-xl px-3.5 py-2.5 text-sm font-medium ' +
              'text-ink placeholder:text-ph outline-none focus:border-ecoco-orange transition-colors';

  return {
    esc: esc, linkify: linkify, initials: initials,
    fmtDate: fmtDate, fmtRelative: fmtRelative, fmtSize: fmtSize,
    statusBadge: statusBadge, typeBadge: typeBadge, avatar: avatar, field: field,
    skeleton: skeleton, empty: empty, toast: toast, modal: modal,
    btn: btn, input: input,
  };
})();
