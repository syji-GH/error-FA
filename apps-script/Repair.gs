/**
 * Repair.gs — 案號撞號的診斷與修復。一次性的維護工具，不對外開 action，
 * 只能在 Apps Script 編輯器或試算表選單裡執行。
 *
 * 為什麼需要：cases.get 走 getRowById，同一個案號有兩列時只會回第一列，
 * 後開的那張單在清單上看得到、點下去卻跳出前一張，等於整張單被蓋住。
 * nextCaseId_ 已經改成不會再撞號（見 Cases.gs），但既有的資料要靠這裡補救。
 */

/** 子資料列要跟著搬走的時間窗：只有「開單當下那一批」才算被蓋住那張單的。 */
const REPAIR_OWN_WINDOW_MS = 5 * 60 * 1000;

/** 讀整個分頁，但每列多帶一個 _row（實際列號），才能繞開 getRowById「只回第一筆」的限制。 */
function repairReadSheet_(name) {
  const sh = sheet(name);
  const headers = headersOf_(sh);
  const lastRow = sh.getLastRow();
  if (lastRow < 2 || !headers.length) return { sh: sh, headers: headers, rows: [] };

  const values = sh.getRange(2, 1, lastRow - 1, headers.length).getValues();
  const rows = [];
  values.forEach(function (v, i) {
    const isBlank = v.every(function (x) { return x === '' || x === null || x === undefined; });
    if (isBlank) return;
    const obj = { _row: i + 2 };
    headers.forEach(function (h, c) { obj[h] = normalizeCell_(v[c]); });
    rows.push(obj);
  });
  return { sh: sh, headers: headers, rows: rows };
}

function repairSetCell_(table, rowIdx, field, value) {
  const col = table.headers.indexOf(field);
  if (col === -1) throw new Error('找不到欄位：' + field);
  table.sh.getRange(rowIdx, col + 1).setValue(value);
}

/** 撞號的案件，依案號分組、組內依建立時間由舊到新。只回傳真的重複的那些組。 */
function duplicateCaseGroups_(caseRows) {
  const map = {};
  caseRows.forEach(function (r) {
    const id = String(r.caseId || '').trim();
    if (!id) return;
    (map[id] = map[id] || []).push(r);
  });
  return Object.keys(map).filter(function (id) { return map[id].length > 1; }).sort()
    .map(function (id) {
      const rows = map[id].slice().sort(function (a, b) {
        return String(a.createdAt).localeCompare(String(b.createdAt));
      });
      return { caseId: id, rows: rows };
    });
}

function repairCaseLabel_(r) {
  return (r.title || r.partNo || '(無標題)') + '  建立於 ' + (r.createdAt || '?') +
         '  by ' + (r.createdByName || r.createdBy || '?');
}

/** 從舊案號取年度；取不到就退回 createdAt 的年度，再不行就用今年。 */
function repairYearOf_(row) {
  const m = /^FA-(\d{4})-/.exec(String(row.caseId || ''));
  if (m) return Number(m[1]);
  const d = new Date(row.createdAt);
  return isNaN(d.getTime()) ? new Date().getFullYear() : d.getFullYear();
}

/** 子資料列的時間欄位在三張表叫不同名字。 */
const REPAIR_CHILD_SHEETS = [
  { name: 'Comments',    idField: 'commentId', timeField: 'createdAt'  },
  { name: 'Attachments', idField: 'attId',     timeField: 'uploadedAt' },
  { name: 'History',     idField: 'histId',    timeField: 'at'         }
];

/**
 * 診斷：列出所有撞號的案件，以及修復時打算怎麼搬子資料列。不寫入任何東西。
 * 在編輯器直接執行，看「執行紀錄」。
 */
function diagnoseDuplicateCaseIds() {
  const cases = repairReadSheet_('Cases');
  const groups = duplicateCaseGroups_(cases.rows);
  const lines = ['Cases 共 ' + cases.rows.length + ' 列，撞號的案號 ' + groups.length + ' 組'];

  if (!groups.length) {
    lines.push('（沒有重複案號，不用修）');
    const out = lines.join('\n');
    console.log(out);
    notice_('沒有重複案號');
    return out;
  }

  const children = {};
  REPAIR_CHILD_SHEETS.forEach(function (s) { children[s.name] = repairReadSheet_(s.name); });

  groups.forEach(function (g) {
    lines.push('');
    lines.push('案號 ' + g.caseId + ' 有 ' + g.rows.length + ' 列：');
    g.rows.forEach(function (r, i) {
      lines.push('  [' + (i === 0 ? '保留原號' : '會改號') + '] 第 ' + r._row + ' 列 — ' + repairCaseLabel_(r));
    });
    REPAIR_CHILD_SHEETS.forEach(function (s) {
      const mine = children[s.name].rows.filter(function (c) { return String(c.caseId) === g.caseId; });
      if (!mine.length) return;
      const plan = repairAssignChildren_(g.rows, mine, s.timeField);
      lines.push('  ' + s.name + ' ' + mine.length + ' 列 → ' +
                 plan.counts.map(function (n, i) {
                   return (i === 0 ? '保留原號' : '第 ' + g.rows[i]._row + ' 列') + ' ' + n + ' 列';
                 }).join('、'));
    });
  });

  const out = lines.join('\n');
  console.log(out);
  notice_('撞號 ' + groups.length + ' 組，詳見執行紀錄');
  return out;
}

/**
 * 把子資料列分配給組內的某一列。
 *
 * 規則：時間最接近哪一列的 createdAt 就算誰的，但只在 5 分鐘內才算數，其餘一律歸第一列。
 * 這樣分是因為被蓋住的那張單在 cases.get 裡永遠拿不到（getRowById 只回第一筆），
 * 所以除了開單那一刻寫進去的 create 歷程與初始附件，之後的留言、附件、歷程
 * 一定都是使用者對「保留原號的那張」做的。
 */
function repairAssignChildren_(caseRowsSorted, childRows, timeField) {
  const born = caseRowsSorted.map(function (r) { return Date.parse(r.createdAt); });
  const counts = caseRowsSorted.map(function () { return 0; });
  const assign = [];

  childRows.forEach(function (c) {
    const ts = Date.parse(c[timeField]);
    let best = 0;
    let bestDiff = Infinity;
    born.forEach(function (b, i) {
      if (isNaN(b) || isNaN(ts)) return;
      const d = Math.abs(b - ts);
      if (d < bestDiff) { bestDiff = d; best = i; }
    });
    const target = (best > 0 && bestDiff <= REPAIR_OWN_WINDOW_MS) ? best : 0;
    counts[target] += 1;
    assign.push({ row: c, target: target });
  });

  return { assign: assign, counts: counts };
}

/**
 * 修復：把撞號那組裡「後開的」重新配一個沒用過的案號，子資料列依 repairAssignChildren_ 搬過去。
 *
 * 第一列（最早建立、也就是目前唯一點得開的那張）維持原案號不動，通知信與書籤才不會失效。
 * Drive 上的附件資料夾仍叫舊案號——附件是靠 driveFileId 開的，不影響顯示，
 * 之後新加的附件會自己開一個新案號的資料夾。
 *
 * 執行前請先跑 diagnoseDuplicateCaseIds() 看一次搬移計畫。
 */
function repairDuplicateCaseIds() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('系統忙碌中，請稍後再試');

  try {
    const cases = repairReadSheet_('Cases');
    const groups = duplicateCaseGroups_(cases.rows);
    if (!groups.length) {
      console.log('沒有重複案號，不用修');
      notice_('沒有重複案號');
      return '沒有重複案號';
    }

    const used = {};
    cases.rows.forEach(function (r) {
      const id = String(r.caseId || '').trim();
      if (id) used[id] = true;
    });

    const children = {};
    REPAIR_CHILD_SHEETS.forEach(function (s) { children[s.name] = repairReadSheet_(s.name); });

    const lines = [];
    let renumbered = 0;

    groups.forEach(function (g) {
      // 先決定每一列的新案號，再一起搬子資料列
      const newIds = g.rows.map(function (r, i) {
        if (i === 0) return g.caseId;
        return allocateCaseId_(repairYearOf_(r), used).caseId;
      });

      lines.push('案號 ' + g.caseId + '：');
      g.rows.forEach(function (r, i) {
        if (i === 0) {
          lines.push('  第 ' + r._row + ' 列 保留 ' + g.caseId + ' — ' + repairCaseLabel_(r));
          return;
        }
        repairSetCell_(cases, r._row, 'caseId', newIds[i]);
        renumbered += 1;
        lines.push('  第 ' + r._row + ' 列 改成 ' + newIds[i] + ' — ' + repairCaseLabel_(r));
      });

      REPAIR_CHILD_SHEETS.forEach(function (s) {
        const table = children[s.name];
        const mine = table.rows.filter(function (c) { return String(c.caseId) === g.caseId; });
        if (!mine.length) return;
        const plan = repairAssignChildren_(g.rows, mine, s.timeField);
        let moved = 0;
        plan.assign.forEach(function (a) {
          if (a.target === 0) return;
          repairSetCell_(table, a.row._row, 'caseId', newIds[a.target]);
          moved += 1;
          lines.push('    ' + s.name + ' 第 ' + a.row._row + ' 列（' + a.row[s.timeField] + '）→ ' + newIds[a.target]);
        });
        if (!moved) lines.push('    ' + s.name + ' ' + mine.length + ' 列全部留在 ' + g.caseId);
      });
    });

    SpreadsheetApp.flush();

    // 案號搬完才重算計數，commentCount / attachmentCount 要照新的歸屬算
    invalidateSheetCache_('Cases');
    invalidateSheetCache_('Comments');
    invalidateSheetCache_('Attachments');
    const fixedCounts = repairRecountAll_();
    if (fixedCounts.length) {
      lines.push('');
      lines.push('重算統計欄：');
      fixedCounts.forEach(function (l) { lines.push('  ' + l); });
    }

    // 計數器往前推到目前用掉的最大號，之後開單不會再走回頭路
    const year = new Date().getFullYear();
    const maxSeq = maxCaseSeqOfYear_(year, used);
    if (maxSeq > 0) {
      setConfig('lastCaseSeq', year + ':' + maxSeq);
      lines.push('');
      lines.push('lastCaseSeq 已更新為 ' + year + ':' + maxSeq);
    }

    SpreadsheetApp.flush();

    const out = ['修復完成：改號 ' + renumbered + ' 張單'].concat(lines).join('\n');
    console.log(out);
    notice_('修復完成，改號 ' + renumbered + ' 張，詳見執行紀錄');
    return out;
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
}

/** 依 Comments / Attachments 的實際列數重算每張單的 commentCount 與 attachmentCount。 */
function repairRecountAll_() {
  const cases = repairReadSheet_('Cases');
  const comments = repairReadSheet_('Comments');
  const attachments = repairReadSheet_('Attachments');
  const logs = [];

  const commentCount = {};
  comments.rows.forEach(function (c) {
    const isDel = c.isDeleted === true || String(c.isDeleted).toUpperCase() === 'TRUE';
    if (isDel) return;
    commentCount[c.caseId] = (commentCount[c.caseId] || 0) + 1;
  });

  const attachmentCount = {};
  attachments.rows.forEach(function (a) {
    if (isAttachmentDeleted_(a)) return;
    attachmentCount[a.caseId] = (attachmentCount[a.caseId] || 0) + 1;
  });

  cases.rows.forEach(function (r) {
    const id = String(r.caseId);
    const wantC = commentCount[id] || 0;
    const wantA = attachmentCount[id] || 0;
    if (Number(r.commentCount || 0) !== wantC) {
      repairSetCell_(cases, r._row, 'commentCount', wantC);
      logs.push(id + ' commentCount ' + (r.commentCount || 0) + ' → ' + wantC);
    }
    if (Number(r.attachmentCount || 0) !== wantA) {
      repairSetCell_(cases, r._row, 'attachmentCount', wantA);
      logs.push(id + ' attachmentCount ' + (r.attachmentCount || 0) + ' → ' + wantA);
    }
  });

  return logs;
}

/*
 * ══════════════ 全表健檢 ══════════════
 *
 * 案號撞號的教訓一般化：只要「用某個欄位當 id 去撈一列」的地方，撞號就會安靜地
 * 讓後面那筆消失（getRowById 只回第一筆）。這裡把所有 id 欄位都掃一遍，
 * 順便檢查文字欄位有沒有被 Sheets 轉型、子資料列有沒有指向不存在的案號。
 */

const INTEGRITY_KEYS_ = [
  { name: 'Cases',       key: 'caseId',    caseSensitive: true  },
  { name: 'Comments',    key: 'commentId', caseSensitive: true  },
  { name: 'Attachments', key: 'attId',     caseSensitive: true  },
  { name: 'History',     key: 'histId',    caseSensitive: true  },
  { name: 'Members',     key: 'email',     caseSensitive: false },
  { name: 'Config',      key: 'key',       caseSensitive: true  }
];

/** 唯讀健檢，不改任何東西。在編輯器直接執行，看「執行紀錄」。 */
function diagnoseDataIntegrity() {
  const lines = [];
  let problems = 0;

  // ── 1. id 欄位撞號 ──────────────────────────────────────
  INTEGRITY_KEYS_.forEach(function (spec) {
    const table = repairReadSheet_(spec.name);
    const seen = {};
    const dups = {};
    table.rows.forEach(function (r) {
      let v = String(r[spec.key] === undefined || r[spec.key] === null ? '' : r[spec.key]).trim();
      if (!v) return;
      if (!spec.caseSensitive) v = v.toLowerCase();
      if (seen[v]) (dups[v] = dups[v] || [seen[v]]).push(r._row);
      else seen[v] = r._row;
    });
    const keys = Object.keys(dups);
    if (!keys.length) {
      lines.push('OK   ' + spec.name + '.' + spec.key + ' 沒有重複（' + table.rows.length + ' 列）');
      return;
    }
    problems += keys.length;
    lines.push('問題 ' + spec.name + '.' + spec.key + ' 有 ' + keys.length + ' 個值重複：');
    keys.forEach(function (v) { lines.push('       ' + v + ' → 第 ' + dups[v].join('、') + ' 列'); });
  });

  // ── 2. 文字欄位被 Sheets 轉型 ────────────────────────────
  Object.keys(TEXT_COLUMNS_).forEach(function (name) {
    const table = repairReadSheet_(name);
    const bad = [];
    table.rows.forEach(function (r) {
      TEXT_COLUMNS_[name].forEach(function (h) {
        if (table.headers.indexOf(h) === -1) return;
        const v = r[h];
        if (v === '' || v === null || v === undefined) return;
        // readAll 已經把 Date 轉成 ISO 字串，所以這裡看到的非字串就是數字或布林值
        if (typeof v !== 'string') bad.push('第 ' + r._row + ' 列 ' + h + ' = ' + v + '（' + typeof v + '）');
      });
    });
    if (!bad.length) return;
    problems += bad.length;
    lines.push('問題 ' + name + ' 有 ' + bad.length + ' 格文字欄位被轉成別的型別：');
    bad.slice(0, 20).forEach(function (l) { lines.push('       ' + l); });
    if (bad.length > 20) lines.push('       …還有 ' + (bad.length - 20) + ' 格');
  });

  // ── 3. 指向不存在案號的子資料列 ──────────────────────────
  const caseIds = {};
  repairReadSheet_('Cases').rows.forEach(function (r) { caseIds[String(r.caseId)] = true; });
  REPAIR_CHILD_SHEETS.forEach(function (s) {
    const orphans = repairReadSheet_(s.name).rows.filter(function (r) {
      const id = String(r.caseId || '').trim();
      return id && !caseIds[id];
    });
    if (!orphans.length) {
      lines.push('OK   ' + s.name + ' 沒有指向不存在案號的列');
      return;
    }
    problems += orphans.length;
    lines.push('問題 ' + s.name + ' 有 ' + orphans.length + ' 列指向不存在的案號：');
    orphans.slice(0, 20).forEach(function (r) {
      lines.push('       第 ' + r._row + ' 列 → ' + r.caseId);
    });
  });

  const out = (problems ? '發現 ' + problems + ' 個問題' : '全部正常') + '\n' + lines.join('\n');
  console.log(out);
  notice_(problems ? '發現 ' + problems + ' 個問題，詳見執行紀錄' : '健檢通過');
  return out;
}
