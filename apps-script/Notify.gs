/**
 * Notify.gs — Email 通知。三種觸發：新開單／新留言／狀態變更。
 * 任何失敗都只記錄 log，絕不讓寄信失敗連累使用者的寫入動作（一律包在 try/catch）。
 */

const NOTIFY_DEDUPE_SECONDS = 300; // 同一案件同一收件人 5 分鐘內只寄一封，防洗版

function caseLink_(caseId) {
  const base = getConfig('frontendBaseUrl') || 'https://syji-gh.github.io/error-FA/';
  return base.replace(/\/$/, '') + '/#/case/' + caseId;
}

/**
 * 去重鍵要帶事件類型。若三種事件共用一個鍵，會變成「四分鐘前有人留言，
 * 所以這次的結案通知被吃掉」——留言洗版才是要擋的對象，
 * 狀態變更本來就不常發生，不該被留言連累。
 */
function shouldSend_(eventType, caseId, email) {
  if (!email) return false;
  const cache = CacheService.getScriptCache();
  const key = 'notify:' + eventType + ':' + caseId + ':' + String(email).toLowerCase();
  if (cache.get(key)) return false;
  cache.put(key, '1', NOTIFY_DEDUPE_SECONDS);
  return true;
}

function emailHtml_(heading, bodyHtml, link) {
  return '' +
    '<div style="font-family:\'Noto Sans TC\',Arial,sans-serif;max-width:560px;margin:0 auto;">' +
    '  <div style="background:#FF5000;padding:16px 24px;border-radius:12px 12px 0 0;">' +
    '    <span style="color:#fff;font-size:16px;font-weight:700;">error-FA 物料異常溝通看板</span>' +
    '  </div>' +
    '  <div style="border:1px solid #E5E7EB;border-top:none;border-radius:0 0 12px 12px;padding:24px;">' +
    '    <h2 style="margin:0 0 12px;color:#1A1A1A;font-size:18px;">' + heading + '</h2>' +
    '    <div style="color:#374151;font-size:14px;line-height:1.6;">' + bodyHtml + '</div>' +
    '    <a href="' + link + '" style="display:inline-block;margin-top:20px;padding:10px 24px;' +
    '       background:#FF5000;color:#fff;text-decoration:none;border-radius:999px;font-size:14px;">' +
    '      前往查看案件' +
    '    </a>' +
    '  </div>' +
    '</div>';
}

/**
 * 信一律是「部署這支程式的帳號」寄出的，不是留言者本人 ——
 * MailApp 無法偽造 from。所以真正的發話者姓名一定要出現在主旨與內文裡，
 * 收件人才知道是誰在講話。
 */
function sendMail_(to, subject, html) {
  if (!to) return;
  try {
    MailApp.sendEmail({
      to: to,
      subject: subject,
      htmlBody: html,
      name: 'ECOCO 物料異常看板'
    });
  } catch (err) {
    // 配額用盡（Workspace 1,500 收件人／日）也會走到這裡。
    // 只記錄不拋出：通知寄不出去，不該讓使用者的留言或結案失敗。
    console.error('sendMail_ failed to=' + to + ' err=' + err);
  }
}

function uniq_(arr) {
  const seen = {};
  const out = [];
  arr.forEach(function (v) {
    if (!v) return;
    const k = String(v).toLowerCase();
    if (seen[k]) return;
    seen[k] = true;
    out.push(v);
  });
  return out;
}

function facilityRecipients_() {
  const list = [];
  const group = getConfig('facilityGroupEmail');
  if (group) list.push(group);
  readAll('Members').forEach(function (m) {
    const notify = m.notify === true || String(m.notify).toUpperCase() === 'TRUE';
    if (m.role === 'facility' && notify && m.email) list.push(m.email);
  });
  return uniq_(list);
}

function escapeHtml_(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 1) 新開單 → 寄 Config.facilityGroupEmail ＋ Members 中 role=facility 且 notify=TRUE 的人 */
function notifyNewCase(caseRow, actor) {
  try {
    const link = caseLink_(caseRow.caseId);
    const subject = '[error-FA] 新案件 ' + caseRow.caseId + '：' + caseRow.title;
    const body = escapeHtml_(caseRow.createdByName) + '（' + escapeHtml_(caseRow.createdBy) + '）開立新案件：<br>' +
      '類型：' + escapeHtml_(caseRow.type) + '<br>' +
      '料號：' + escapeHtml_(caseRow.partNo || '無') + '<br>' +
      '標題：' + escapeHtml_(caseRow.title);
    const html = emailHtml_(subject, body, link);

    facilityRecipients_().forEach(function (email) {
      if (shouldSend_('case.created', caseRow.caseId, email)) sendMail_(email, subject, html);
    });
  } catch (err) {
    console.error('notifyNewCase failed: ' + err);
  }
}

/** 2) 新留言 → 寄開單人＋承辦人＋此案曾留言過的所有人（扣掉發話者本人） */
function notifyNewComment(caseRow, commentRow, actor) {
  try {
    const link = caseLink_(caseRow.caseId);
    const subject = '[error-FA] ' + caseRow.caseId + ' 有新留言：' + commentRow.authorName + ' 說……';
    const body = escapeHtml_(commentRow.authorName) + '（' + escapeHtml_(commentRow.authorEmail) +
      '）在案件「' + escapeHtml_(caseRow.title) + '」留言：<br>' +
      '<blockquote style="margin:8px 0;padding:8px 12px;background:#F7F9FC;border-left:3px solid #FF5000;' +
      'white-space:pre-wrap;">' + escapeHtml_(commentRow.body) + '</blockquote>';
    const html = emailHtml_(subject, body, link);

    const recipients = [caseRow.createdBy, caseRow.assignee];
    readAll('Comments').forEach(function (c) {
      if (c.caseId === caseRow.caseId && c.authorEmail) recipients.push(c.authorEmail);
    });

    uniq_(recipients)
      .filter(function (email) { return email.toLowerCase() !== String(commentRow.authorEmail).toLowerCase(); })
      .forEach(function (email) {
        if (shouldSend_('comment.created', caseRow.caseId, email)) sendMail_(email, subject, html);
      });
  } catch (err) {
    console.error('notifyNewComment failed: ' + err);
  }
}

/** 3) 狀態變更 → 寄開單人（若改的人不是開單人）＋承辦人 */
function notifyStatusChange(oldCaseRow, newCaseRow, actor) {
  try {
    const link = caseLink_(newCaseRow.caseId);
    const subject = '[error-FA] ' + newCaseRow.caseId + ' 狀態變更為「' + newCaseRow.status + '」';
    const body = escapeHtml_(actor.name) + '（' + escapeHtml_(actor.email) + '）將案件「' +
      escapeHtml_(newCaseRow.title) + '」狀態從「' + escapeHtml_(oldCaseRow.status) + '」改為「' +
      escapeHtml_(newCaseRow.status) + '」' +
      (newCaseRow.status === '已結案'
        ? '<br>處理結果：' + escapeHtml_(newCaseRow.resolution || '')
        : '');
    const html = emailHtml_(subject, body, link);

    const recipients = [];
    if (oldCaseRow.createdBy && oldCaseRow.createdBy.toLowerCase() !== actor.email.toLowerCase()) {
      recipients.push(oldCaseRow.createdBy);
    }
    if (newCaseRow.assignee) recipients.push(newCaseRow.assignee);

    uniq_(recipients).forEach(function (email) {
      if (shouldSend_('case.status', newCaseRow.caseId, email)) sendMail_(email, subject, html);
    });
  } catch (err) {
    console.error('notifyStatusChange failed: ' + err);
  }
}
