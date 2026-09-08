/**
 * Sheets.gs — 資料存取層。統一用「表頭對欄位名稱」的方式讀寫，
 * 欄位順序異動不會壞掉整支程式；寫入一律檢查欄位是否存在（allow-list）。
 */

/*
 * 單次執行內的快取。
 *
 * 每個 doPost 都是一次全新的 Apps Script 執行，所以這些變數的生命週期
 * 就是「這一個請求」，不會有跨使用者污染的問題。
 *
 * 為什麼需要：openById 與 getRange().getValues() 都是實際的 Google API 往返，
 * 而同一個請求裡常常重複讀同一張表（例如 cases.get 會讀 Members/Cases/
 * Comments/Attachments/History，每個 readAll 又各自 openById 一次）。
 * 沒有快取的話，一個請求可能就是十幾趟 API。
 */
let SS_CACHE_ = null;
const SHEET_CACHE_ = {};
const READ_CACHE_ = {};

/** 寫入之後一定要讓該分頁的讀取快取失效，否則同一請求內後續的讀會拿到舊資料。 */
function invalidateSheetCache_(name) {
  delete READ_CACHE_[name];
}

function getSS() {
  if (SS_CACHE_) return SS_CACHE_;
  const id = getSpreadsheetId_();
  if (!id || id === 'REPLACE_ME') {
    throw new AppError('INTERNAL', '尚未設定 SPREADSHEET_ID，請聯絡系統管理員');
  }
  SS_CACHE_ = SpreadsheetApp.openById(id);
  return SS_CACHE_;
}

function sheet(name) {
  if (SHEET_CACHE_[name]) return SHEET_CACHE_[name];
  const sh = getSS().getSheetByName(name);
  if (!sh) {
    throw new AppError('INTERNAL', '找不到分頁：' + name + '，請先執行「初始化工作表」');
  }
  SHEET_CACHE_[name] = sh;
  return sh;
}

function headersOf_(sh) {
  const lastCol = sh.getLastColumn();
  if (lastCol === 0) return [];
  return sh.getRange(1, 1, 1, lastCol).getValues()[0];
}

function normalizeCell_(v) {
  if (v instanceof Date) return v.toISOString();
  return v;
}

/** 讀整個分頁，回傳「表頭 → 值」的物件陣列；全空白列會被跳過。同一請求內只實際讀一次。 */
function readAll(name) {
  if (READ_CACHE_[name]) return READ_CACHE_[name];
  const sh = sheet(name);
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol === 0) return [];

  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  const values = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const out = [];

  for (let r = 0; r < values.length; r++) {
    const row = values[r];
    const isBlank = row.every(function (v) { return v === '' || v === null || v === undefined; });
    if (isBlank) continue;
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = normalizeCell_(row[c]);
    }
    out.push(obj);
  }
  READ_CACHE_[name] = out;
  return out;
}

/** 欄位 allow-list 檢查：物件的 key 一定要是這個分頁真的有的欄位，防止亂塞欄位污染試算表。 */
function assertKnownFields_(headers, obj, sheetName) {
  Object.keys(obj).forEach(function (k) {
    if (headers.indexOf(k) === -1) {
      throw new AppError('BAD_REQUEST', '分頁 ' + sheetName + ' 沒有欄位：' + k);
    }
  });
}

/*
 * 「一定要當成純文字」的欄位。
 *
 * Sheets 會猜寫進去的字串是什麼型別，猜錯就是靜默的資料損毀，而且畫面上不會有錯誤：
 *   - '=' 開頭 → 變成公式，讀回來是計算結果或 #NAME?，使用者打的字直接不見
 *   - '0012345' → 變成數字 12345，前導零掉了（採購單號、純數字料號會中）
 *   - '2026-09'、'3/4' → 變成日期值
 * 案號的流水號就是這樣壞掉的（"2026:10" 被當成 h:mm，見 setConfig 的註解）。
 *
 * 只列真的必須是文字的欄位：時間戳、數量、檔案大小、計數、布林值不在裡面，
 * 它們本來就該讓 Sheets 存成原生型別，讀取端的 normalizeCell_ 會處理。
 */
const TEXT_COLUMNS_ = {
  Cases: ['caseId', 'createdBy', 'createdByName', 'dept', 'type', 'title', 'partNo',
    'partName', 'vendor', 'poNo', 'unit', 'description', 'status', 'assignee',
    'assigneeName', 'closedBy', 'resolution', 'voidedBy', 'voidReason'],
  Comments: ['commentId', 'caseId', 'parentId', 'authorEmail', 'authorName', 'body'],
  Attachments: ['attId', 'caseId', 'commentId', 'fileName', 'mimeType', 'driveFileId',
    'viewUrl', 'thumbUrl', 'uploadedBy', 'deletedBy'],
  History: ['histId', 'caseId', 'actorEmail', 'actorName', 'action',
    'fromValue', 'toValue', 'note', 'refId'],
  Members: ['email', 'name', 'dept', 'role'],
  Config: ['key', 'value']
};

function isTextColumn_(sheetName, header) {
  const cols = TEXT_COLUMNS_[sheetName];
  return !!cols && cols.indexOf(header) !== -1;
}

/*
 * '=' 開頭的字串一定會被 setValue / setValues 當成公式，而且**@ 格式擋不住**——
 * 官方文件就是這樣寫的，實測也一致：描述填「=1+1 測試」會存成 #ERROR!。
 *
 * @ 格式擋得住的是另一類：數字與日期的轉型（0012345、2026:10、2026-09、3/4 都保得住）。
 * 這兩件事要分開處理，別以為設了格式就沒事。
 *
 * 解法是 Sheets 的「這是文字」標記：值前面加一個單引號寫進去，讀回來不會帶著它。
 * 實測九種難搞的字串全部原樣往返。（setRichTextValue 不能用——它會把
 * "+886912345678" 變成 "=+886912345678"，反而生出一個公式。）
 *
 * 只處理 '=' 開頭。'+' 與 '-' 開頭在 @ 格式下實測是安全的，多繞一趟只是浪費 API 往返，
 * 而「-5V 沒輸出」這種描述在這個系統裡很常見。
 */
function isFormulaLike_(v) {
  return typeof v === 'string' && v.charAt(0) === '=';
}

/**
 * 從整列的值裡把 '=' 開頭的文字欄位挑出來，在批次寫入時先留空，回傳待補寫的清單。
 *
 * 刻意不先寫進去再蓋掉：使用者輸入的公式就算只存在一瞬間也可能被求值，
 * IMPORTDATA 這類函式會真的送出請求。
 */
function deferFormulaLikeCells_(sheetName, headers, row) {
  const deferred = [];
  headers.forEach(function (h, c) {
    if (!isTextColumn_(sheetName, h) || !isFormulaLike_(row[c])) return;
    deferred.push({ col: c, text: row[c] });
    row[c] = '';
  });
  return deferred;
}

function writeDeferredCells_(sh, rowIdx, deferred) {
  deferred.forEach(function (d) {
    sh.getRange(rowIdx, d.col + 1).setValue("'" + d.text);
  });
}

/**
 * 依表頭順序把物件轉成一列寫入分頁最後。
 *
 * 不用 sh.appendRow()，因為格式一定要在寫值「之前」設好——先把文字欄位鎖成純文字，
 * Sheets 才不會在寫入的當下就把字串猜成數字或日期。
 */
function appendRow(name, obj) {
  const sh = sheet(name);
  const headers = headersOf_(sh);
  assertKnownFields_(headers, obj, name);
  const row = headers.map(function (h) {
    const v = obj[h];
    return (v === undefined || v === null) ? '' : v;
  });

  const targetRow = sh.getLastRow() + 1;
  const maxRows = sh.getMaxRows();
  if (targetRow > maxRows) sh.insertRowsAfter(maxRows, targetRow - maxRows);

  // 讀回整列現有格式再只改文字欄位，比逐格 setNumberFormat 少掉十幾趟 API 往返
  const range = sh.getRange(targetRow, 1, 1, headers.length);
  const formats = range.getNumberFormats()[0];
  let touched = false;
  headers.forEach(function (h, c) {
    if (!isTextColumn_(name, h)) return;
    if (formats[c] === '@') return;
    formats[c] = '@';
    touched = true;
  });
  if (touched) range.setNumberFormats([formats]);

  const deferred = deferFormulaLikeCells_(name, headers, row);
  range.setValues([row]);
  writeDeferredCells_(sh, targetRow, deferred);

  invalidateSheetCache_(name);
  return obj;
}

function findRowIndexById_(sh, headers, idColumn, id) {
  const idColIdx = headers.indexOf(idColumn);
  if (idColIdx === -1) throw new AppError('INTERNAL', '找不到欄位：' + idColumn);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return -1;
  const ids = sh.getRange(2, idColIdx + 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2; // 實際列號（含表頭列）
  }
  return -1;
}

/** 依 id 找到列，只更新 patch 裡有的欄位，回傳更新後整列的物件。 */
function updateRowById(name, idColumn, id, patch) {
  const sh = sheet(name);
  const headers = headersOf_(sh);
  assertKnownFields_(headers, patch, name);
  const rowIdx = findRowIndexById_(sh, headers, idColumn, id);
  if (rowIdx === -1) throw new AppError('NOT_FOUND', name + ' 找不到 ' + idColumn + '=' + id);

  const rowRange = sh.getRange(rowIdx, 1, 1, headers.length);
  const values = rowRange.getValues()[0];
  const result = {};
  const lockCols = [];
  for (let c = 0; c < headers.length; c++) {
    const h = headers[c];
    if (Object.prototype.hasOwnProperty.call(patch, h)) {
      values[c] = patch[h];
      // 只鎖這次真的要寫字串進去的欄位，沒被 patch 到的格子維持原樣
      if (isTextColumn_(name, h) && typeof patch[h] === 'string') lockCols.push(c);
    }
    result[h] = normalizeCell_(values[c]);
  }

  // 格式一定要在寫值之前設好，否則 Sheets 在寫入的當下就把字串猜成數字或日期了
  lockCols.forEach(function (c) { sh.getRange(rowIdx, c + 1).setNumberFormat('@'); });

  // 注意這裡要掃整列，不是只掃 patch 到的欄位：setValues 是整列寫回去的，
  // 沒被改到的格子如果本來就存著 '=' 開頭的文字，這一寫就會被重新解讀成公式。
  const deferred = deferFormulaLikeCells_(name, headers, values);
  rowRange.setValues([values]);
  writeDeferredCells_(sh, rowIdx, deferred);

  invalidateSheetCache_(name);
  return result;
}

/**
 * 依 id 整列刪除。**目前沒有任何地方呼叫**——留著是當資料層的完整度。
 * 留言、附件一律走軟刪除（isDeleted）：單子的變更歷程要能回頭看，
 * 把列刪掉就什麼都不剩了。
 */
function deleteRowById(name, idColumn, id) {
  const sh = sheet(name);
  const headers = headersOf_(sh);
  const rowIdx = findRowIndexById_(sh, headers, idColumn, id);
  if (rowIdx === -1) throw new AppError('NOT_FOUND', name + ' 找不到 ' + idColumn + '=' + id);
  sh.deleteRow(rowIdx);
  invalidateSheetCache_(name);
}

function getRowById(name, idColumn, id) {
  const rows = readAll(name);
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][idColumn]) === String(id)) return rows[i];
  }
  return null;
}

function getConfig(key) {
  const rows = readAll('Config');
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].key === key) return rows[i].value;
  }
  return '';
}

/**
 * 寫 Config。value 一律先把儲存格格式設成純文字（@）再寫入——這裡踩過一次大坑：
 *
 * lastCaseSeq 存的是 "2026:10" 這種字串，而 Sheets 會把長得像 h:mm 的字串吃成時間值。
 * 分鐘要兩位數才會觸發，所以 "2026:1" 到 "2026:9" 都好好的是文字，一寫到 "2026:10"
 * 就被轉成時距；讀回來是 Date、再被 normalizeCell_ 轉成 ISO 字串，年度就對不上、
 * 流水號歸零重發，FA-2026-0001 到 0005 因此各被發了兩次（見 Repair.gs）。
 *
 * 先設格式再寫值，Sheets 就不會再動它。Config 的值本來也全都是字串。
 */
function setConfig(key, value) {
  const sh = sheet('Config');
  const headers = headersOf_(sh);
  const valueCol = headers.indexOf('value');
  if (valueCol === -1) throw new AppError('INTERNAL', 'Config 分頁缺少 value 欄位');

  let rowIdx = findRowIndexById_(sh, headers, 'key', key);
  if (rowIdx === -1) {
    appendRow('Config', { key: key, value: '' });
    rowIdx = findRowIndexById_(sh, headers, 'key', key);
    if (rowIdx === -1) throw new AppError('INTERNAL', 'Config 寫入後找不到 key：' + key);
  }

  const cell = sh.getRange(rowIdx, valueCol + 1);
  cell.setNumberFormat('@');
  const v = (value === undefined || value === null) ? '' : value;
  cell.setValue(isFormulaLike_(v) ? "'" + v : v);
  invalidateSheetCache_('Config');
}
