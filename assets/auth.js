/**
 * 登入流程。
 *
 * 設計重點：Google ID token 只用「一次」。
 *   1. GIS 給我們一張 ID token（約 1 小時到期）
 *   2. 立刻拿去後端 session.login 驗證（驗簽章、驗 aud、驗 hd === ecoco.xyz）
 *   3. 後端回一張自家的 session token（12 小時），之後所有請求都用它
 * 這樣使用者一整天不會被 Google token 的 1 小時到期打斷 ——
 * GIS 的「靜默續期」在 FedCM 之後可靠度不穩，不能當成流程的依賴。
 *
 * 另外：`hd: 'ecoco.xyz'` 只是提示，幫使用者預選公司帳號。
 * 真正的網域限制在後端 verifyIdToken() 檢查 token 的 hd claim —— 前端這裡不是安全機制。
 */
window.Auth = (function () {

  var SESSION_KEY = 'faSession';

  var sessionToken = null;
  var user = null;          // { email, name, role, dept } —— 來自後端，權威來源
  var onReady = null;
  var reauthPending = null;
  var bootData = null;      // 開站那一趟順便帶回來的 stats/list/meta，只給第一次渲染用

  /* ── session 保存 ─────────────────────────────────────── */
  // 用 sessionStorage 而非 localStorage：現場電腦是共用的，關掉分頁就登出比較安全

  function saveSession(token, expiresAt) {
    sessionToken = token;
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ t: token, e: expiresAt || '' }));
    } catch (e) {}
  }

  function loadSession() {
    try {
      var raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (s.e && new Date(s.e).getTime() < Date.now()) return null;
      return s.t || null;
    } catch (e) { return null; }
  }

  function clearSession() {
    sessionToken = null;
    user = null;
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
  }

  /* ── GIS callback ─────────────────────────────────────── */

  async function handleCredential(resp) {
    if (!resp || !resp.credential) return;
    try {
      // 重新驗證的情境不需要 boot 包，只有真正開站才要
      var wantBoot = !reauthPending;
      var data = await window.API.login(resp.credential, wantBoot);
      saveSession(data.sessionToken, data.expiresAt);
      user = data.user;
      if (data.boot) bootData = data.boot;

      // 有人在等重新驗證就先餵給他
      if (reauthPending) { reauthPending.resolve(sessionToken); reauthPending = null; return; }

      enterApp();
    } catch (err) {
      clearSession();
      if (reauthPending) { reauthPending.resolve(null); reauthPending = null; }
      try { google.accounts.id.disableAutoSelect(); } catch (e) {}
      showGate();
      gateError(
        err.code === 'DOMAIN_DENIED' || err.code === 'FORBIDDEN'
          ? '這個帳號無法使用本系統，請改用 @ecoco.xyz 公司帳號登入'
          : (err.message || '登入失敗，請再試一次'));
    }
  }

  /* ── 對外 ─────────────────────────────────────────────── */

  function getSessionToken() { return sessionToken; }
  function getUser() { return user; }
  function is(role) { return !!user && user.role === role; }
  function canManage() { return !!user && (user.role === 'admin' || user.role === 'facility'); }

  /** session 失效時重新登入一次。拿不到就回 null，並退回登入畫面 */
  function reauth() {
    if (reauthPending) return reauthPending.promise;

    var box = {};
    box.promise = new Promise(function (resolve) { box.resolve = resolve; });
    reauthPending = box;

    var timer = setTimeout(function () {
      if (!reauthPending) return;
      reauthPending.resolve(null);
      reauthPending = null;
      clearSession();
      showGate();
      gateError('登入已逾期，請重新登入');
    }, 15000);

    box.promise.then(function () { clearTimeout(timer); });

    try {
      google.accounts.id.prompt();
    } catch (e) {
      clearTimeout(timer);
      if (reauthPending) { reauthPending.resolve(null); reauthPending = null; }
    }
    return box.promise;
  }

  async function logout() {
    var t = sessionToken;
    clearSession();
    try { google.accounts.id.disableAutoSelect(); } catch (e) {}
    if (t) { try { await window.API.logout(t); } catch (e) {} }
    location.hash = '';
    showGate();
  }

  /* ── 畫面切換 ─────────────────────────────────────────── */

  function enterApp() {
    document.getElementById('gate').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    gateError('');
    if (onReady) onReady(user);
  }
  function showGate() {
    document.getElementById('app').classList.add('hidden');
    document.getElementById('gate').classList.remove('hidden');
  }
  function gateError(msg) {
    var el = document.getElementById('gateError');
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
  }

  /* ── 啟動 ─────────────────────────────────────────────── */

  function init(cb) {
    onReady = cb;

    if (!window.API.isConfigured()) {
      document.getElementById('gateConfigWarn').classList.remove('hidden');
      document.getElementById('gsiButton').innerHTML =
        '<p class="text-sm font-medium text-muted">尚未完成設定</p>';
      return;
    }

    var tries = 0;
    (function waitForGis() {
      if (!window.google || !google.accounts || !google.accounts.id) {
        if (++tries > 100) {
          gateError('無法載入 Google 登入元件，請檢查網路或防火牆設定');
          return;
        }
        return setTimeout(waitForGis, 100);
      }
      start();
    })();
  }

  async function start() {
    google.accounts.id.initialize({
      client_id: window.CONFIG.CLIENT_ID,
      callback: handleCredential,
      hd: window.CONFIG.HD,            // 只是提示，真正把關在後端
      auto_select: true,
      cancel_on_tap_outside: false,
      use_fedcm_for_prompt: true,
    });

    google.accounts.id.renderButton(document.getElementById('gsiButton'), {
      type: 'standard', theme: 'filled_black', size: 'large',
      text: 'signin_with', shape: 'pill', locale: 'zh_TW', width: 280,
    });

    // 重新整理時若 session 還在，直接續用，不打擾使用者
    var saved = loadSession();
    if (saved) {
      try {
        var data = await window.API.resume(saved, true);
        sessionToken = saved;
        user = data.user;
        if (data.boot) bootData = data.boot;
        enterApp();
        return;
      } catch (e) {
        clearSession();
      }
    }

    google.accounts.id.prompt();
  }

  return {
    init: init,
    logout: logout,
    reauth: reauth,
    getSessionToken: getSessionToken,
    getUser: getUser,
    /** 取走開站那一趟帶回來的資料，只能取一次——之後的重繪一律走正常 API */
    takeBoot: function () { var b = bootData; bootData = null; return b; },
    is: is,
    canManage: canManage,
  };
})();
