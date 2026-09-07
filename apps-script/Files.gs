/**
 * Files.gs — 附件（Drive）相關邏輯：attachments.upload / thumb / delete，
 * 以及 cases.create / comments.create 內建的批次附件儲存 saveAttachments()。
 *
 * 大小上限（實測值，非官方文件保證的數字，寫在 README 提醒之後測試要重新確認）：
 *  - 圖片（mimeType 開頭 image/）：10MB —— 前端已先壓縮到長邊 ≤1600px、JPEG q0.8，
 *    手機照片壓完通常 <800KB，10MB 留了很大安全邊際。
 *  - 其他檔案：5MB —— Apps Script 單次 POST body 用 base64 夾帶檔案，
 *    可靠的單次上限大約落在 5MB base64 左右，超過容易整支請求悄悄失敗，先在這裡擋掉。
 */

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

function isImageMime_(mimeType) {
  return String(mimeType || '').indexOf('image/') === 0;
}

/**
 * 附件一律「軟刪除」：Attachments 那一列留著、Drive 檔案也不丟垃圾桶。
 *
 * 這是刻意的——需求是「換過的圖要看得到舊的」。把 Drive 檔案 setTrashed(true)
 * 之後縮圖與檢視連結會一起失效，歷程紀錄就只剩一行沒有圖的文字，等於沒留到。
 * 代價是 Drive 空間不會因為移除附件而釋放，真的要清掉必須到 Drive 手動刪。
 */
function isAttachmentDeleted_(row) {
  return row.isDeleted === true || String(row.isDeleted).toUpperCase() === 'TRUE';
}

function validateAttachmentSize_(mimeType, decodedLength, fileName) {
  const isImage = isImageMime_(mimeType);
  const limit = isImage ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
  if (decodedLength > limit) {
    const limitLabel = isImage ? '10MB' : '5MB';
    throw new AppError('BAD_REQUEST', '附件「' + fileName + '」超過上限（' + limitLabel + '）');
  }
}

function getOrCreateCaseFolder_(caseId) {
  const rootId = getConfig('driveRootFolderId');
  if (!rootId) {
    throw new AppError('INTERNAL', '尚未在 Config 設定 driveRootFolderId');
  }
  const root = DriveApp.getFolderById(rootId);
  const existing = root.getFoldersByName(caseId);
  if (existing.hasNext()) return existing.next();
  return root.createFolder(caseId);
}

/**
 * 內部共用：把 base64 附件陣列存進 Drive（每案一個子資料夾）+ 寫入 Attachments 分頁。
 * 分享模式固定「網域內知道連結者可檢視」，外部人拿到連結也打不開。
 * 回傳存好的 Attachments sheet row 陣列（原始欄位名，attId 不是 attachmentId）。
 */
function saveAttachments(caseId, commentId, attachments, user) {
  const folder = getOrCreateCaseFolder_(caseId);
  const saved = [];

  attachments.forEach(function (att) {
    if (!att || !att.dataBase64 || !att.fileName) {
      throw new AppError('BAD_REQUEST', '附件資料不完整');
    }
    const decoded = Utilities.base64Decode(att.dataBase64);
    validateAttachmentSize_(att.mimeType, decoded.length, att.fileName);

    const mimeType = att.mimeType || 'application/octet-stream';
    const blob = Utilities.newBlob(decoded, mimeType, att.fileName);
    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW);

    const row = {
      attId: 'A-' + Utilities.getUuid(),
      caseId: caseId,
      commentId: commentId || '',
      fileName: att.fileName,
      mimeType: mimeType,
      size: decoded.length,
      driveFileId: file.getId(),
      viewUrl: 'https://drive.google.com/file/d/' + file.getId() + '/view',
      thumbUrl: 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w400',
      uploadedBy: user ? user.email : '',
      uploadedAt: nowIso_(),
      isDeleted: false,
      deletedAt: '',
      deletedBy: ''
    };
    appendRow('Attachments', row);
    saved.push(row);
  });

  return saved;
}

/** Attachments 分頁的 row → 對外 API 用的 DTO：attId 改名 attachmentId，並補上 uploadedByName。 */
function toAttachmentDTO_(row) {
  return {
    attachmentId: row.attId,
    caseId: row.caseId,
    commentId: row.commentId || '',
    fileName: row.fileName,
    mimeType: row.mimeType,
    size: row.size,
    viewUrl: row.viewUrl,
    thumbUrl: row.thumbUrl,
    uploadedBy: row.uploadedBy,
    uploadedByName: resolveDisplayName_(row.uploadedBy),
    uploadedAt: row.uploadedAt,
    isDeleted: isAttachmentDeleted_(row),
    deletedAt: row.deletedAt || '',
    deletedBy: row.deletedBy || '',
    deletedByName: row.deletedBy ? resolveDisplayName_(row.deletedBy) : ''
  };
}

/**
 * Attachments 分頁沒有存姓名，只好用 email 去別的地方找：
 * Members 名單 → 這個人開過的案件 → 這個人留過的言 → 都找不到就用 email @ 前半截。
 */
function resolveDisplayName_(email) {
  if (!email) return '';
  const member = findMemberByEmail_(email);
  if (member && member.name) return member.name;

  const fromCase = readAll('Cases').find(function (c) { return c.createdBy === email; });
  if (fromCase && fromCase.createdByName) return fromCase.createdByName;

  const fromComment = readAll('Comments').find(function (c) { return c.authorEmail === email; });
  if (fromComment && fromComment.authorName) return fromComment.authorName;

  return String(email).split('@')[0];
}

/** attachments.upload：針對已存在的案件單獨上傳一個檔案（不像 cases.create/comments.create 是批次夾帶）。 */
function attachmentsUpload(user, payload) {
  payload = payload || {};
  const caseId = payload.caseId;
  if (!caseId) throw new AppError('BAD_REQUEST', '缺少 caseId');
  if (!payload.fileName || !payload.dataBase64) {
    throw new AppError('BAD_REQUEST', '附件資料不完整');
  }

  const caseRow = getRowById('Cases', 'caseId', caseId);
  if (!caseRow) throw new AppError('NOT_FOUND', '找不到案件：' + caseId);

  // 掛在案件上的附件算「內容」，只有開單人（與 admin）能加；
  // 掛在留言下的則看留言是不是本人寫的。別人要補充照片請直接發留言。
  if (payload.commentId) {
    const commentRow = getRowById('Comments', 'commentId', payload.commentId);
    if (!commentRow) throw new AppError('NOT_FOUND', '找不到留言：' + payload.commentId);
    if (!(user.role === 'admin' || sameEmail_(user.email, commentRow.authorEmail))) {
      throw new AppError('FORBIDDEN', '沒有權限在這則留言下加附件');
    }
  } else if (!canEditCaseContent(user, caseRow)) {
    throw new AppError('FORBIDDEN', '只有開單人可以加案件附件，請改用留言附檔');
  }

  const saved = saveAttachments(caseId, payload.commentId || '', [{
    fileName: payload.fileName,
    mimeType: payload.mimeType,
    dataBase64: payload.dataBase64
  }], user);

  updateRowById('Cases', 'caseId', caseId, {
    attachmentCount: Number(caseRow.attachmentCount || 0) + saved.length,
    lastActivityAt: nowIso_()
  });

  // 掛在留言底下的附件由留言本身負責交代，只有直接掛在案件上的才寫入案件歷程
  if (!payload.commentId) {
    appendRow('History', makeHistory_(caseId, user, 'attachment.add', {
      to: saved[0].fileName, refId: saved[0].attId
    }));
  }

  return { attachment: toAttachmentDTO_(saved[0]) };
}

/** attachments.thumb：Drive 縮圖在網域分享狀態下若顯示不穩，前端可以退而求其次改叫這個拿 base64。 */
function attachmentsThumb(user, payload) {
  payload = payload || {};
  const attachmentId = payload.attachmentId;
  if (!attachmentId) throw new AppError('BAD_REQUEST', '缺少 attachmentId');

  const row = getRowById('Attachments', 'attId', attachmentId);
  if (!row) throw new AppError('NOT_FOUND', '找不到附件：' + attachmentId);

  const file = DriveApp.getFileById(row.driveFileId);

  // 先拿 Drive 產好的縮圖（通常只有幾十 KB）。這條路徑本來就是「直連縮圖載不出來」
  // 才會走的退路，如果直接回原圖 base64，一張 3MB 的照片會變成 4MB 的回應，
  // 慢到不如不要退。只有 Drive 還沒產出縮圖時才退回原檔。
  let blob = null;
  try {
    blob = file.getThumbnail();
  } catch (err) {
    blob = null;
  }
  if (!blob) blob = file.getBlob();

  return {
    mimeType: blob.getContentType() || row.mimeType,
    dataBase64: Utilities.base64Encode(blob.getBytes())
  };
}

/**
 * 內部共用：把一個附件標記為已移除，並寫入案件歷程。
 * 呼叫端要自己先做權限檢查（attachments.delete 與 cases.update 的規則不同）。
 * 回傳被移除的 Attachments row；已經移除過的回傳 null（重複移除視為沒事發生）。
 */
function markAttachmentRemoved_(row, user, at) {
  if (isAttachmentDeleted_(row)) return null;
  const now = at || nowIso_();

  updateRowById('Attachments', 'attId', row.attId, {
    isDeleted: true,
    deletedAt: now,
    deletedBy: user.email
  });

  const caseRow = getRowById('Cases', 'caseId', row.caseId);
  if (caseRow) {
    updateRowById('Cases', 'caseId', row.caseId, {
      attachmentCount: Math.max(0, Number(caseRow.attachmentCount || 0) - 1),
      lastActivityAt: now
    });
  }

  if (!row.commentId) {
    appendRow('History', makeHistory_(row.caseId, user, 'attachment.remove', {
      from: row.fileName, refId: row.attId, at: now
    }));
  }

  return row;
}

/**
 * attachments.delete：軟刪除。Drive 檔案刻意「不」丟垃圾桶，
 * 這樣歷程紀錄裡的舊圖片才點得開、縮圖才載得出來（見 isAttachmentDeleted_ 的說明）。
 */
function attachmentsDelete(user, payload) {
  payload = payload || {};
  const attachmentId = payload.attachmentId;
  if (!attachmentId) throw new AppError('BAD_REQUEST', '缺少 attachmentId');

  const row = getRowById('Attachments', 'attId', attachmentId);
  if (!row) throw new AppError('NOT_FOUND', '找不到附件：' + attachmentId);

  // 上傳者可以拿掉自己上傳的檔；除此之外就是內容層權限（開單人 / admin）。
  const caseRow = getRowById('Cases', 'caseId', row.caseId);
  const allowed = sameEmail_(user.email, row.uploadedBy) ||
    (caseRow && canEditCaseContent(user, caseRow));
  if (!allowed) {
    throw new AppError('FORBIDDEN', '沒有權限移除這個附件');
  }

  markAttachmentRemoved_(row, user);
  return { ok: true };
}
