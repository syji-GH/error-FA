/**
 * Sheets.gs — 資料存取層。統一用「表頭對欄位名稱」的方式讀寫，
 * 欄位順序異動不會壞掉整支程式；寫入一律檢查欄位是否存在（allow-list）。
 */

function getSS() {
  const id = getSpreadsheetId_();
  if (!id || id === 'REPLACE_ME') {
    throw new AppError('INTERNAL', '尚未設定 SPREADSHEET_ID，請聯絡系統管理員');
  }
  return SpreadsheetApp.openById(id);
}

function sheet(name) {
  const sh = getSS().getSheetByName(name);
  if (!sh) {
    throw new AppError('INTERNAL', '找不到分頁：' + name + '，請先執行「初始化工作表」');
  }
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

/** 讀整個分頁，回傳「表頭 → 值」的物件陣列；全空白列會被跳過。 */
function readAll(name) {
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

/** 依表頭順序把物件轉成一列寫入分頁最後。 */
function appendRow(name, obj) {
  const sh = sheet(name);
  const headers = headersOf_(sh);
  assertKnownFields_(headers, obj, name);
  const row = headers.map(function (h) {
    const v = obj[h];
    return (v === undefined || v === null) ? '' : v;
  });
  sh.appendRow(row);
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
  for (let c = 0; c < headers.length; c++) {
    const h = headers[c];
    if (Object.prototype.hasOwnProperty.call(patch, h)) values[c] = patch[h];
    result[h] = normalizeCell_(values[c]);
  }
  rowRange.setValues([values]);
  return result;
}

/** 依 id 整列刪除（目前只有 attachments.delete 用到；其他刪除一律走軟刪除 isDeleted）。 */
function deleteRowById(name, idColumn, id) {
  const sh = sheet(name);
  const headers = headersOf_(sh);
  const rowIdx = findRowIndexById_(sh, headers, idColumn, id);
  if (rowIdx === -1) throw new AppError('NOT_FOUND', name + ' 找不到 ' + idColumn + '=' + id);
  sh.deleteRow(rowIdx);
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

function setConfig(key, value) {
  const sh = sheet('Config');
  const headers = headersOf_(sh);
  const rowIdx = findRowIndexById_(sh, headers, 'key', key);
  if (rowIdx === -1) {
    appendRow('Config', { key: key, value: value });
  } else {
    updateRowById('Config', 'key', key, { value: value });
  }
}
