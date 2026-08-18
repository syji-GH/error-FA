/**
 * 與 Apps Script Web App 溝通的統一封裝。
 *
 * 三個關鍵限制（不能改，改了就會壞）：
 *  1. Content-Type 必須是 text/plain —— 這樣才算 CORS「simple request」，不會送 preflight。
 *     Apps Script 沒有 doOptions，無法回應 preflight，用 application/json 會在 doPost 執行前就失敗。
 *     （後端一律 JSON.parse(e.postData.contents)，不看宣告的 content type，所以這樣寫是安全的。）
 *  2. 不能加任何自訂 header（Authorization、X-Token…）—— 同樣會觸發 preflight。
 *     所以 session token 是放在 JSON body 裡送。
 *  3. /exec 會 302 導向 script.googleusercontent.com 才回內容，要讓 fetch 跟隨 redirect（預設行為）。
 *     也因為 POST 被重導後理論上可能被重送，所有寫入動作都帶 requestId 做冪等保護。
 */
window.API = (function () {

  function isConfigured() {
    var c = window.CONFIG || {};
    return c.GAS_URL && c.GAS_URL.indexOf('REPLACE_ME') === -1 &&
           c.CLIENT_ID && c.CLIENT_ID.indexOf('REPLACE_ME') === -1;
  }

  function apiError(code, message) {
    var e = new Error(message || code);
    e.code = code;
    return e;
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  // 需要冪等保護的寫入動作
  var MUTATING = {
    'cases.create': 1, 'cases.update': 1, 'cases.setStatus': 1,
    'comments.create': 1, 'comments.update': 1, 'comments.delete': 1,
    'attachments.upload': 1, 'attachments.delete': 1,
  };

  /** 送一次請求，不做任何 token 續期處理 */
  async function raw(action, payload, token, requestId) {
    var envelope = { action: action, token: token || '', payload: payload || {} };
    if (MUTATING[action]) envelope.requestId = requestId || uuid();

    var res;
    try {
      res = await fetch(window.CONFIG.GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(envelope),
        redirect: 'follow',
      });
    } catch (err) {
      throw apiError('NETWORK',
        '連不上後端服務。請確認 Apps Script 已部署，且「誰可以存取」設為「所有人」。');
    }

    var text = await res.text();
    var json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      // 回傳 HTML 幾乎都代表被導到 Google 登入頁 = 部署存取權設定錯誤
      throw apiError('BAD_RESPONSE',
        '後端回應不是 JSON。最常見原因是 Apps Script 部署時「誰可以存取」沒有設為「所有人」。');
    }

    if (!json || json.ok !== true) {
      var e = (json && json.error) || {};
      throw apiError(e.code || 'INTERNAL', e.message || '發生未知錯誤');
    }
    return json.data;
  }

  /**
   * 一般呼叫：自動帶 session token。
   * 遇到 session 失效會請 Auth 重新登入一次再重送（同一個 requestId，避免重複建立資料）。
   */
  async function call(action, payload) {
    if (!isConfigured()) throw apiError('NOT_CONFIGURED', '尚未設定 CLIENT_ID / GAS_URL');

    var requestId = MUTATING[action] ? uuid() : null;
    var token = window.Auth.getSessionToken();

    try {
      return await raw(action, payload, token, requestId);
    } catch (err) {
      if (err.code !== 'UNAUTHENTICATED' && err.code !== 'TOKEN_EXPIRED') throw err;
      var fresh = await window.Auth.reauth();
      if (!fresh) throw err;
      return await raw(action, payload, fresh, requestId);
    }
  }

  return {
    call: call,
    raw: raw,
    uuid: uuid,
    isConfigured: isConfigured,

    /** Phase 0 連線測試，不需要任何 token */
    ping: function () { return raw('ping', {}, ''); },

    /* session（由 auth.js 使用） */
    // boot:true 會讓後端一併回傳首頁要的 stats/list/meta，省掉三趟往返
    login:  function (idToken, boot) { return raw('session.login', { idToken: idToken, boot: !!boot }, ''); },
    resume: function (token, boot)   { return raw('session.resume', { boot: !!boot }, token); },
    logout: function (token)   { return raw('session.logout', {}, token); },

    /* 業務 action —— 名稱與 apps-script 端一一對應 */
    bootstrap:     function ()       { return call('meta.bootstrap'); },
    listCases:     function (q)      { return call('cases.list', q || {}); },
    getCase:       function (id)     { return call('cases.get', { caseId: id }); },
    createCase:    function (data)   { return call('cases.create', data); },
    updateCase:    function (id, p)  { return call('cases.update', { caseId: id, patch: p }); },
    setStatus:     function (id, s, note) { return call('cases.setStatus', { caseId: id, status: s, note: note || '' }); },
    addComment:    function (data)   { return call('comments.create', data); },
    editComment:   function (id, b)  { return call('comments.update', { commentId: id, body: b }); },
    deleteComment: function (id)     { return call('comments.delete', { commentId: id }); },
    uploadFile:    function (data)   { return call('attachments.upload', data); },
    getThumb:      function (id)     { return call('attachments.thumb', { attachmentId: id }); },
    stats:         function ()       { return call('cases.stats'); },
  };
})();
