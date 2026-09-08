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
 * 登入狀態存在 localStorage（跨分頁、關瀏覽器也還在），共用電腦的風險改由
 * 閒置逾時來顧 —— 見下方「session 保存」與「閒置逾時」兩段。
 *
 * 另外：`hd: 'ecoco.xyz'` 只是提示，幫使用者預選公司帳號。
 * 真正的網域限制在後端 verifyIdToken() 檢查 token 的 hd claim —— 前端這裡不是安全機制。
 */
window.Auth = (function () {

  var SESSION_KEY = 'faSession';
  var BOOT_KEY = 'faBoot';

  // 閒置逾時：超過 CONFIG.IDLE_MINUTES 分鐘沒有任何操作就自動登出。設 0 表示不啟用。
  var IDLE_LIMIT_MS = Math.max(0, Number(window.CONFIG.IDLE_MINUTES) || 0) * 60 * 1000;
  var IDLE_CHECK_MS = 30 * 1000;       // 背景每 30 秒檢查一次
  var TOUCH_THROTTLE_MS = 30 * 1000;   // 使用者操作最多每 30 秒寫一次 localStorage

  var sessionToken = null;
  var user = null;          // { email, name, role, dept } —— 來自後端，權威來源
  var onReady = null;
  var reauthPending = null;
  var bootData = null;      // 開站那一趟順便帶回來的 stats/list/meta，只給第一次渲染用
  var idleTimer = null;
  var lastTouch = 0;        // 上次把「最後操作時間」寫進 localStorage 的時刻，節流用

  var IDLE_EVENTS = ['pointerdown', 'keydown', 'scroll'];

  /* ── session 保存 ─────────────────────────────────────── */
  /**
   * 用 localStorage 而非 sessionStorage。sessionStorage 是「每個分頁各自獨立」，
   * 關分頁、開新分頁都等於沒登入過，後端那張 12 小時的 token 幾乎沒機會被用到，
   * 使用者一天要按好幾次登入。
   *
   * 共用電腦的安全性改由下面的閒置逾時顧：登入狀態跨分頁共用，但只要
   * IDLE_MINUTES 分鐘沒人動，就連同後端的 session 一起作廢。
   * 記錄格式：{ t: session token, e: 後端給的到期時間, a: 最後操作時間 }
   */

  function readStore() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function writeStore(s) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) {}
  }

  /** 沒有 a 欄位的舊記錄一律當成閒置過期——寧可多登一次，不要放行來路不明的記錄 */
  function idleExpired(s) {
    if (!IDLE_LIMIT_MS) return false;
    return !s.a || (Date.now() - s.a) > IDLE_LIMIT_MS;
  }

  function saveSession(token, expiresAt) {
    sessionToken = token;
    lastTouch = Date.now();
    writeStore({ t: token, e: expiresAt || '', a: lastTouch });
    startIdleWatch();
  }

  function loadSession() {
    var s = readStore();
    if (!s || !s.t) return null;
    if (s.e && new Date(s.e).getTime() < Date.now()) return null;   // 12 小時絕對壽命到了
    if (idleExpired(s)) return null;
    return s.t;
  }

  function clearSession() {
    sessionToken = null;
    user = null;
    stopIdleWatch();
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
    clearBootCache();
  }

  /* ── 開站資料快取 ─────────────────────────────────────── */
  /**
   * 把上一次開站拿到的 stats/list/meta 存起來，下次開站先畫舊的、同時在背景重新抓，
   * 資料回來再換掉（stale-while-revalidate）。冷啟動那 8 秒省不掉，但使用者不用盯著
   * 骨架等——一進來就看得到上次的清單。
   *
   * 這份快取跟 session 綁在一起：clearSession() 會一併清掉，所以登出、閒置逾時、
   * 或別的分頁登出之後，下一個人不會看到前一個人的資料。要先看得到內容，前提是
   * loadSession() 通過（絕對壽命 12 小時 + 閒置逾時都還沒到）。
   *
   * 代價要講清楚：這是在「後端確認 session 之前」就先畫出來。後端唯一可能推翻的情況
   * 是 session 已在別的裝置登出或伺服器端過期——那時 resume 會失敗，畫面會退回登入閘門。
   */
  function saveBootCache(u, boot) {
    if (!u || !boot) return;
    try {
      localStorage.setItem(BOOT_KEY, JSON.stringify({ at: Date.now(), user: u, boot: boot }));
    } catch (e) { /* 配額滿了就算了，只是少一層快取 */ }
  }

  function loadBootCache() {
    try {
      var raw = localStorage.getItem(BOOT_KEY);
      if (!raw) return null;
      var c = JSON.parse(raw);
      if (!c || !c.user || !c.boot) return null;
      // 跟 session 的絕對壽命對齊，太舊的寧可等後端
      if (Date.now() - Number(c.at || 0) > 12 * 60 * 60 * 1000) return null;
      return c;
    } catch (e) { return null; }
  }

  function clearBootCache() {
    try { localStorage.removeItem(BOOT_KEY); } catch (e) {}
  }

  function bootHint(show) {
    var el = document.getElementById('bootHint');
    if (el) el.classList.toggle('hidden', !show);
  }

  /* ── 閒置逾時 ─────────────────────────────────────────── */

  /** 使用者有動作 → 更新最後操作時間。節流到最多 30 秒寫一次，所以判定誤差最多 30 秒。 */
  function touch() {
    if (!sessionToken || !IDLE_LIMIT_MS) return;
    var now = Date.now();
    if (now - lastTouch < TOUCH_THROTTLE_MS) return;
    lastTouch = now;
    var s = readStore();
    if (s && s.t) { s.a = now; writeStore(s); }
  }

  function startIdleWatch() {
    if (idleTimer || !IDLE_LIMIT_MS) return;
    IDLE_EVENTS.forEach(function (ev) {
      window.addEventListener(ev, touch, { passive: true, capture: true });
    });
    document.addEventListener('visibilitychange', onVisible);
    idleTimer = setInterval(checkIdle, IDLE_CHECK_MS);
  }

  function stopIdleWatch() {
    if (!idleTimer) return;
    IDLE_EVENTS.forEach(function (ev) {
      window.removeEventListener(ev, touch, { capture: true });
    });
    document.removeEventListener('visibilitychange', onVisible);
    clearInterval(idleTimer);
    idleTimer = null;
  }

  /** 切回這個分頁時立刻檢查一次，不用等下一輪 */
  function onVisible() {
    if (!document.hidden) checkIdle();
  }

  function checkIdle() {
    if (!sessionToken) return;
    var s = readStore();
    // localStorage 是跨分頁共用的：別的分頁登出了，這個分頁也要跟著退出
    if (!s || !s.t) { forceLogout('登入已在其他分頁結束，請重新登入'); return; }
    if (idleExpired(s)) forceLogout('太久沒有操作，已自動登出，請重新登入');
  }

  /** 閒置逾時／其他分頁登出：本機清乾淨，順手把後端那張 token 也作廢，不等結果 */
  function forceLogout(msg) {
    var t = sessionToken;
    clearSession();
    try { google.accounts.id.disableAutoSelect(); } catch (e) {}
    if (t) { try { window.API.logout(t).catch(function () {}); } catch (e) {} }
    location.hash = '';
    showGate();
    gateError(msg);
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
      if (data.boot) {
        bootData = data.boot;
        saveBootCache(user, data.boot);
      }

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

  /**
   * 開站時 session.resume 那一趟要等後端回來，冷啟動實測 8 秒以上
   * （Apps Script 把容器叫醒的時間，跟我們的程式碼無關）。
   *
   * 這段期間原本畫面停在登入閘門，看起來像在要使用者重新登入——明明上一秒還登著。
   * 改成先把 app 外框和骨架畫出來：等待時間沒變短，但看得出來是在載入而不是壞了。
   * 資料還沒到，所以 header 上的操作先鎖住，避免點了沒反應。
   */
  function showBooting() {
    document.getElementById('gate').classList.add('hidden');
    var app = document.getElementById('app');
    app.classList.remove('hidden');
    app.classList.add('is-booting');
    var view = document.getElementById('view');
    if (view && window.UI) view.innerHTML = window.UI.skeleton(4);
  }
  function endBooting() {
    document.getElementById('app').classList.remove('is-booting');
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

    // 這兩件事都不等 GIS。gsi/client 是 async defer，排在它後面的話：
    // 畫快取的意義會被那段等待吃掉，而續用 session 只需要一張 token，
    // 兩者都用不到 Google 登入元件。resume 提前發出去，正好跟 GIS 載入平行跑。
    primeFromCache();
    resumeDone = resumeSession();

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

  var primed = false;       // 已經用快取進場了嗎
  var resumeDone = null;    // Promise<boolean>：既有 session 有沒有成功續用

  function primeFromCache() {
    var saved = loadSession();
    if (!saved) return;

    var cached = loadBootCache();
    if (!cached) return;

    sessionToken = saved;
    lastTouch = 0;        // 開站本身算一次操作，把閒置計時歸零
    touch();
    startIdleWatch();

    user = cached.user;
    bootData = cached.boot;
    primed = true;
    endBooting();
    enterApp();
    bootHint(true);
  }

  /**
   * 重新整理時若 session 還在，直接續用，不打擾使用者。
   * 回傳「有沒有成功進場」，start() 靠它決定要不要跳 Google 登入。
   */
  async function resumeSession() {
    var saved = loadSession();
    if (!saved) return false;

    if (!primed) {
      sessionToken = saved;
      lastTouch = 0;        // 開站本身算一次操作，把閒置計時歸零
      touch();
      startIdleWatch();
      showBooting();        // 沒有快取可畫，至少讓人看得出來是在載入
    }

    try {
      var data = await window.API.resume(saved, true);
      user = data.user;
      if (data.boot) {
        bootData = data.boot;
        saveBootCache(user, data.boot);
      }
      bootHint(false);
      endBooting();
      // 已經用快取進場的話這是第二次呼叫 onReady，app.js 會拿新的 bootData 重畫一次
      if (primed) { if (onReady) onReady(user); }
      else enterApp();
      return true;
    } catch (e) {
      bootHint(false);
      endBooting();
      clearSession();
      showGate();
      return false;
    }
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

    // resume 在 init() 就發出去了，這裡只等它的結果決定要不要打擾使用者
    if (await resumeDone) return;

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
