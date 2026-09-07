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
 *   4. 角色一律重查 Members 分頁，不信任 session 裡存的舊角色，這樣管理員在
 *      Sheet 改權限不用等 session 過期就會生效（查詢本身有 60 秒快取，見
 *      ROLE_CACHE_TTL_SEC，所以實際上最慢一分鐘生效）。
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
const ROLE_CACHE_TTL_SEC = 60;   // 角色改了最多 60 秒生效，換來每個請求少讀一整張 Members

/**
 * resolveUser 會被「每一個」請求呼叫，而它要讀整張 Members。
 * 用 CacheService 快取 60 秒：管理員在 Sheet 改角色，最慢一分鐘生效，
 * 這個延遲對權限調整來說完全可以接受，但省下的是每個請求一次整表讀取。
 */
function resolveUser(profile) {
  const email = String(profile.email).toLowerCase();
  const cache = CacheService.getScriptCache();
  const cacheKey = 'role_' + email;

  const hit = cache.get(cacheKey);
  if (hit) {
    const cached = JSON.parse(hit);
    if (cached.inactive) {
      throw new AppError('FORBIDDEN', '這個帳號已被停用，請聯絡系統管理員');
    }
    // name 以當下 token 帶來的為準，其餘用快取的
    return { email: profile.email, name: cached.name || profile.name || profile.email,
             dept: cached.dept, role: cached.role };
  }

  const resolved = resolveUserUncached_(profile);
  cache.put(cacheKey, JSON.stringify({ name: resolved.name, dept: resolved.dept, role: resolved.role }),
            ROLE_CACHE_TTL_SEC);
  return resolved;
}

function isMemberInactive_(m) {
  return !!m && (m.active === false || String(m.active).toUpperCase() === 'FALSE');
}

/**
 * 依 email 找 Members 的那一列。Members 名單是人工維護的，同一個 email 被貼成兩列
 * 並非不可能，而「安靜地只取第一筆」正是讓案號撞號變成整張單消失的那種失敗模式，
 * 所以這裡撞到重複要記 log，並且優先採用還在啟用中的那一列——不然名單上面剛好留了
 * 一列停用的舊資料，這個人就會被整個擋在門外，而且完全看不出原因。
 */
function findMemberRow_(email) {
  const target = String(email || '').toLowerCase();
  if (!target) return null;

  const matches = readAll('Members').filter(function (m) {
    return String(m.email || '').toLowerCase() === target;
  });
  if (matches.length <= 1) return matches[0] || null;

  console.error('Members 有重複的 email：' + target + '（共 ' + matches.length + ' 列），' +
                '請在試算表清乾淨；本次採用第一列還在啟用中的資料');
  const active = matches.filter(function (m) { return !isMemberInactive_(m); });
  return active.length ? active[0] : matches[0];
}

function resolveUserUncached_(profile) {
  const email = String(profile.email).toLowerCase();
  const match = findMemberRow_(profile.email);

  if (!match) {
    return { email: profile.email, name: profile.name || profile.email, dept: '', role: 'staff' };
  }

  if (isMemberInactive_(match)) {
    CacheService.getScriptCache().put('role_' + email, JSON.stringify({ inactive: true }),
                                      ROLE_CACHE_TTL_SEC);
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
  const match = findMemberRow_(profile.email);

  if (!match) {
    appendRow('Members', {
      email: profile.email,
      name: profile.name || profile.email,
      dept: '',
      role: 'staff',
      notify: false,
      active: true
    });
    CacheService.getScriptCache().remove('role_' + email);
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

  const out = {
    user: { email: resolved.email, name: resolved.name, role: resolved.role, dept: resolved.dept },
    sessionToken: token,
    expiresAt: new Date(exp).toISOString()
  };
  // 前端開站時一併把首頁要的東西帶回去，省掉三趟往返（見 Code.gs buildBoot_）
  if (payload.boot) out.boot = buildBoot_(resolved, payload.list);
  return out;
}

/** session.resume：requireAuth 已經驗完 session 並即時重讀 Members 角色，這裡直接回傳即可。 */
function sessionResume(user, payload) {
  payload = payload || {};
  const out = { user: { email: user.email, name: user.name, role: user.role, dept: user.dept } };
  if (payload.boot) out.boot = buildBoot_(user, payload.list);
  return out;
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

/*
 * 案件的權限分兩層，因為「單子寫了什麼」跟「單子處理到哪」是兩件事：
 *
 *   canEditCaseContent  內容：類型、料號、描述、附件……
 *                       → 個人改個人的單（開單人），admin 保留後門。
 *                       廠務部不能改別人回報的事實，要補充請用留言。
 *
 *   canEditCase         處理：承辦人、處理結果（搭配 canSetStatus 的狀態變更）
 *                       → 廠務部要能接手處理別人的單，所以比內容寬一級。
 *
 * admin 兩層都過：開單人離職或單子填錯得有人能收尾。
 */
function canEditCaseContent(user, caseRow) {
  if (!user || !caseRow) return false;
  if (user.role === 'admin') return true;
  return sameEmail_(user.email, caseRow.createdBy);
}

function canEditCase(user, caseRow) {
  if (!user || !caseRow) return false;
  if (user.role === 'admin' || user.role === 'facility') return true;
  return sameEmail_(user.email, caseRow.createdBy);
}

/** 狀態變更權限：與 canEditCase 相同（admin/facility/開單人），獨立命名方便未來拆開。 */
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
