/**
 * Setup.gs — 一鍵建立六個分頁與表頭，可重複執行、絕不會清掉既有資料。
 * 也提供 onOpen 選單，以及設定「每日清理過期 session」排程的小工具。
 */

const SHEET_SCHEMAS = {
  Cases: ['caseId', 'createdAt', 'createdBy', 'createdByName', 'dept', 'type', 'title',
    'partNo', 'partName', 'vendor', 'poNo', 'qty', 'unit', 'needByDate',
    'description', 'status', 'assignee', 'assigneeName',
    'lastActivityAt', 'closedAt', 'closedBy', 'resolution',
    'commentCount', 'attachmentCount'],
  Comments: ['commentId', 'caseId', 'parentId', 'createdAt', 'authorEmail', 'authorName',
    'body', 'isEdited', 'editedAt', 'isDeleted'],
  Attachments: ['attId', 'caseId', 'commentId', 'fileName', 'mimeType', 'size',
    'driveFileId', 'viewUrl', 'thumbUrl', 'uploadedBy', 'uploadedAt'],
  History: ['histId', 'caseId', 'at', 'actorEmail', 'actorName', 'action', 'fromValue', 'toValue', 'note'],
  Members: ['email', 'name', 'dept', 'role', 'notify', 'active'],
  Config: ['key', 'value']
};

const ECOCO_ORANGE = '#FF5000';

function setupSheets() {
  const ss = getSS();

  Object.keys(SHEET_SCHEMAS).forEach(function (name) {
    const headers = SHEET_SCHEMAS[name];
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    ensureHeaders_(sh, headers);
    formatHeaderRow_(sh, headers.length);
  });

  seedConfigDefaults_();

  notice_('error-FA 工作表初始化完成');
  return '初始化完成';
}

/**
 * 顯示提示訊息。
 * 注意不能用 SpreadsheetApp.getActive() —— 本專案建議用「獨立專案」部署，
 * 獨立專案沒有「作用中的試算表」，getActive() 會回 null，.toast() 就會炸掉。
 * 改成對 getSS() 拿到的試算表物件呼叫 toast()，綁定或獨立專案都能用。
 */
function notice_(message) {
  try {
    getSS().toast(message, 'error-FA', 5);
  } catch (err) {
    console.log(message);   // 連 toast 都不行（例如從觸發器跑）就只記 log
  }
}

/** 只在表頭真的跟 schema 不同時才覆寫第一列，絕不動任何資料列。 */
function ensureHeaders_(sh, headers) {
  const existingLastCol = sh.getLastColumn();
  const existing = existingLastCol > 0 ? sh.getRange(1, 1, 1, existingLastCol).getValues()[0] : [];
  const same = headers.length === existing.length && headers.every(function (h, i) { return existing[i] === h; });
  if (!same) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    if (existingLastCol > headers.length) {
      sh.getRange(1, headers.length + 1, 1, existingLastCol - headers.length).clearContent();
    }
  }
}

function formatHeaderRow_(sh, colCount) {
  const range = sh.getRange(1, 1, 1, colCount);
  range.setBackground(ECOCO_ORANGE);
  range.setFontColor('#FFFFFF');
  range.setFontWeight('bold');
  sh.setFrozenRows(1);

  const existingFilter = sh.getFilter();
  if (existingFilter) existingFilter.remove();
  const lastRow = Math.max(sh.getLastRow(), 1);
  sh.getRange(1, 1, lastRow, colCount).createFilter();
}

/** 只在 Config 裡「還沒有值」時才寫入預設值，管理員手動改過的設定不會被蓋掉。 */
function seedConfigDefaults_() {
  const defaults = {
    driveRootFolderId: '',
    facilityGroupEmail: '',
    caseTypes: CASE_TYPES.join(','),
    statuses: CASE_STATUSES.join(','),
    frontendBaseUrl: 'https://syji-gh.github.io/error-FA/',
    lastCaseSeq: ''
  };
  Object.keys(defaults).forEach(function (key) {
    const current = getConfig(key);
    if (current === '' || current === null || current === undefined) {
      setConfig(key, defaults[key]);
    }
  });
}

/**
 * 設定每天清一次過期 session（Auth.gs 的 purgeExpiredSessions）。
 * 在選單按一次即可，之後每天凌晨 3 點自動跑；已經設過就不會重複建立。
 */
function ensureDailyPurgeTrigger() {
  const already = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'purgeExpiredSessions';
  });
  if (already) {
    notice_('每日清理排程已經存在，不用重設');
    return '已存在';
  }
  ScriptApp.newTrigger('purgeExpiredSessions').timeBased().everyDays(1).atHour(3).create();
  notice_('已設定每日清理排程（凌晨 3 點執行）');
  return '已建立';
}

/**
 * onOpen 只有「綁定在試算表裡的專案」才會觸發。
 * 用獨立專案部署的話這個選單不會出現 —— 直接在 Apps Script 編輯器
 * 選 setupSheets / ensureDailyPurgeTrigger 執行即可，效果一樣。
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('error-FA')
    .addItem('初始化工作表', 'setupSheets')
    .addItem('設定每日清理排程（Session）', 'ensureDailyPurgeTrigger')
    .addToUi();
}
