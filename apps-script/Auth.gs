/**
 * Auth.gs — 身分驗證與 Session 管理。
 *
 * 流程：
 *   1. 前端用 Google Identity Services 登入，拿到 Google ID token
 *      （效期約 1 小時，GIS 的靜默重取不太可靠）。
 *   2. 前端呼叫 session.login，把 Google ID token「一次性」換成我們自己發的
 *      session token（效期 12 小時）。之後每個請求都帶這個 session token，
 *      不再依賴 Google token 或每次都打 tokeninfo。
 *   3. session 記錄同時放 CacheService（快，上限 6 小時）與 Script Properties
 *      （慢但撐得滿 12 小時），requireAuth 兩邊都會查，Cache 沒中才查 Properties。
 *   4. 角色一律「即時」查 Members 分頁，不信任 session 裡存的舊角色——
 *      這樣管理員在 Sheet 改權限，下一個請求就生效，不用等 session 過期。
 *
 * 絕不信任前端傳來的 email / 姓名 / 角色——一律從驗證過的 token claims
 * 或 session 記錄裡的 email 去查 Members，角色永遠從 Sheet 來。
 */

const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;   // session 總壽命 12 小時
const SESSION_CACHE_TTL_SEC = 21600;               // CacheService 單次 TTL 上限就是 6 小時
const TOKENINFO_CACHE_TTL_SEC = 300;               // 同一個 Google ID token 5 分鐘內不用重打 tokeninfo

/** SHA-256 → 十六進位字串，拿來當 Google ID token 的快取 key（不把 token 明文存進 key）。 */
function sha256Hex_(input) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, input, Utilities.Charset.UTF_8);
  return raw.map(function (b) {
    const v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

/** SHA-256 → base64 字串，拿來當 session token 的儲存 key。 */
function sha256Base64_(input) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, input, Utilities.Charset.UTF_8);
  return Utilities.base64Encode(raw);
}

/**
 * 驗證 Google ID token：aud 對得上這支程式的 CLIENT_ID、還沒過期、
 * email 已驗證、網域是 ecoco.xyz（hd claim + email 結尾雙重確認）。
 * 只在 session.login 時呼叫一次，驗證結果快取 5 分鐘。
 */
function verifyIdToken(idToken) {
  if (!idToken || typeof idToken !== 'string') {
    throw new AppError('UNAUTHENTICATED', '缺少 Google 登入憑證');
  }

  const cache = CacheService.getScriptCache();
  const cacheKey = 'tok_' + sha256Hex_(idToken);
  const hit = cache.get(cacheKey);
  if (hit) {
    return JSON.parse(hit);
  }

  const res = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
    { muteHttpExceptions: true }
  );
  if (res.getResponseCode() !== 200) {
    throw new AppError('UNAUTHENTICATED', 'Google 登入憑證無效或已過期，請重新登入');
  }

  let claims;
  try {
    claims = JSON.parse(res.getContentText());
  } catch (err) {
    throw new AppError('UNAUTHENTICATED', 'Google 登入憑證格式錯誤');
  }

  if (claims.aud !== getClientId_()) {
    throw new AppError('UNAUTHENTICATED', '登入憑證的 aud 與本系統不符');
  }
  const exp = Number(claims.exp);
  if (!exp || exp * 1000 < Date.now()) {
    throw new AppError('UNAUTHENTICATED', '登入憑證已過期，請重新登入');
  }
  // tokeninfo 回傳的 email_verified 是字串 'true'，不是布林值，兩種都接受比較保險
  if (claims.email_verified !== 'true' && claims.email_verified !== true) {
    throw new AppError('FORBIDDEN', 'Google 帳號 Email 尚未完成驗證');
  }
  const email = String(claims.email || '');
  if (claims.hd !== 'ecoco.xyz' || !email.toLowerCase().endsWith('@ecoco.xyz')) {
    throw new AppError('FORBIDDEN', '僅限 ecoco.xyz 網域帳號使用');
  }

  const profile = {
    email: email,
    name: claims.name || email,
    picture: claims.picture || ''
  };
  cache.put(cacheKey, JSON.stringify(profile), TOKENINFO_CACHE_TTL_SEC);
  return profile;
}

/**
 * 依 email 查 Members 分頁決定 role/dept：
 *  - 名單裡沒有 → 視為 staff（能登入、開單、留言，但只能改自己開的單）
 *  - 名單裡有，但 active 明確是 FALSE → 直接擋下（FORBIDDEN）
 *  - 名單裡有且 active 是 TRUE 或空白 → 用名單上的 role/dept
 */
function resolveUser(profile) {
  const members = readAll('Members');
  const email = String(profile.email).toLowerCase();
  const match = members.find(function (m) { return String(m.email || '').toLowerCase() === email; });

  if (!match) {
    return { email: profile.email, name: profile.name || profile.email, dept: '', role: 'staff' };
  }

  const isActiveFalse = match.active === false || String(match.active).toUpperCase() === 'FALSE';
  if (isActiveFalse) {
    throw new AppError('FORBIDDEN', '這個帳號已被停用，請聯絡系統管理員');
  }

  return {
    email: profile.email,
    name: match.name || profile.name || profile.email,
    dept: match.dept || '',
    role: match.role ? String(match.role) : 'staff'
  };
}

/** session.login 專用：Members 名單找不到這個人，就自動新增一列（role staff / active TRUE）。 */
function resolveOrProvisionUser_(profile) {
  const email = String(profile.email).toLowerCase();
  const members = readAll('Members');
  const match = members.find(function (m) { return String(m.email || '').toLowerCase() === email; });

  if (!match) {
    appendRow('Members', {
      email: profile.email,
      name: profile.name || profile.email,
      dept: '',
      role: 'staff',
      notify: false,
      active: true
    });
    return { email: profile.email, name: profile.name || profile.email, dept: '', role: 'staff' };
  }

  return resolveUser(profile);
}

function sessionKey_(token) {
  return 'sess_' + sha256Base64_(token);
}

function storeSession_(key, record) {
  CacheService.getScriptCache().put(key, JSON.stringify(record), SESSION_CACHE_TTL_SEC);
  PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(record));
}

function readSession_(key) {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  const raw = PropertiesService.getScriptProperties().getProperty(key);
  if (!raw) return null;

  const record = JSON.parse(raw);
  // Cache 沒中但 Properties 裡還有效 → 補回 Cache，加速下一次請求
  const remainingSec = Math.max(1, Math.floor((record.exp - Date.now()) / 1000));
  cache.put(key, raw, Math.min(remainingSec, SESSION_CACHE_TTL_SEC));
  return record;
}

function deleteSession_(key) {
  CacheService.getScriptCache().remove(key);
  PropertiesService.getScriptProperties().deleteProperty(key);
}

/** session.login：驗 Google ID token → 換成我們自己的 session token。唯一不需要 token 的認證類 action。 */
function sessionLogin(user, payload) {
  payload = payload || {};
  const profile = verifyIdToken(payload.idToken);
  const resolved = resolveOrProvisionUser_(profile);

  const token = Utilities.getUuid() + Utilities.getUuid().slice(0, 8);
  const exp = Date.now() + SESSION_LIFETIME_MS;
  const record = { email: resolved.email, name: resolved.name, role: resolved.role, exp: exp };

  storeSession_(sessionKey_(token), record);

  return {
    user: { email: resolved.email, name: resolved.name, role: resolved.role, dept: resolved.dept },
    sessionToken: token,
    expiresAt: new Date(exp).toISOString()
  };
}

/** session.resume：requireAuth 已經驗完 session 並即時重讀 Members 角色，這裡直接回傳即可。 */
function sessionResume(user) {
  return { user: { email: user.email, name: user.name, role: user.role, dept: user.dept } };
}

/** session.logout：把這個 session token 從 Cache + Properties 都刪掉。 */
function sessionLogout(user, payload, req) {
  if (req && req.token) {
    deleteSession_(sessionKey_(req.token));
  }
  return { ok: true };
}

/**
 * 每個請求的守門員：從 envelope 的 token 找 session 記錄，
 * 找不到、過期都回 UNAUTHENTICATED；角色/部門/停用狀態一律重查 Members。
 */
function requireAuth(req) {
  const token = req.token;
  if (!token) {
    throw new AppError('UNAUTHENTICATED', '缺少登入憑證，請重新登入');
  }
  const key = sessionKey_(token);
  const record = readSession_(key);
  if (!record) {
    throw new AppError('UNAUTHENTICATED', '登入已逾期或無效，請重新登入');
  }
  if (!record.exp || record.exp < Date.now()) {
    deleteSession_(key);
    throw new AppError('UNAUTHENTICATED', '登入已逾期，請重新登入');
  }
  return resolveUser({ email: record.email, name: record.name });
}

/** email 一律轉小寫再比對——Members 或 Cases 是人工填的，大小寫不一致不該讓開單人失去自己案件的權限。 */
function sameEmail_(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function canEditCase(user, caseRow) {
  if (!user || !caseRow) return false;
  if (user.role === 'admin' || user.role === 'facility') return true;
  return sameEmail_(user.email, caseRow.createdBy);
}

/** 狀態變更權限：目前規則與 canEditCase 相同（admin/facility/開單人），獨立命名方便未來拆開。 */
function canSetStatus(user, caseRow) {
  return canEditCase(user, caseRow);
}

/**
 * 供每日排程呼叫（見 Setup.gs 的 ensureDailyPurgeTrigger）：
 * 清掉 Script Properties 裡已經過期的 session，避免塞滿 500KB 上限。
 */
function purgeExpiredSessions() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const now = Date.now();
  let removed = 0;

  Object.keys(all).forEach(function (key) {
    if (key.indexOf('sess_') !== 0) return;
    try {
      const record = JSON.parse(all[key]);
      if (!record.exp || record.exp < now) {
        props.deleteProperty(key);
        removed++;
      }
    } catch (err) {
      props.deleteProperty(key); // 壞掉的資料也順便清掉
      removed++;
    }
  });

  console.log('purgeExpiredSessions removed ' + removed + ' session(s)');
  return removed;
}
