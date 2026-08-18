/**
 * Cases.gs — 案件（Cases 分頁）相關邏輯：cases.list / get / create / update /
 * setStatus / stats。
 */

const CASE_STATUSES = ['待處理', '處理中', '暫緩', '已結案'];
const CASE_TYPES = ['需追加採購', '廠商送錯', '料號變更', '物料異常', '其他'];

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

  return { items: items, total: rows.length };
}

/** 只挑圖片附件，依案號分組、依上傳時間新到舊排序，每案最多留 3 張，給列表卡片當縮圖用。 */
function groupImageAttachmentsByCase_(caseIdFilter) {
  const all = readAll('Attachments');
  const map = {};
  all.forEach(function (a) {
    if (caseIdFilter && !caseIdFilter[a.caseId]) return;
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
    note: row.note
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

  const attachments = readAll('Attachments')
    .filter(function (a) { return a.caseId === caseId; })
    .filter(function (a) { return !a.commentId || !deletedCommentIds[a.commentId]; })
    .map(toAttachmentDTO_);

  const history = readAll('History')
    .filter(function (h) { return h.caseId === caseId; })
    .sort(function (a, b) { return String(a.at).localeCompare(String(b.at)); }) // 舊到新
    .map(toHistoryDTO_);

  return {
    case: caseRow,
    comments: comments,
    attachments: attachments,
    history: history,
    permissions: {
      canSetStatus: canSetStatus(user, caseRow),
      canEditCase: canEditCase(user, caseRow)
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
  const title = payload.title && String(payload.title).trim();
  const description = payload.description;

  if (!type || CASE_TYPES.indexOf(type) === -1) {
    throw new AppError('BAD_REQUEST', '案件類型不正確');
  }
  if (!title) {
    throw new AppError('BAD_REQUEST', '請填寫標題');
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
    partNo: payload.partNo || '',
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

  appendRow('History', {
    histId: 'H-' + Utilities.getUuid(),
    caseId: caseId,
    at: now,
    actorEmail: user.email,
    actorName: user.name,
    action: 'create',
    fromValue: '',
    toValue: '待處理',
    note: ''
  });

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

const CASE_UPDATE_ALLOWED_FIELDS = ['assignee', 'resolution'];

function findMemberByEmail_(email) {
  const target = String(email).toLowerCase();
  const members = readAll('Members');
  for (let i = 0; i < members.length; i++) {
    if (String(members[i].email || '').toLowerCase() === target) return members[i];
  }
  return null;
}

/** cases.update：只改一般欄位（目前是 assignee / resolution）。狀態變更請走 cases.setStatus。 */
function casesUpdate(user, payload) {
  payload = payload || {};
  const caseId = payload.caseId;
  if (!caseId) throw new AppError('BAD_REQUEST', '缺少 caseId');

  const rawPatch = payload.patch || {};
  const patch = {};
  Object.keys(rawPatch).forEach(function (k) {
    if (CASE_UPDATE_ALLOWED_FIELDS.indexOf(k) === -1) {
      throw new AppError('BAD_REQUEST',
        k === 'status' ? '請改用 cases.setStatus 變更狀態' : 'cases.update 不允許修改欄位：' + k);
    }
    patch[k] = rawPatch[k];
  });
  if (Object.keys(patch).length === 0) {
    throw new AppError('BAD_REQUEST', '沒有要更新的欄位');
  }
  if (patch.resolution !== undefined && String(patch.resolution).length > MAX_TEXT_LEN) {
    throw new AppError('BAD_REQUEST', '處理結果內容過長（上限 ' + MAX_TEXT_LEN + ' 字）');
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    throw new AppError('CONFLICT', '系統忙碌中，請稍後再試');
  }
  try {
    const caseRow = getRowById('Cases', 'caseId', caseId);
    if (!caseRow) throw new AppError('NOT_FOUND', '找不到案件：' + caseId);
    if (!canEditCase(user, caseRow)) {
      throw new AppError('FORBIDDEN', '沒有權限修改這張案件');
    }

    const now = nowIso_();
    const writePatch = Object.assign({}, patch, { lastActivityAt: now });

    if (patch.assignee !== undefined) {
      const assigneeUser = patch.assignee ? findMemberByEmail_(patch.assignee) : null;
      writePatch.assigneeName = assigneeUser ? assigneeUser.name : (patch.assignee || '');
    }

    const historyRows = [];
    ['assignee', 'resolution'].forEach(function (field) {
      if (Object.prototype.hasOwnProperty.call(patch, field) &&
        String(patch[field] || '') !== String(caseRow[field] || '')) {
        historyRows.push({
          histId: 'H-' + Utilities.getUuid(),
          caseId: caseId,
          at: now,
          actorEmail: user.email,
          actorName: user.name,
          action: field,
          fromValue: caseRow[field] || '',
          toValue: patch[field] || '',
          note: ''
        });
      }
    });

    const updated = updateRowById('Cases', 'caseId', caseId, writePatch);
    historyRows.forEach(function (h) { appendRow('History', h); });

    return { case: updated };
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

    const historyRow = {
      histId: 'H-' + Utilities.getUuid(),
      caseId: caseId,
      at: now,
      actorEmail: user.email,
      actorName: user.name,
      action: 'status',
      fromValue: caseRow.status,
      toValue: status,
      note: note
    };
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
