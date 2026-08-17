/**
 * Comments.gs — 留言（Comments 分頁）相關邏輯：comments.create / update / delete。
 * 刪除一律是軟刪除（isDeleted=true），cases.get 會把已刪除的留言整個濾掉。
 */

function commentsCreate(user, payload) {
  payload = payload || {};
  const caseId = payload.caseId;
  const body = payload.body;

  if (!caseId) throw new AppError('BAD_REQUEST', '缺少 caseId');
  if (!body || !String(body).trim()) throw new AppError('BAD_REQUEST', '留言內容不可為空');
  if (String(body).length > MAX_TEXT_LEN) {
    throw new AppError('BAD_REQUEST', '留言內容過長（上限 ' + MAX_TEXT_LEN + ' 字）');
  }

  const caseRow = getRowById('Cases', 'caseId', caseId);
  if (!caseRow) throw new AppError('NOT_FOUND', '找不到案件：' + caseId);

  const commentId = 'C-' + Utilities.getUuid();
  const now = nowIso_();

  const commentRow = {
    commentId: commentId,
    caseId: caseId,
    parentId: payload.parentId || '',
    createdAt: now,
    authorEmail: user.email,
    authorName: user.name,
    body: body,
    isEdited: false,
    editedAt: '',
    isDeleted: false
  };
  appendRow('Comments', commentRow);

  let savedCount = 0;
  if (Array.isArray(payload.attachments) && payload.attachments.length > 0) {
    savedCount = saveAttachments(caseId, commentId, payload.attachments, user).length;
  }

  updateRowById('Cases', 'caseId', caseId, {
    commentCount: Number(caseRow.commentCount || 0) + 1,
    attachmentCount: Number(caseRow.attachmentCount || 0) + savedCount,
    lastActivityAt: now
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
  const updated = updateRowById('Comments', 'commentId', commentId, {
    body: body,
    isEdited: true,
    editedAt: now
  });

  updateRowById('Cases', 'caseId', commentRow.caseId, { lastActivityAt: now });

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
  updateRowById('Comments', 'commentId', commentId, { isDeleted: true, editedAt: now });

  const caseRow = getRowById('Cases', 'caseId', commentRow.caseId);
  if (caseRow) {
    updateRowById('Cases', 'caseId', commentRow.caseId, {
      commentCount: Math.max(0, Number(caseRow.commentCount || 0) - 1),
      lastActivityAt: now
    });
  }

  return { ok: true };
}
