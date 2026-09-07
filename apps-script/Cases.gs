/**
 * Cases.gs — 案件（Cases 分頁）相關邏輯：cases.list / get / create / update /
 * setStatus / stats。
 */

const CASE_STATUSES = ['待處理', '處理中', '暫緩', '已結案'];
const CASE_TYPES = ['需追加採購', '廠商送錯', '料號變更', '物料異常', '其他'];

// 「其他」是唯一豁免料號必填的類型：整批包裝、廠商交期這類異常本來就不對應
// 單一料號，硬性要求只會讓開單的人隨便填一個，反而把資料弄髒。
const TYPE_WITHOUT_PART_NO = '其他';

function casesList(user, payload) {
  payload = payload || {};
  let rows = readAll('Cases');

  if (payload.status) rows = rows.filter(function (r) { return r.status === payload.status; });
  if (payload.type) rows = rows.filter(function (r) { return r.type === payload.type; });
  if (payload.mine) rows = rows.filter(function (r) { return sameEmail_(r.createdBy, user.email); });
  if (payload.q) {
    const q = String(payload.q).toLowerCase();
    rows = rows.filter(function (r) {
      return [r.title, r.partNo, r.partName, r.vendor, r.caseId].some(function (v) {
        return String(v || '').toLowerCase().indexOf(q) !== -1;
      });
    });
  }

  rows.sort(function (a, b) {
    return String(b.lastActivityAt || b.createdAt).localeCompare(String(a.lastActivityAt || a.createdAt));
  });

  const limit = Math.min(Number(payload.limit) || 50, 200);
  const offset = Math.max(0, Number(payload.offset) || 0);
  const page = rows.slice(offset, offset + limit);

  const pageCaseIds = {};
  page.forEach(function (r) { pageCaseIds[r.caseId] = true; });
  const thumbsByCase = groupImageAttachmentsByCase_(pageCaseIds);

  // 列表頁不回傳全文描述，減少流量；每張卡最多帶 3 張圖片縮圖
  const items = page.map(function (r) {
    const copy = Object.assign({}, r);
    delete copy.description;
    copy.thumbs = thumbsByCase[r.caseId] || [];
    return copy;
  });

  const out = { items: items, total: rows.length };
  // 篩選條件一改，統計卡也要跟著更新。與其讓前端再跑一趟（固定成本 ~1.15 秒），
  // 不如順手算完一起回去——反正 Cases 這張表在同一個請求裡已經讀進記憶體了。
  if (payload.withStats) out.stats = casesStats(user, {});
  return out;
}

/** 只挑圖片附件，依案號分組、依上傳時間新到舊排序，每案最多留 3 張，給列表卡片當縮圖用。 */
function groupImageAttachmentsByCase_(caseIdFilter) {
  const all = readAll('Attachments');
  const map = {};
  all.forEach(function (a) {
    if (caseIdFilter && !caseIdFilter[a.caseId]) return;
    if (isAttachmentDeleted_(a)) return;
    if (!isImageMime_(a.mimeType)) return;
    if (!map[a.caseId]) map[a.caseId] = [];
    map[a.caseId].push(a);
  });
  Object.keys(map).forEach(function (caseId) {
    map[caseId] = map[caseId]
      .sort(function (x, y) { return String(y.uploadedAt).localeCompare(String(x.uploadedAt)); })
      .slice(0, 3)
      .map(function (a) {
        return { attachmentId: a.attId, thumbUrl: a.thumbUrl, fileName: a.fileName, mimeType: a.mimeType };
      });
  });
  return map;
}

function toHistoryDTO_(row) {
  return {
    histId: row.histId,
    at: row.at,
    actorEmail: row.actorEmail,
    actorName: row.actorName,
    action: row.action,
    fromValue: row.fromValue,
    toValue: row.toValue,
    note: row.note,
    refId: row.refId || ''
  };
}

function casesGet(user, payload) {
  payload = payload || {};
  const caseId = payload.caseId;
  if (!caseId) throw new AppError('BAD_REQUEST', '缺少 caseId');

  const caseRow = getRowById('Cases', 'caseId', caseId);
  if (!caseRow) throw new AppError('NOT_FOUND', '找不到案件：' + caseId);

  // 已軟刪除的留言完全不回傳；掛在被刪留言底下的附件也一併隱藏
  const deletedCommentIds = {};
  const comments = readAll('Comments')
    .filter(function (c) { return c.caseId === caseId; })
    .filter(function (c) {
      const isDel = c.isDeleted === true || String(c.isDeleted).toUpperCase() === 'TRUE';
      if (isDel) deletedCommentIds[c.commentId] = true;
      return !isDel;
    })
    .sort(function (a, b) { return String(a.createdAt).localeCompare(String(b.createdAt)); });

  const caseAttachments = readAll('Attachments')
    .filter(function (a) { return a.caseId === caseId; })
    .filter(function (a) { return !a.commentId || !deletedCommentIds[a.commentId]; });

  const attachments = caseAttachments
    .filter(function (a) { return !isAttachmentDeleted_(a); })
    .map(toAttachmentDTO_);

  // 已移除的附件不進主畫面，但一定要回傳——歷程紀錄要靠它把「當時那張圖」畫出來
  const removedAttachments = caseAttachments
    .filter(isAttachmentDeleted_)
    .map(toAttachmentDTO_);

  const history = readAll('History')
    .filter(function (h) { return h.caseId === caseId; })
    .sort(function (a, b) { return String(a.at).localeCompare(String(b.at)); }) // 舊到新
    .map(toHistoryDTO_);

  return {
    case: caseRow,
    comments: comments,
    attachments: attachments,
    removedAttachments: removedAttachments,
    history: history,
    permissions: {
      canSetStatus: canSetStatus(user, caseRow),
      canEditCase: canEditCase(user, caseRow),
      canEditContent: canEditCaseContent(user, caseRow)
    }
  };
}

/** 取下一個案號：FA-<年度>-<4碼流水號>，年度變了流水號自動歸零。用 LockService 避免撞號。 */
function nextCaseId_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    throw new AppError('CONFLICT', '系統忙碌中，請稍後再試（取得案號逾時）');
  }
  try {
    const year = new Date().getFullYear();
    const raw = String(getConfig('lastCaseSeq') || '');
    let storedYear = year;
    let seq = 0;
    if (raw.indexOf(':') !== -1) {
      const parts = raw.split(':');
      storedYear = Number(parts[0]);
      seq = Number(parts[1]) || 0;
    }
    if (storedYear !== year) seq = 0;
    seq += 1;
    setConfig('lastCaseSeq', year + ':' + seq);
    const padded = ('0000' + seq).slice(-4);
    return 'FA-' + year + '-' + padded;
  } finally {
    lock.releaseLock();
  }
}

function casesCreate(user, payload) {
  payload = payload || {};
  const type = payload.type;
  // 標題改為選填：現場開單時料號才是關鍵識別，標題常常只是重複料號。
  // 空白時前端會退而顯示料號（見 app.js 的 caseLabel）。
  const title = payload.title ? String(payload.title).trim() : '';
  const partNo = payload.partNo ? String(payload.partNo).trim() : '';
  const description = payload.description;

  if (!type || CASE_TYPES.indexOf(type) === -1) {
    throw new AppError('BAD_REQUEST', '案件類型不正確');
  }
  if (!partNo && type !== TYPE_WITHOUT_PART_NO) {
    throw new AppError('BAD_REQUEST', '請填寫料號（類型選「' + TYPE_WITHOUT_PART_NO + '」時可不填）');
  }
  if (description === undefined || description === null || !String(description).trim()) {
    throw new AppError('BAD_REQUEST', '請填寫描述');
  }
  if (String(description).length > MAX_TEXT_LEN) {
    throw new AppError('BAD_REQUEST', '描述內容過長（上限 ' + MAX_TEXT_LEN + ' 字）');
  }

  const caseId = nextCaseId_();
  const now = nowIso_();

  const caseRow = {
    caseId: caseId,
    createdAt: now,
    createdBy: user.email,
    createdByName: user.name,
    dept: user.dept || '',
    type: type,
    title: title,
    partNo: partNo,
    partName: payload.partName || '',
    vendor: payload.vendor || '',
    poNo: payload.poNo || '',
    qty: payload.qty || '',
    unit: payload.unit || '',
    needByDate: payload.needByDate || '',
    description: description,
    status: '待處理',
    assignee: '',
    assigneeName: '',
    lastActivityAt: now,
    closedAt: '',
    closedBy: '',
    resolution: '',
    commentCount: 0,
    attachmentCount: 0
  };

  appendRow('Cases', caseRow);

  appendRow('History', makeHistory_(caseId, user, 'create', { to: '待處理', at: now }));

  if (Array.isArray(payload.attachments) && payload.attachments.length > 0) {
    const saved = saveAttachments(caseId, '', payload.attachments, user);
    if (saved.length > 0) {
      caseRow.attachmentCount = saved.length;
      updateRowById('Cases', 'caseId', caseId, { attachmentCount: saved.length });
    }
  }

  try {
    notifyNewCase(caseRow, user);
  } catch (err) {
    console.error('notifyNewCase failed: ' + err);
  }

  return { case: caseRow };
}

/*
 * cases.update 允許改的欄位，依權限分兩組（見 Auth.gs 的兩層權限說明）。
 * 順序就是寫進 History 的順序，挑成跟開單表單一樣，歷程讀起來才不會跳來跳去。
 * 狀態兩組都不在——它有自己的通知信，走 cases.setStatus。
 */

/** 內容：開單人回報的事實。需要 canEditCaseContent（個人改個人的單）。附件也算在這一級。 */
const CASE_CONTENT_FIELDS = ['type', 'title', 'partNo', 'partName', 'vendor', 'poNo',
  'qty', 'unit', 'needByDate', 'description'];

/** 處理：廠務部接手之後填的。需要 canEditCase。 */
const CASE_HANDLING_FIELDS = ['assignee', 'resolution'];

const CASE_EDITABLE_FIELDS = CASE_CONTENT_FIELDS.concat(CASE_HANDLING_FIELDS);

function findMemberByEmail_(email) {
  const target = String(email).toLowerCase();
  const members = readAll('Members');
  for (let i = 0; i < members.length; i++) {
    if (String(members[i].email || '').toLowerCase() === target) return members[i];
  }
  return null;
}

/**
 * 比較「有沒有真的改到」用的正規化。
 *
 * 兩個坑：
 *  - Sheets 會把 2026-09-07 這種字串吃成日期值，readAll 再吐回 ISO 字串，
 *    跟前端送來的 yyyy-MM-dd 直接比會每次都判定成「改過」，歷程就會長出一堆假紀錄。
 *    而且不能直接切 ISO 的前 10 碼：台北時間 9/7 零時的 ISO 是 09-06T16:00Z，
 *    切出來會差一天，所以要用專案時區重新格式化。
 *  - 數量欄同理，5 與 '5' 要視為相同。
 */
function normalizeForCompare_(field, value) {
  const s = String(value === undefined || value === null ? '' : value).trim();
  if (field === 'needByDate' && /^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
      return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    }
    return s.slice(0, 10);
  }
  return s;
}

/**
 * cases.update：編輯案件內容。
 *
 * payload: {
 *   caseId,
 *   patch: { 欄位 → 新值 }            // 只能是 CASE_EDITABLE_FIELDS
 *   addAttachments: [{fileName, mimeType, dataBase64}]
 *   removeAttachmentIds: [attId]
 *   note: '這次修改的原因'
 * }
 *
 * 欄位、加檔、移除檔合併在同一個 action 裡，是因為 Apps Script 的 /exec 每趟往返
 * 固定 ~1.15 秒；換一張圖若拆成三個請求，使用者要等三倍時間。
 *
 * 每一項變更都會寫進 History：欄位一個變更一列（存得下舊值全文），
 * 附件則是 attachment.add / attachment.remove 各一列並用 refId 指回那個附件，
 * 所以「換過的圖」在歷程裡點得開舊的那張。
 */
function casesUpdate(user, payload) {
  payload = payload || {};
  const caseId = payload.caseId;
  if (!caseId) throw new AppError('BAD_REQUEST', '缺少 caseId');

  const rawPatch = payload.patch || {};
  const patch = {};
  Object.keys(rawPatch).forEach(function (k) {
    if (CASE_EDITABLE_FIELDS.indexOf(k) === -1) {
      throw new AppError('BAD_REQUEST',
        k === 'status' ? '請改用 cases.setStatus 變更狀態' : 'cases.update 不允許修改欄位：' + k);
    }
    const v = rawPatch[k];
    patch[k] = (v === undefined || v === null) ? '' : (typeof v === 'string' ? v.trim() : v);
  });

  const addAttachments = Array.isArray(payload.addAttachments) ? payload.addAttachments : [];
  const removeIds = Array.isArray(payload.removeAttachmentIds) ? payload.removeAttachmentIds : [];
  const note = payload.note ? String(payload.note).trim() : '';

  if (Object.keys(patch).length === 0 && addAttachments.length === 0 && removeIds.length === 0) {
    throw new AppError('BAD_REQUEST', '沒有要更新的內容');
  }
  ['description', 'resolution', 'title'].forEach(function (f) {
    if (patch[f] !== undefined && String(patch[f]).length > MAX_TEXT_LEN) {
      throw new AppError('BAD_REQUEST', '內容過長（上限 ' + MAX_TEXT_LEN + ' 字）');
    }
  });
  if (note.length > MAX_TEXT_LEN) {
    throw new AppError('BAD_REQUEST', '修改原因過長（上限 ' + MAX_TEXT_LEN + ' 字）');
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    throw new AppError('CONFLICT', '系統忙碌中，請稍後再試');
  }
  try {
    const caseRow = getRowById('Cases', 'caseId', caseId);
    if (!caseRow) throw new AppError('NOT_FOUND', '找不到案件：' + caseId);

    // 兩層權限分開檢：廠務部可以接手處理別人的單，
    // 但不能改別人回報的事實（含附件），要補充請用留言。
    const patchKeys = Object.keys(patch);
    const touchesContent = addAttachments.length > 0 || removeIds.length > 0 ||
      patchKeys.some(function (k) { return CASE_CONTENT_FIELDS.indexOf(k) !== -1; });
    const touchesHandling =
      patchKeys.some(function (k) { return CASE_HANDLING_FIELDS.indexOf(k) !== -1; });

    if (touchesContent && !canEditCaseContent(user, caseRow)) {
      throw new AppError('FORBIDDEN', '案件內容只有開單人可以修改，請改用留言補充');
    }
    if (touchesHandling && !canEditCase(user, caseRow)) {
      throw new AppError('FORBIDDEN', '沒有權限修改這張案件');
    }

    // 必填規則要拿「改完之後的樣子」來驗，不能只看 patch——
    // 只改類型的請求也可能讓原本合法的料號變成不合法（反之亦然）。
    const merged = Object.assign({}, caseRow, patch);
    if (CASE_TYPES.indexOf(merged.type) === -1) {
      throw new AppError('BAD_REQUEST', '案件類型不正確');
    }
    if (!String(merged.partNo || '').trim() && merged.type !== TYPE_WITHOUT_PART_NO) {
      throw new AppError('BAD_REQUEST', '請填寫料號（類型選「' + TYPE_WITHOUT_PART_NO + '」時可不填）');
    }
    if (!String(merged.description || '').trim()) {
      throw new AppError('BAD_REQUEST', '請填寫描述');
    }

    const now = nowIso_();
    const historyRows = [];

    // ── 欄位變更
    const changed = {};
    CASE_EDITABLE_FIELDS.forEach(function (field) {
      if (!Object.prototype.hasOwnProperty.call(patch, field)) return;
      if (normalizeForCompare_(field, patch[field]) === normalizeForCompare_(field, caseRow[field])) return;
      changed[field] = patch[field];
      historyRows.push(makeHistory_(caseId, user, field, {
        from: caseRow[field], to: patch[field], note: note, at: now
      }));
    });

    // ── 先把要移除的附件都找出來驗過（還沒寫任何東西）。
    // Sheets 沒有交易，一旦開始寫就回不去了，所以所有會丟錯誤的檢查
    // 都要採到第一個寫入動作之前。
    const toRemove = [];
    const seenRemove = {};
    removeIds.forEach(function (attId) {
      if (seenRemove[attId]) return;   // 重複的 id 只算一次，不然 attachmentCount 會多扣
      seenRemove[attId] = true;
      const attRow = getRowById('Attachments', 'attId', attId);
      if (!attRow) throw new AppError('NOT_FOUND', '找不到附件：' + attId);
      if (attRow.caseId !== caseId) {
        throw new AppError('BAD_REQUEST', '附件不屬於這張案件：' + attId);
      }
      toRemove.push(attRow);
    });

    // ── 新增附件。排在移除之前：檔案太大、Drive 寫失敗都是這裡丟錯誤，
    // 排在後面的話一旦失敗，舊圖已經被拿掉但新圖沒進來。
    let added = [];
    if (addAttachments.length > 0) {
      added = saveAttachments(caseId, '', addAttachments, user);
      added.forEach(function (a) {
        historyRows.push(makeHistory_(caseId, user, 'attachment.add', {
          to: a.fileName, refId: a.attId, note: note, at: now
        }));
      });
    }

    // ── 移除附件（軟刪除，Drive 檔案留著，舊圖才看得到）
    // markAttachmentRemoved_ 會自己寫 History 與調整 attachmentCount
    const removed = [];
    toRemove.forEach(function (attRow) {
      if (markAttachmentRemoved_(attRow, user, now)) removed.push(attRow);
    });

    // ── 寫回 Cases
    // attachmentCount 在上面兩段已經被 markAttachmentRemoved_ 動過，
    // 所以這裡要重讀一次再加上新增的數量，不能拿最一開始的 caseRow 來算。
    const fresh = getRowById('Cases', 'caseId', caseId) || caseRow;
    const writePatch = Object.assign({}, changed, { lastActivityAt: now });
    if (added.length > 0) {
      writePatch.attachmentCount = Number(fresh.attachmentCount || 0) + added.length;
    }
    if (Object.prototype.hasOwnProperty.call(changed, 'assignee')) {
      const assigneeUser = changed.assignee ? findMemberByEmail_(changed.assignee) : null;
      writePatch.assigneeName = assigneeUser ? assigneeUser.name : (changed.assignee || '');
    }

    const updated = updateRowById('Cases', 'caseId', caseId, writePatch);
    historyRows.forEach(function (h) { appendRow('History', h); });

    return {
      case: updated,
      changedFields: Object.keys(changed),
      addedAttachments: added.map(toAttachmentDTO_),
      removedAttachmentIds: removed.map(function (r) { return r.attId; })
    };
  } finally {
    lock.releaseLock();
  }
}

/** cases.setStatus：獨立於 cases.update，因為狀態變更有自己的權限規則且一定要留 History。 */
function casesSetStatus(user, payload) {
  payload = payload || {};
  const caseId = payload.caseId;
  const status = payload.status;
  const note = payload.note || '';

  if (!caseId) throw new AppError('BAD_REQUEST', '缺少 caseId');
  if (!status || CASE_STATUSES.indexOf(status) === -1) {
    throw new AppError('BAD_REQUEST', '狀態不正確');
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    throw new AppError('CONFLICT', '系統忙碌中，請稍後再試');
  }
  try {
    const caseRow = getRowById('Cases', 'caseId', caseId);
    if (!caseRow) throw new AppError('NOT_FOUND', '找不到案件：' + caseId);
    if (!canSetStatus(user, caseRow)) {
      throw new AppError('FORBIDDEN', '沒有權限變更這張案件的狀態');
    }
    if (status === '已結案' && !String(caseRow.resolution || '').trim()) {
      throw new AppError('BAD_REQUEST', '結案前請先用 cases.update 填寫處理結果（resolution）');
    }

    const now = nowIso_();
    const writePatch = { status: status, lastActivityAt: now };

    if (status === '已結案' && caseRow.status !== '已結案') {
      writePatch.closedAt = now;
      writePatch.closedBy = user.email;
    } else if (status !== '已結案' && caseRow.status === '已結案') {
      // 重新開單：清掉舊的結案紀錄，避免殘留資料造成誤判
      writePatch.closedAt = '';
      writePatch.closedBy = '';
    }

    const updated = updateRowById('Cases', 'caseId', caseId, writePatch);

    const historyRow = makeHistory_(caseId, user, 'status', {
      from: caseRow.status, to: status, note: note, at: now
    });
    appendRow('History', historyRow);

    if (status !== caseRow.status) {
      try {
        notifyStatusChange(caseRow, updated, user);
      } catch (err) {
        console.error('notifyStatusChange failed: ' + err);
      }
    }

    return { case: updated, historyEntry: toHistoryDTO_(historyRow) };
  } finally {
    lock.releaseLock();
  }
}

function casesStats(user, payload) {
  const rows = readAll('Cases');
  const out = { 待處理: 0, 處理中: 0, 暫緩: 0, 已結案: 0, total: rows.length };
  rows.forEach(function (r) {
    if (Object.prototype.hasOwnProperty.call(out, r.status)) out[r.status]++;
  });
  return out;
}
