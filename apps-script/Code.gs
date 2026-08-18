/**
 * Code.gs — error-FA 後端入口。doPost/doGet 路由、統一回應信封、共用小工具、
 * meta.bootstrap（前端啟動時要的靜態設定資料）。
 *
 * ============================================================
 * 部署前必填：
 *   建議在「專案設定 → Script Properties」設定 CLIENT_ID / SPREADSHEET_ID，
 *   不用改程式碼；沒設定的話會退回用下面兩個常數。
 *   CLIENT_ID       Google Cloud Console 建立的 OAuth 2.0 Client ID
 *   SPREADSHEET_ID  存放六個分頁（Cases/Comments/...）的試算表 ID
 * ============================================================
 *
 * 請求信封：{ action, token, requestId, payload }
 *   action     字串，見 ACTIONS
 *   token      我們自己發的 session token（session.login 換來的），
 *              除了 ping / session.login 以外都要帶
 *   requestId  前端產生的 UUID，用來做「會寫入資料的 action」的冪等保護（見 doPost）
 *   payload    該 action 的參數物件
 *
 * 回應信封：{ ok:true, data } 或 { ok:false, error:{ code, message } }
 *   code ∈ UNAUTHENTICATED | FORBIDDEN | NOT_FOUND | BAD_REQUEST | CONFLICT | INTERNAL
 */

const CLIENT_ID = 'REPLACE_ME.apps.googleusercontent.com';
const SPREADSHEET_ID = 'REPLACE_ME';

// 每次部署前手動 +1（或改成日期字串），doGet 會回傳這個版本號，
// 一看就知道 /exec 上線的是哪一版，避免部署到錯的 deployment id 卻沒發現。
const SCRIPT_VERSION = '2026-08-18.4';

// 案件描述 / 留言內容都是純文字（前端用 white-space:pre-wrap 顯示，自動連結網址），
// 不接受也不需要 HTML，這裡只做長度上限保護。
const MAX_TEXT_LEN = 20000;

function getClientId_() {
  return PropertiesService.getScriptProperties().getProperty('CLIENT_ID') || CLIENT_ID;
}

function getSpreadsheetId_() {
  return PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || SPREADSHEET_ID;
}

function nowIso_() {
  return new Date().toISOString();
}

/** 統一的業務錯誤：code 對應 UNAUTHENTICATED/FORBIDDEN/NOT_FOUND/BAD_REQUEST/CONFLICT/INTERNAL */
class AppError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// 會寫入資料的 action 才需要 requestId 冪等保護：
// Apps Script /exec 在回應前會先 302 導轉，重試中的請求有可能被重送，
// 沒有這層保護的話「開一張單」可能因為網路重試變成兩張。
const MUTATING_ACTIONS = {
  'cases.create': true,
  'cases.update': true,
  'cases.setStatus': true,
  'comments.create': true,
  'comments.update': true,
  'comments.delete': true,
  'attachments.upload': true,
  'attachments.delete': true
};

const ACTIONS = {
  'ping': { auth: false, handler: function () { return { pong: true, now: nowIso_(), version: SCRIPT_VERSION }; } },

  'session.login': { auth: false, handler: sessionLogin },
  'session.resume': { auth: true, handler: sessionResume },
  'session.logout': { auth: true, handler: sessionLogout },

  'meta.bootstrap': { auth: true, handler: metaBootstrap },

  'cases.list': { auth: true, handler: casesList },
  'cases.get': { auth: true, handler: casesGet },
  'cases.create': { auth: true, handler: casesCreate },
  'cases.update': { auth: true, handler: casesUpdate },
  'cases.setStatus': { auth: true, handler: casesSetStatus },
  'cases.stats': { auth: true, handler: casesStats },

  'comments.create': { auth: true, handler: commentsCreate },
  'comments.update': { auth: true, handler: commentsUpdate },
  'comments.delete': { auth: true, handler: commentsDelete },

  'attachments.upload': { auth: true, handler: attachmentsUpload },
  'attachments.thumb': { auth: true, handler: attachmentsThumb },
  'attachments.delete': { auth: true, handler: attachmentsDelete }
};

function doGet(e) {
  return jsonOutput_({ ok: true, data: { service: 'error-FA', version: SCRIPT_VERSION } });
}

function doPost(e) {
  let req;
  try {
    req = parseRequest_(e);
  } catch (err) {
    return jsonOutput_(errorEnvelope_(err));
  }

  const def = ACTIONS[req.action];
  if (!def) {
    return jsonOutput_(errorEnvelope_(new AppError('NOT_FOUND', '不支援的操作：' + req.action)));
  }

  const isMutating = !!MUTATING_ACTIONS[req.action];
  const idemKey = (isMutating && req.requestId) ? ('reqid:' + req.action + ':' + req.requestId) : null;

  if (idemKey) {
    const cached = CacheService.getScriptCache().get(idemKey);
    if (cached) {
      return jsonOutput_(JSON.parse(cached));
    }
  }

  let envelope;
  try {
    const user = def.auth ? requireAuth(req) : null;
    const data = def.handler(user, req.payload, req);
    envelope = { ok: true, data: data };
  } catch (err) {
    envelope = errorEnvelope_(err);
  }

  // 只快取「成功」的結果。失敗不能快取——前端在 session 逾期時會重新登入、
  // 然後帶「同一個 requestId」重送；若把 UNAUTHENTICATED 也快取起來，
  // 重送會直接拿到快取的錯誤，使用者就再也送不出去了。
  if (idemKey && envelope.ok) {
    try {
      CacheService.getScriptCache().put(idemKey, JSON.stringify(envelope), 600);
    } catch (err) {
      console.error('idempotency cache put failed: ' + err);
    }
  }

  return jsonOutput_(envelope);
}

function parseRequest_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw new AppError('BAD_REQUEST', '缺少請求內容');
  }
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    throw new AppError('BAD_REQUEST', '請求格式不是合法的 JSON');
  }
  const action = body.action;
  if (!action || typeof action !== 'string') {
    throw new AppError('BAD_REQUEST', '缺少 action');
  }
  return {
    action: action,
    token: body.token || '',
    requestId: body.requestId || '',
    payload: (body.payload && typeof body.payload === 'object') ? body.payload : {}
  };
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function errorEnvelope_(err) {
  if (err instanceof AppError) {
    return { ok: false, error: { code: err.code, message: err.message } };
  }
  console.error(err && err.stack ? err.stack : err);
  return { ok: false, error: { code: 'INTERNAL', message: '系統發生未預期的錯誤，請稍後再試' } };
}

/**
 * buildBoot_ — 開站時一次把首頁要的東西全部包好。
 *
 * 為什麼要合併：Apps Script 的 /exec 每次往返固定 ~1.15 秒（實測，其中大半是
 * 回應前那個 302 轉址），跟後端做了多少事幾乎無關。原本開站要跑
 * session.resume → cases.stats → cases.list → meta.bootstrap 四趟、而且前兩趟
 * 是串行的，光固定成本就 3.5 秒以上。合併成一趟之後固定成本只剩一份。
 */
function buildBoot_(user, listPayload) {
  return {
    stats: casesStats(user, {}),
    list: casesList(user, listPayload || {}),
    meta: metaBootstrap(user, {})
  };
}

/**
 * meta.bootstrap — 前端登入後第一次要拿的靜態設定資料：
 * 案件類型／狀態清單（來自 Config，可不改程式碼調整）、可指派的成員名單、Sheets 網址。
 */
function metaBootstrap(user, payload) {
  const caseTypesRaw = getConfig('caseTypes');
  const statusesRaw = getConfig('statuses');
  const caseTypes = caseTypesRaw ? caseTypesRaw.split(',') : CASE_TYPES;
  const statuses = statusesRaw ? statusesRaw.split(',') : CASE_STATUSES;

  const members = readAll('Members')
    .filter(function (m) { return !(m.active === false || String(m.active).toUpperCase() === 'FALSE'); })
    .map(function (m) {
      return { email: m.email, name: m.name || m.email, dept: m.dept || '', role: m.role || 'staff' };
    });

  return {
    caseTypes: caseTypes,
    statuses: statuses,
    members: members,
    config: { sheetUrl: getSS().getUrl() }
  };
}
