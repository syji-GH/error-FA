/**
 * Setup.gs — 一鍵建立六個分頁與表頭，可重複執行、絕不會清掉既有資料。
 * 也提供 onOpen 選單，以及設定「每日清理過期 session」排程的小工具。
 */

const SHEET_SCHEMAS = {
  Cases: ['caseId', 'createdAt', 'createdBy', 'createdByName', 'dept', 'type', 'title',
    'partNo', 'partName', 'vendor', 'poNo', 'qty', 'unit', 'needByDate',
    'description', 'status', 'assignee', 'assigneeName',
    'lastActivityAt', 'closedAt', 'closedBy', 'resolution',
    'commentCount', 'attachmentCount',
    // 作廢用獨立欄位，不塞進 status：作廢跟「待處理→處理中→已結案」是兩件事，
    // 混進狀態會讓統計卡與篩選都要跟著長出例外。做法與留言、附件的軟刪除一致。
    'isVoided', 'voidedAt', 'voidedBy', 'voidReason'],
  Comments: ['commentId', 'caseId', 'parentId', 'createdAt', 'authorEmail', 'authorName',
    'body', 'isEdited', 'editedAt', 'isDeleted'],
  Attachments: ['attId', 'caseId', 'commentId', 'fileName', 'mimeType', 'size',
    'driveFileId', 'viewUrl', 'thumbUrl', 'uploadedBy', 'uploadedAt',
    'isDeleted', 'deletedAt', 'deletedBy'],
  // refId 指向這筆紀錄牽涉到的附件（attId），讓前端可以在歷程裡把「當時那張圖」畫出來
  History: ['histId', 'caseId', 'at', 'actorEmail', 'actorName', 'action',
    'fromValue', 'toValue', 'note', 'refId'],
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
    lockTextColumnsBelowData_(sh, name, headers);
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

/**
 * 把「必須維持純文字」的欄位（見 Sheets.gs 的 TEXT_COLUMNS_）在**還沒有資料的那些列**
 * 先鎖成文字格式，這樣手動在試算表上輸入的新資料也不會被 Sheets 猜成公式／數字／日期。
 *
 * 刻意只動空白列。既有列可能已經存著被轉型過的值（例如 History 的 fromValue 存過需求日），
 * 硬改格式只會讓那些格子顯示成序號，看起來更糟；既有資料請用 Repair.gs 的
 * diagnoseDataIntegrity() 檢查後再逐格處理。
 */
function lockTextColumnsBelowData_(sh, name, headers) {
  const maxRows = sh.getMaxRows();
  const firstEmpty = Math.max(sh.getLastRow(), 1) + 1;
  if (firstEmpty > maxRows) return;

  headers.forEach(function (h, c) {
    if (!isTextColumn_(name, h)) return;
    sh.getRange(firstEmpty, c + 1, maxRows - firstEmpty + 1, 1).setNumberFormat('@');
  });
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

/*
 * ══════════════ 保溫 ══════════════
 *
 * 實測 /exec 的 ping（後端什麼事都不做）：
 *   冷啟動 8.34 秒 ／ 熱的時候 1.03 秒
 *
 * 那 7 秒全是 Apps Script 把容器叫醒的時間，跟我們的程式碼、跟資料量都無關。
 * 容器閒置一陣子就會被回收，所以早上第一次開、午休後回來開，都會吃到這 7 秒。
 * 剩下的 1 秒是 /exec 回應前那個 302 轉址，那個省不掉。
 *
 * 對策是讓專案定期跑一下，別讓容器睡著。
 */

/** 保溫用的空跑。上班時段順便碰一下試算表，讓 Sheets 連線也是熱的。 */
function keepWarm() {
  const tz = Session.getScriptTimeZone();
  const now = new Date();
  const hour = Number(Utilities.formatDate(now, tz, 'H'));
  const weekday = Number(Utilities.formatDate(now, tz, 'u'));   // 1=週一 … 7=週日

  // 非上班時段就讓它空跑。執行本身已經足以保溫，沒必要一天多開幾百次試算表。
  if (weekday > 5 || hour < 7 || hour >= 20) return 'idle';

  sheet('Config').getRange(1, 1).getValue();
  return 'warm';
}

const KEEP_WARM_MINUTES = 5;

/**
 * 建立保溫排程（每 5 分鐘）。可重複執行，已經有了就不會重複建立。
 *
 * 額度：一天約 288 次、每次不到一秒，Workspace 帳號的觸發器總執行時間上限是
 * 每天 6 小時，用掉的是零頭。
 */
function ensureKeepWarmTrigger() {
  const already = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'keepWarm';
  });
  if (already) {
    notice_('保溫排程已經存在，不用重設');
    return '已存在';
  }
  ScriptApp.newTrigger('keepWarm').timeBased().everyMinutes(KEEP_WARM_MINUTES).create();
  notice_('已設定保溫排程（每 ' + KEEP_WARM_MINUTES + ' 分鐘）');
  return '已建立';
}

/** 不想要保溫了就跑這個，把排程移除。 */
function removeKeepWarmTrigger() {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() !== 'keepWarm') return;
    ScriptApp.deleteTrigger(t);
    removed += 1;
  });
  notice_(removed ? '已移除保溫排程' : '本來就沒有保溫排程');
  return removed;
}

/**
 * 診斷用：新開單的通知會寄給誰？順便回報今天還剩多少寄信額度。
 * 在編輯器直接執行，看「執行紀錄」的輸出即可，不用真的開一張單去試。
 */
function whoGetsNewCaseMail() {
  const group = getConfig('facilityGroupEmail');
  const recipients = newCaseRecipients_();
  const quota = MailApp.getRemainingDailyQuota();

  const lines = [
    'Config.facilityGroupEmail = ' + (group || '(未設定)'),
    '今日剩餘寄信額度 = ' + quota,
    '收件人共 ' + recipients.length + ' 個：' + (recipients.length ? recipients.join(', ') : '(空的，所以不會寄出任何信)')
  ];

  readAll('Members').forEach(function (m) {
    const notify = m.notify === true || String(m.notify).toUpperCase() === 'TRUE';
    const inactive = m.active === false || String(m.active).toUpperCase() === 'FALSE';
    lines.push('  - ' + m.email + '  role=' + (m.role || 'staff') +
               '  notify=' + (notify ? 'TRUE' : 'FALSE') +
               (inactive ? '  (已停用)' : '') +
               (notify && !inactive ? '  → 會收到' : '  → 不會收到'));
  });

  const out = lines.join('\n');
  console.log(out);
  notice_('收件人 ' + recipients.length + ' 個，詳見執行紀錄');
  return out;
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
    .addItem('設定保溫排程（減少冷啟動）', 'ensureKeepWarmTrigger')
    .addItem('檢查通知收件人', 'whoGetsNewCaseMail')
    .addSeparator()
    .addItem('資料健檢', 'diagnoseDataIntegrity')
    .addItem('檢查案號是否撞號', 'diagnoseDuplicateCaseIds')
    .addItem('修復撞號的案號', 'repairDuplicateCaseIds')
    .addToUi();
}
