/**
 * Comments.gs — 留言（Comments 分頁）相關邏輯：comments.create / update / delete。
 * 刪除一律是軟刪除（isDeleted=true），cases.get 會把已刪除的留言整個濾掉。
 */

function commentsCreate(user, payload) {
  payload = payload || {};
  const caseId = payload.caseId;
  const body = payload.body;

  if (!caseId) throw new AppError('BAD_REQUEST', '缺少 caseId');

  // 「文字」或「附件」有一個就成立，不強制兩者都要。
  // 現場拍完照直接上傳、一個字都不打，是最常見的用法。
  const hasAttachments = Array.isArray(payload.attachments) && payload.attachments.length > 0;
  const bodyText = (body === undefined || body === null) ? '' : String(body);
  if (!bodyText.trim() && !hasAttachments) {
    throw new AppError('BAD_REQUEST', '請輸入內容，或附加至少一個檔案');
  }
  if (bodyText.length > MAX_TEXT_LEN) {
    throw new AppError('BAD_REQUEST', '留言內容過長（上限 ' + MAX_TEXT_LEN + ' 字）');
  }

  const caseRow = getRowById('Cases', 'caseId', caseId);
  if (!caseRow) throw new AppError('NOT_FOUND', '找不到案件：' + caseId);
  // 作廢的單是凍結的：留言會讓它看起來還在處理中，跟「這張單不該存在」互相矛盾
  if (isCaseVoided_(caseRow)) {
    throw new AppError('BAD_REQUEST', '這張單已作廢，要繼續討論請先復原');
  }

  const commentId = 'C-' + Utilities.getUuid();
  const now = nowIso_();

  const commentRow = {
    commentId: commentId,
    caseId: caseId,
    parentId: payload.parentId || '',
    createdAt: now,
    authorEmail: user.email,
    authorName: user.name,
    body: bodyText,
    isEdited: false,
    editedAt: '',
    isDeleted: false
  };
  appendRow('Comments', commentRow);

  // 附件先傳完再進鎖：Drive 往返可能好幾秒，不該佔著全域鎖擋住其他人
  let savedCount = 0;
  if (hasAttachments) {
    savedCount = saveAttachments(caseId, commentId, payload.attachments, user).length;
  }

  withWriteLock_(function () {
    // 計數一定要在鎖裡重讀再加，不能拿進鎖之前那份 caseRow 算——兩個人同時留言的話
    // 後進來的會用到過期的計數，一則留言就這樣消失在數字裡。
    // 而且 updateRowById 是整列讀出來再整列寫回去，沒有鎖的話連別人剛改的狀態都會被蓋掉。
    invalidateSheetCache_('Cases');
    const fresh = getRowById('Cases', 'caseId', caseId) || caseRow;
    updateRowById('Cases', 'caseId', caseId, {
      commentCount: Number(fresh.commentCount || 0) + 1,
      attachmentCount: Number(fresh.attachmentCount || 0) + savedCount,
      lastActivityAt: now
    });
  });

  try {
    notifyNewComment(caseRow, commentRow, user);
  } catch (err) {
    console.error('notifyNewComment failed: ' + err);
  }

  return { comment: commentRow };
}

function commentsUpdate(user, payload) {
  payload = payload || {};
  const commentId = payload.commentId;
  const body = payload.body;

  if (!commentId) throw new AppError('BAD_REQUEST', '缺少 commentId');
  if (!body || !String(body).trim()) throw new AppError('BAD_REQUEST', '留言內容不可為空');
  if (String(body).length > MAX_TEXT_LEN) {
    throw new AppError('BAD_REQUEST', '留言內容過長（上限 ' + MAX_TEXT_LEN + ' 字）');
  }

  const commentRow = getRowById('Comments', 'commentId', commentId);
  if (!commentRow) throw new AppError('NOT_FOUND', '找不到留言：' + commentId);
  if (commentRow.isDeleted === true || String(commentRow.isDeleted).toUpperCase() === 'TRUE') {
    throw new AppError('NOT_FOUND', '留言已被刪除');
  }
  if (!(user.role === 'admin' || sameEmail_(user.email, commentRow.authorEmail))) {
    throw new AppError('FORBIDDEN', '沒有權限編輯這則留言');
  }

  const now = nowIso_();
  const updated = withWriteLock_(function () {
    const u = updateRowById('Comments', 'commentId', commentId, {
      body: body,
      isEdited: true,
      editedAt: now
    });
    updateRowById('Cases', 'caseId', commentRow.caseId, { lastActivityAt: now });
    return u;
  });

  return { comment: updated };
}

function commentsDelete(user, payload) {
  payload = payload || {};
  const commentId = payload.commentId;
  if (!commentId) throw new AppError('BAD_REQUEST', '缺少 commentId');

  const commentRow = getRowById('Comments', 'commentId', commentId);
  if (!commentRow) throw new AppError('NOT_FOUND', '找不到留言：' + commentId);

  const alreadyDeleted = commentRow.isDeleted === true || String(commentRow.isDeleted).toUpperCase() === 'TRUE';
  if (alreadyDeleted) return { ok: true };

  if (!(user.role === 'admin' || sameEmail_(user.email, commentRow.authorEmail))) {
    throw new AppError('FORBIDDEN', '沒有權限刪除這則留言');
  }

  const now = nowIso_();
  withWriteLock_(function () {
    updateRowById('Comments', 'commentId', commentId, { isDeleted: true, editedAt: now });

    // 跟 commentsCreate 同理：計數要在鎖裡重讀再減
    invalidateSheetCache_('Cases');
    const caseRow = getRowById('Cases', 'caseId', commentRow.caseId);
    if (!caseRow) return;
    updateRowById('Cases', 'caseId', commentRow.caseId, {
      commentCount: Math.max(0, Number(caseRow.commentCount || 0) - 1),
      lastActivityAt: now
    });
  });

  return { ok: true };
}
