/* error-FA 主程式：hash 路由 + 列表頁 + 詳情頁 + 開單 Modal */

(function () {

  var esc = UI.esc;
  var view = null;

  var state = {
    filter: { status: '', type: '', q: '', mine: false, voided: false },
    cases: [],
    stats: null,
    members: [],
  };

  /* ══════════════ 附件處理 ══════════════ */

  var MAX_IMAGE_MB = 10;
  var MAX_FILE_MB  = 5;   // 非圖片檔的上限較低：Apps Script POST body 實測可靠上限約 5MB base64

  function readAsDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error('讀取檔案失敗')); };
      fr.readAsDataURL(blob);
    });
  }

  function stripBase64Prefix(dataUrl) {
    var i = dataUrl.indexOf(',');
    return i === -1 ? dataUrl : dataUrl.slice(i + 1);
  }

  /** 圖片壓到長邊 ≤1600px、JPEG q0.8。手機 4MB 照片通常會變成 300~600KB */
  async function compressImage(file) {
    var bitmap;
    try {
      // imageOrientation:'from-image' 讓直式照片不會躺著
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (e) {
      return file;   // 瀏覽器不支援就原檔上傳
    }
    var max = 1600;
    var scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    var w = Math.round(bitmap.width * scale);
    var h = Math.round(bitmap.height * scale);

    var canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    bitmap.close && bitmap.close();

    var blob = await new Promise(function (res) {
      canvas.toBlob(res, 'image/jpeg', 0.8);
    });
    if (!blob || blob.size >= file.size) return file;   // 壓不小就用原檔

    var name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
    return new File([blob], name, { type: 'image/jpeg' });
  }

  /** File[] → 可直接送給後端的 attachments[]；不合格的檔案會 toast 提示並略過 */
  async function prepareFiles(files) {
    var out = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var isImage = /^image\//.test(f.type);
      try {
        if (isImage) f = await compressImage(f);
      } catch (e) { /* 壓縮失敗就用原檔 */ }

      var limit = isImage ? MAX_IMAGE_MB : MAX_FILE_MB;
      if (f.size > limit * 1024 * 1024) {
        UI.toast(f.name + ' 超過 ' + limit + 'MB，已略過', 'error');
        continue;
      }
      var dataUrl = await readAsDataUrl(f);
      out.push({
        fileName: f.name,
        mimeType: f.type || 'application/octet-stream',
        dataBase64: stripBase64Prefix(dataUrl),
        _size: f.size,
        _preview: isImage ? dataUrl : '',
      });
    }
    return out;
  }

  /** 縮圖：Drive 直連為主，失敗時退回後端代取（多帳號登入的瀏覽器常會直連失敗） */
  function thumbImg(att) {
    return '<img src="' + esc(att.thumbUrl) + '" alt="' + esc(att.fileName) + '" loading="lazy" ' +
           'data-att="' + esc(att.attachmentId) + '" ' +
           'class="js-thumb w-full h-full object-cover">';
  }

  document.addEventListener('error', function (e) {
    var img = e.target;
    if (!img || img.tagName !== 'IMG' || !img.classList.contains('js-thumb')) return;
    if (img.dataset.fallbackTried) return;
    img.dataset.fallbackTried = '1';
    API.getThumb(img.dataset.att).then(function (r) {
      img.src = 'data:' + r.mimeType + ';base64,' + r.dataBase64;
    }).catch(function () {
      img.replaceWith(Object.assign(document.createElement('div'), {
        className: 'w-full h-full flex items-center justify-center bg-card text-[10px] font-bold text-muted text-center px-2',
        textContent: '無法顯示，請確認瀏覽器登入的是 ecoco.xyz 帳號',
      }));
    });
  }, true);

  function attachmentGrid(atts) {
    if (!atts || !atts.length) return '';
    var images = atts.filter(function (a) { return /^image\//.test(a.mimeType); });
    var files  = atts.filter(function (a) { return !/^image\//.test(a.mimeType); });
    var html = '';

    if (images.length) {
      html += '<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 mt-3">' +
        images.map(function (a) {
          return '<a href="' + esc(a.viewUrl) + '" target="_blank" rel="noopener" ' +
                 'class="block aspect-square rounded-xl overflow-hidden border border-line ' +
                 'bg-card hover:shadow-md transition-all">' + thumbImg(a) + '</a>';
        }).join('') + '</div>';
    }
    if (files.length) {
      html += '<div class="mt-3 space-y-2">' + files.map(function (a) {
        var ext = (a.fileName.split('.').pop() || '').toUpperCase().slice(0, 5);
        return '<a href="' + esc(a.viewUrl) + '" target="_blank" rel="noopener" ' +
          'class="flex items-center gap-3 bg-white border border-line rounded-xl px-3 py-2.5 hover:shadow-md transition-all">' +
          '<span class="bg-card text-ink rounded px-2 py-0.5 text-xs font-black uppercase">' + esc(ext) + '</span>' +
          '<span class="flex-1 text-sm font-bold text-ink truncate">' + esc(a.fileName) + '</span>' +
          '<span class="text-xs font-medium text-muted shrink-0">' + UI.fmtSize(a.size) + '</span></a>';
      }).join('') + '</div>';
    }
    return html;
  }

  /* ══════════════ 上傳區（開單與留言共用） ══════════════ */

  function makeUploader() {
    var picked = [];   // prepareFiles() 的結果

    var el = document.createElement('div');
    el.innerHTML =
      '<div class="fa-drop border-2 border-dashed border-line rounded-xl px-4 py-5 text-center transition-colors cursor-pointer">' +
        '<p class="text-sm font-bold text-ink2">點此選擇，或把檔案拖進來</p>' +
        '<p class="mt-1 text-xs font-medium text-muted">圖片會自動壓縮（上限 ' + MAX_IMAGE_MB +
          'MB）；其他檔案上限 ' + MAX_FILE_MB + 'MB</p>' +
        '<input type="file" multiple accept="image/*,.pdf,.xlsx,.xls,.doc,.docx,.csv,.txt" class="hidden">' +
      '</div>' +
      '<div class="js-list grid grid-cols-3 sm:grid-cols-4 gap-2 mt-2"></div>';

    var drop = el.querySelector('.fa-drop');
    var input = el.querySelector('input[type=file]');
    var list = el.querySelector('.js-list');

    function render() {
      list.innerHTML = picked.map(function (p, i) {
        var inner = p._preview
          ? '<img src="' + esc(p._preview) + '" class="w-full h-full object-cover">'
          : '<div class="w-full h-full flex items-center justify-center px-1 text-[10px] font-bold text-muted text-center break-all">' +
            esc(p.fileName) + '</div>';
        return '<div class="relative aspect-square rounded-xl overflow-hidden border border-line bg-card">' +
          inner +
          '<button type="button" data-rm="' + i + '" class="absolute top-1 right-1 w-6 h-6 rounded-full ' +
          'bg-ink/70 text-white text-sm leading-none hover:bg-red-600 transition-colors">&times;</button></div>';
      }).join('');
    }

    async function add(files) {
      if (!files || !files.length) return;
      drop.classList.add('opacity-60', 'pointer-events-none');
      try {
        var prepared = await prepareFiles(files);
        picked = picked.concat(prepared);
        render();
      } finally {
        drop.classList.remove('opacity-60', 'pointer-events-none');
      }
    }

    drop.addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () { add(input.files); input.value = ''; });
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('is-over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('is-over'); });
    });
    drop.addEventListener('drop', function (e) { add(e.dataTransfer.files); });
    list.addEventListener('click', function (e) {
      var b = e.target.closest('[data-rm]');
      if (!b) return;
      picked.splice(Number(b.dataset.rm), 1);
      render();
    });

    return {
      el: el,
      payload: function () {
        return picked.map(function (p) {
          return { fileName: p.fileName, mimeType: p.mimeType, dataBase64: p.dataBase64 };
        });
      },
      count: function () { return picked.length; },
    };
  }

  /* ══════════════ 類型 chip（開單與編輯共用） ══════════════ */

  /**
   * 在 root 裡畫一排單選的類型 chip。
   * onChange 每次選取都會被呼叫（包含一開始帶 initial 進來的那一次），
   * 因為「其他」類型要跟著把料號的必填星號拿掉。
   */
  function mountTypeChips(root, initial, onChange) {
    var chosen = initial || '';

    function paint() {
      root.innerHTML = window.CASE_TYPES.map(function (t) {
        var on = t === chosen;
        return '<button type="button" data-t="' + esc(t) + '" class="js-type rounded-full px-4 py-2 ' +
          'text-[13px] font-bold border transition-colors ' +
          (on ? 'bg-ecoco-blue text-white border-ecoco-blue'
              : 'border-line text-muted hover:text-ink hover:bg-card') + '">' + esc(t) + '</button>';
      }).join('');
    }
    paint();

    root.addEventListener('click', function (e) {
      var b = e.target.closest('.js-type');
      if (!b) return;
      chosen = b.dataset.t;
      paint();
      if (onChange) onChange(chosen);
    });

    if (chosen && onChange) onChange(chosen);
    return {
      get: function () { return chosen; },
      set: function (t) { chosen = t || ''; paint(); if (onChange) onChange(chosen); },
    };
  }

  /* ══════════════ 列表頁 ══════════════ */

  function listQuery() {
    return {
      status: state.filter.status,
      type: state.filter.type,
      q: state.filter.q,
      mine: state.filter.mine,
      voided: state.filter.voided,
      limit: 100,
      withStats: true,   // 統計跟清單一起回，省一趟往返
    };
  }

  /** preloaded 是開站那一趟已經拿到的結果，有的話就不再打一次 API */
  async function renderList(preloaded) {
    view.innerHTML = statBar(state.stats) + filterBar() +
      '<div id="caseList" class="mt-5">' + UI.skeleton(4) + '</div>';
    bindFilterBar();

    try {
      var res = preloaded || await API.listCases(listQuery());
      if (res.stats) {
        state.stats = res.stats;
        var sb = document.getElementById('statBar');
        if (sb) sb.outerHTML = statBar(state.stats);
      }
      state.cases = res.items || [];
      var box = document.getElementById('caseList');
      if (!box) return;
      box.innerHTML = state.cases.length
        ? '<div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">' +
            state.cases.map(caseCard).join('') + '</div>'
        : UI.empty(state.filter.voided ? '沒有已作廢的異常單' : '沒有符合條件的異常單',
            state.filter.voided
              ? '作廢的單會留在這裡，不會真的被刪掉'
              : (state.filter.q || state.filter.status || state.filter.type
                  ? '換個篩選條件看看' : '點右上角「開新異常單」建立第一筆'));
    } catch (err) {
      showError(document.getElementById('caseList'), err);
    }
  }

  function statBar(stats) {
    var items = window.STATUSES.map(function (s) {
      var n = stats ? (stats[s] || 0) : '—';
      var active = state.filter.status === s;
      var st = window.STATUS_STYLE[s];
      return '<button data-stat="' + esc(s) + '" class="text-left bg-white rounded-2xl border p-5 ' +
        'transition-all hover:shadow-md ' +
        (active ? 'border-ecoco-orange shadow-md' : 'border-line shadow-sm') + '">' +
        '<div class="flex items-center gap-2">' +
          '<span class="w-2 h-2 rounded-full" style="background:' + st.dot + '"></span>' +
          '<span class="text-[10px] font-bold tracking-widest uppercase text-muted">' + esc(s) + '</span>' +
        '</div>' +
        '<p class="mt-2 text-3xl font-black tracking-tight text-ink">' + n + '</p></button>';
    }).join('');
    return '<div id="statBar" class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">' + items + '</div>';
  }

  function filterBar() {
    var typeChips = ['', ].concat(window.CASE_TYPES).map(function (t) {
      var active = state.filter.type === t;
      return '<button data-type="' + esc(t) + '" class="shrink-0 rounded-full px-4 py-1.5 text-[13px] font-bold ' +
        'transition-colors ' + (active ? 'bg-ecoco-blue text-white' : 'text-muted hover:text-ink hover:bg-card') +
        '">' + esc(t || '全部類型') + '</button>';
    }).join('');

    return '<div class="space-y-3">' +
      '<div class="bg-white border-[4px] border-ecoco-orange rounded-[40px] px-6 py-3 md:py-4 shadow-searchbar flex items-center gap-3">' +
        '<input id="searchInput" type="search" value="' + esc(state.filter.q) + '" ' +
          'placeholder="搜尋案號、標題、料號、廠商…" ' +
          'class="flex-1 text-lg font-bold bg-transparent outline-none placeholder:text-ph min-w-0">' +
        '<button id="btnMine" class="shrink-0 rounded-full px-4 py-1.5 text-[13px] font-bold transition-colors ' +
          (state.filter.mine ? 'bg-ecoco-blue text-white' : 'text-muted hover:text-ink hover:bg-card') +
          '">我開的</button>' +
        '<button id="btnVoided" class="shrink-0 rounded-full px-4 py-1.5 text-[13px] font-bold transition-colors ' +
          (state.filter.voided ? 'bg-ink text-white' : 'text-muted hover:text-ink hover:bg-card') +
          '">已作廢</button>' +
      '</div>' +
      '<div class="flex gap-1 overflow-x-auto scrollbar-hide -mx-1 px-1">' + typeChips + '</div>' +
    '</div>';
  }

  // 篩選列的點擊用事件委派，且只綁一次 —— renderList() 會重畫 DOM，
  // 每次重綁會讓 listener 一直累積，點一下觸發 N 次。
  var filterBound = false;
  function bindFilterBarOnce() {
    if (filterBound) return;
    filterBound = true;
    view.addEventListener('click', function (e) {
      var s = e.target.closest('[data-stat]');
      if (s) {
        state.filter.status = state.filter.status === s.dataset.stat ? '' : s.dataset.stat;
        return renderList();
      }
      var t = e.target.closest('[data-type]');
      if (t) {
        state.filter.type = t.dataset.type;
        return renderList();
      }
      if (e.target.closest('#btnMine')) {
        state.filter.mine = !state.filter.mine;
        return renderList();
      }
      if (e.target.closest('#btnVoided')) {
        state.filter.voided = !state.filter.voided;
        return renderList();
      }
    });
  }

  function bindFilterBar() {
    bindFilterBarOnce();

    var search = document.getElementById('searchInput');
    if (search) {
      var timer;
      search.addEventListener('input', function () {
        clearTimeout(timer);
        timer = setTimeout(function () {
          state.filter.q = search.value.trim();
          renderList();
          var s = document.getElementById('searchInput');
          if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
        }, 350);
      });
    }
  }

  /** Sheets 讀回來的布林欄位可能是 true 也可能是字串 'TRUE'，兩種都要吃 */
  function isVoided(c) {
    return !!c && (c.isVoided === true || String(c.isVoided).toUpperCase() === 'TRUE');
  }

  var VOID_BADGE = '<span class="inline-flex items-center rounded-full border border-line bg-card ' +
    'px-2.5 py-0.5 text-[11px] font-black tracking-wide text-muted">已作廢</span>';

  /** 標題是選填的，空白時退而用料號當標示（再不行才用案號） */
  function caseLabel(c) {
    return c.title || c.partNo || c.caseId;
  }

  function caseCard(c) {
    var thumbs = (c.thumbs || []).slice(0, 3).map(function (a) {
      return '<span class="w-10 h-10 rounded-lg overflow-hidden border border-line bg-card block">' +
             thumbImg(a) + '</span>';
    }).join('');

    return '<a href="#/case/' + esc(c.caseId) + '" class="fa-rise block bg-white rounded-2xl border border-line ' +
      'shadow-sm hover:shadow-md transition-all duration-200 p-5' +
      (isVoided(c) ? ' opacity-60' : '') + '">' +
      '<div class="flex items-center gap-2 flex-wrap">' +
        (isVoided(c) ? VOID_BADGE : '') + UI.statusBadge(c.status) + UI.typeBadge(c.type) +
        '<span class="ml-auto text-[10px] font-bold tracking-widest text-muted">' + esc(c.caseId) + '</span>' +
      '</div>' +
      '<h3 class="mt-3 text-base font-black tracking-tight text-ink line-clamp-2">' + esc(caseLabel(c)) + '</h3>' +
      // 標題空白時上面那行已經是料號了，這裡就不要再印一次
      (function () {
        var parts = [];
        if (c.partNo && c.title) parts.push('料號 ' + c.partNo);
        if (c.vendor) parts.push('廠商 ' + c.vendor);
        return parts.length
          ? '<p class="mt-1.5 text-sm font-medium text-ink2 truncate">' +
            parts.map(esc).join(' · ') + '</p>'
          : '';
      })() +
      (thumbs ? '<div class="mt-3 flex gap-1.5">' + thumbs + '</div>' : '') +
      '<div class="mt-4 pt-3 border-t border-[#F0F3F7] flex items-center gap-2 text-xs font-medium text-muted">' +
        UI.avatar(c.createdByName, c.createdBy, 'sm') +
        '<span class="font-bold text-ink2 truncate">' + esc(c.createdByName || c.createdBy) + '</span>' +
        '<span class="ml-auto shrink-0">' + esc(UI.fmtRelative(c.lastActivityAt || c.createdAt)) + '</span>' +
        '<span class="shrink-0">· 留言 ' + (c.commentCount || 0) + '</span>' +
      '</div></a>';
  }

  /* ══════════════ 詳情頁 ══════════════ */

  async function renderDetail(caseId) {
    view.innerHTML = '<a href="#/" class="' + UI.btn.ghost + ' inline-block mb-4 !px-0">&larr; 回列表</a>' +
                     UI.skeleton(2);
    var data;
    try {
      data = await API.getCase(caseId);
    } catch (err) {
      view.innerHTML = '<a href="#/" class="' + UI.btn.ghost + ' inline-block mb-4 !px-0">&larr; 回列表</a>';
      showError(view, err, true);
      return;
    }

    var c = data.case;
    var perm = data.permissions || {};
    var voided = isVoided(c);
    var atts = data.attachments || [];
    var caseAtts = atts.filter(function (a) { return !a.commentId; });

    view.innerHTML =
      '<a href="#/" class="' + UI.btn.ghost + ' inline-block mb-4 !px-0">&larr; 回列表</a>' +
      '<div class="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6 items-start">' +

        '<div class="space-y-4">' +
          // ── 案件本體
          '<div class="bg-white rounded-2xl border border-line shadow-sm p-6">' +
            '<div class="flex items-center gap-2 flex-wrap">' +
              (voided ? VOID_BADGE : '') + UI.statusBadge(c.status) + UI.typeBadge(c.type) +
              '<span class="ml-auto text-[10px] font-bold tracking-widest text-muted">' + esc(c.caseId) + '</span>' +
              (!voided && (perm.canEditContent || perm.canEditCase)
                ? '<button id="btnEditCase" class="text-xs font-bold text-muted hover:text-ink ' +
                  'px-2.5 py-1 rounded-full hover:bg-card transition-colors">編輯</button>'
                : '') +
              (perm.canVoid
                ? '<button id="btnVoidCase" class="text-xs font-bold text-muted hover:text-red-600 ' +
                  'px-2.5 py-1 rounded-full hover:bg-red-50 transition-colors">作廢</button>'
                : '') +
              (perm.canUnvoid
                ? '<button id="btnUnvoidCase" class="text-xs font-bold text-muted hover:text-ink ' +
                  'px-2.5 py-1 rounded-full hover:bg-card transition-colors">復原</button>'
                : '') +
            '</div>' +
            voidBanner(c) +
            '<h1 class="mt-3 text-xl font-black tracking-tight text-ink">' + esc(caseLabel(c)) + '</h1>' +
            '<div class="mt-3 flex items-center gap-2 text-xs font-medium text-muted">' +
              UI.avatar(c.createdByName, c.createdBy, 'sm') +
              '<span class="font-bold text-ink2">' + esc(c.createdByName || c.createdBy) + '</span>' +
              '<span>' + esc(UI.fmtDate(c.createdAt)) + '</span>' +
            '</div>' +
            (c.description
              ? '<div class="mt-4 prose-plain text-sm font-medium text-ink2 leading-relaxed">' +
                UI.linkify(c.description) + '</div>'
              : '') +
            attachmentGrid(caseAtts) +
          '</div>' +

          // ── 狀態操作（作廢的單是凍結的，先復原才能繼續處理）
          (voided ? '' : statusPanel(c, perm)) +

          // ── 留言串（既有留言仍然看得到，歷程才完整）
          '<div id="thread">' + commentThread(data.comments || [], atts) + '</div>' +

          // ── 留言輸入
          (voided ? '' : '<div id="composer" class="bg-white rounded-2xl border border-line shadow-sm p-5"></div>') +
        '</div>' +

        // ── 右側資訊欄
        '<div class="space-y-4 lg:sticky lg:top-24">' +
          metaPanel(c) +
          historyPanel(data.history || [], indexAttachments(data)) +
        '</div>' +
      '</div>';

    if (!voided) {
      mountComposer(c.caseId);
      bindStatusPanel(c, perm);
    }

    var editBtn = document.getElementById('btnEditCase');
    if (editBtn) editBtn.addEventListener('click', function () { openEditCase(data); });

    var voidBtn = document.getElementById('btnVoidCase');
    if (voidBtn) voidBtn.addEventListener('click', function () { askVoid(c); });

    var unvoidBtn = document.getElementById('btnUnvoidCase');
    if (unvoidBtn) unvoidBtn.addEventListener('click', function () { askUnvoid(c); });
  }

  /** 作廢橫幅。原因是後端必填的，所以這裡一定有東西可以顯示。 */
  function voidBanner(c) {
    if (!isVoided(c)) return '';
    var who = c.voidedBy ? esc(String(c.voidedBy).split('@')[0]) : '';
    var when = c.voidedAt ? esc(UI.fmtDate(c.voidedAt)) : '';
    var meta = who || when ? '　' + who + (who && when ? ' · ' : '') + when : '';
    return '<div class="mt-4 rounded-xl border border-line bg-card px-4 py-3">' +
      '<p class="text-[10px] font-bold tracking-widest uppercase text-muted">已作廢' + meta + '</p>' +
      (c.voidReason
        ? '<p class="mt-1.5 text-sm font-medium text-ink2 leading-relaxed">' + UI.linkify(c.voidReason) + '</p>'
        : '') +
      '<p class="mt-2 text-xs font-medium text-muted">' +
        '資料與歷程都保留著，要繼續處理請洽廠務部復原。</p></div>';
  }

  function askVoid(c) {
    var m = UI.modal({
      title: '作廢 ' + c.caseId,
      width: 'sm:max-w-md',
      body:
        '<p class="text-sm font-medium text-ink2 leading-relaxed mb-3">' +
          '作廢之後這張單不會出現在清單裡，也不能再留言或改狀態，但資料和歷程都會留著，' +
          '在「已作廢」篩選裡找得回來。</p>' +
        '<label class="block text-[10px] font-bold tracking-widest uppercase text-muted mb-2">' +
          '作廢原因（必填）</label>' +
        '<textarea id="vdReason" rows="3" class="' + UI.input + ' resize-none" ' +
          'placeholder="例：開重複了，同一批料已經有 FA-2026-0012"></textarea>',
    });
    m.footer.innerHTML =
      '<button id="vdCancel" class="' + UI.btn.ghost + '">取消</button>' +
      '<button id="vdOk" class="' + UI.btn.danger + '">確認作廢</button>';

    m.footer.querySelector('#vdCancel').addEventListener('click', m.close);
    m.footer.querySelector('#vdOk').addEventListener('click', async function () {
      var reason = m.body.querySelector('#vdReason').value.trim();
      if (!reason) {
        UI.toast('請填寫作廢原因', 'error');
        return;
      }
      var btn = this;
      btn.disabled = true; btn.textContent = '處理中…';
      try {
        await API.voidCase(c.caseId, reason);
        m.close();
        UI.toast('已作廢 ' + c.caseId, 'ok');
        renderDetail(c.caseId);
      } catch (err) {
        btn.disabled = false; btn.textContent = '確認作廢';
        UI.toast(err.message, 'error');
      }
    });
  }

  function askUnvoid(c) {
    var m = UI.modal({
      title: '復原 ' + c.caseId,
      width: 'sm:max-w-md',
      body:
        '<p class="text-sm font-medium text-ink2 leading-relaxed mb-3">' +
          '復原後這張單會回到「' + esc(c.status) + '」，重新出現在清單裡。</p>' +
        '<label class="block text-[10px] font-bold tracking-widest uppercase text-muted mb-2">' +
          '說明（選填）</label>' +
        '<textarea id="uvNote" rows="3" class="' + UI.input + ' resize-none" ' +
          'placeholder="例：確認不是重複開單，繼續處理"></textarea>',
    });
    m.footer.innerHTML =
      '<button id="uvCancel" class="' + UI.btn.ghost + '">取消</button>' +
      '<button id="uvOk" class="' + UI.btn.primary + '">確認復原</button>';

    m.footer.querySelector('#uvCancel').addEventListener('click', m.close);
    m.footer.querySelector('#uvOk').addEventListener('click', async function () {
      var btn = this;
      btn.disabled = true; btn.textContent = '處理中…';
      try {
        await API.unvoidCase(c.caseId, m.body.querySelector('#uvNote').value.trim());
        m.close();
        UI.toast('已復原 ' + c.caseId, 'ok');
        renderDetail(c.caseId);
      } catch (err) {
        btn.disabled = false; btn.textContent = '確認復原';
        UI.toast(err.message, 'error');
      }
    });
  }

  /** attachmentId → 附件 DTO。含已移除的，歷程紀錄要靠它把「當時那張圖」畫出來。 */
  function indexAttachments(data) {
    var map = {};
    (data.attachments || []).concat(data.removedAttachments || []).forEach(function (a) {
      map[a.attachmentId] = a;
    });
    return map;
  }

  function statusPanel(c, perm) {
    if (!perm.canSetStatus) {
      return '<div class="bg-card rounded-2xl border border-line p-4">' +
        '<p class="text-xs font-medium text-muted">狀態變更僅限廠務部人員與開單人</p></div>';
    }
    var btns = window.STATUSES.map(function (s) {
      var active = c.status === s;
      return '<button data-status="' + esc(s) + '" ' + (active ? 'disabled' : '') +
        ' class="rounded-full px-4 py-2 text-[13px] font-bold transition-all ' +
        (active ? 'bg-ink text-white cursor-default'
                : 'text-muted hover:text-ink hover:bg-card') + '">' + esc(s) + '</button>';
    }).join('');
    return '<div id="statusPanel" class="bg-white rounded-2xl border border-line shadow-sm p-5">' +
      '<p class="text-[10px] font-bold tracking-widest uppercase text-muted mb-3">變更狀態</p>' +
      '<div class="flex flex-wrap gap-1">' + btns + '</div></div>';
  }

  function bindStatusPanel(c, perm) {
    var panel = document.getElementById('statusPanel');
    if (!panel) return;
    panel.addEventListener('click', function (e) {
      var b = e.target.closest('[data-status]');
      if (!b || b.disabled) return;
      askStatusChange(c, b.dataset.status);
    });
  }

  function askStatusChange(c, status) {
    var closing = status === '已結案';
    var m = UI.modal({
      title: '變更狀態為「' + status + '」',
      width: 'sm:max-w-md',
      body:
        '<label class="block text-[10px] font-bold tracking-widest uppercase text-muted mb-2">' +
          (closing ? '結案說明（必填）' : '說明（選填）') + '</label>' +
        '<textarea id="stNote" rows="4" class="' + UI.input + ' resize-none" ' +
          'placeholder="' + (closing ? '例：已請廠商換貨，8/20 到料，數量已補齊' : '例：先暫緩，等業務確認客戶需求') +
          '"></textarea>',
    });
    m.footer.innerHTML =
      '<button id="stCancel" class="' + UI.btn.ghost + '">取消</button>' +
      '<button id="stOk" class="' + UI.btn.primary + '">確認變更</button>';

    m.footer.querySelector('#stCancel').addEventListener('click', m.close);
    m.footer.querySelector('#stOk').addEventListener('click', async function () {
      var note = m.body.querySelector('#stNote').value.trim();
      if (closing && !note) {
        UI.toast('結案必須填寫說明', 'error');
        return;
      }
      var btn = this;
      btn.disabled = true; btn.textContent = '處理中…';
      try {
        await API.setStatus(c.caseId, status, note);
        m.close();
        UI.toast('已更新為「' + status + '」', 'ok');
        renderDetail(c.caseId);
      } catch (err) {
        btn.disabled = false; btn.textContent = '確認變更';
        UI.toast(err.message, 'error');
      }
    });
  }

  function metaPanel(c) {
    var rows = [
      UI.field('料號', c.partNo), UI.field('品名', c.partName),
      UI.field('廠商', c.vendor), UI.field('採購單號', c.poNo),
      UI.field('數量', c.qty ? (c.qty + ' ' + (c.unit || '')) : ''),
      UI.field('需求日', toDateInput(c.needByDate)),
      UI.field('承辦人', c.assigneeName || c.assignee),
      UI.field('結案說明', c.resolution),
      UI.field('結案時間', c.closedAt ? UI.fmtDate(c.closedAt) : ''),
    ].filter(Boolean).join('');
    if (!rows) return '';
    return '<div class="bg-white rounded-2xl border border-line shadow-sm p-5 space-y-4">' +
      '<p class="text-[10px] font-bold tracking-widest uppercase text-muted">案件資訊</p>' +
      rows + '</div>';
  }

  /* ══════════════ 處理歷程 ══════════════ */

  // History.action 存的是欄位代碼（跟 Cases 分頁的欄名一致），這裡翻成人看的字
  var HIST_LABEL = {
    create: '開單',
    status: '狀態',
    type: '類型',
    title: '標題',
    partNo: '料號',
    partName: '品名',
    vendor: '廠商',
    poNo: '採購單號',
    qty: '數量',
    unit: '單位',
    needByDate: '需求日',
    description: '狀況說明',
    assignee: '承辦人',
    resolution: '處理結果',
    'attachment.add': '新增附件',
    'attachment.remove': '移除附件',
    void: '作廢',
    unvoid: '復原',
  };

  var HIST_INLINE_MAX = 40;   // 超過這個長度的舊值改用可展開的方式顯示

  /**
   * History 存的是原始值，不是給人看的值。兩個要翻譯的：
   *  - assignee 存 email，畫面上一直都是顯示姓名
   *  - needByDate 可能被 Sheets 存成日期值，讀回來是一串 ISO
   */
  function histDisplayValue(action, v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return '';
    if (action === 'assignee') {
      var hit = state.members.filter(function (m) { return m.email === s; })[0];
      return hit ? (hit.name || hit.email) : s;
    }
    if (action === 'needByDate') return toDateInput(s) || s;
    return s;
  }

  /** 與右側窄欄相容的「舊 → 新」；內容太長就收進 details，不把側邊欄撐爆。 */
  function histValueBlock(label, from, to) {
    var f = String(from == null ? '' : from);
    var t = String(to == null ? '' : to);
    var longish = f.length > HIST_INLINE_MAX || t.length > HIST_INLINE_MAX;

    if (!longish) {
      return '<p class="text-sm font-bold text-ink">' + esc(label) + '：' +
        (f ? '<span class="font-medium text-muted line-through">' + esc(f) + '</span> → ' : '') +
        '<span>' + esc(t || '（清空）') + '</span></p>';
    }
    return '<p class="text-sm font-bold text-ink">' + esc(label) + ' 已修改</p>' +
      '<details class="mt-1 group">' +
        '<summary class="text-xs font-bold text-ecoco-blue cursor-pointer select-none list-none">' +
          '看修改前後</summary>' +
        (f ? '<div class="mt-2"><p class="text-[10px] font-bold tracking-widest uppercase text-muted">修改前</p>' +
             '<div class="mt-1 text-xs font-medium text-muted prose-plain bg-card rounded-lg p-2">' +
             esc(f) + '</div></div>' : '') +
        '<div class="mt-2"><p class="text-[10px] font-bold tracking-widest uppercase text-muted">修改後</p>' +
        '<div class="mt-1 text-xs font-medium text-ink2 prose-plain bg-card rounded-lg p-2">' +
        esc(t || '（清空）') + '</div></div>' +
      '</details>';
  }

  /** 附件類的歷程：要看得到那張圖本人，不然「換過圖」等於沒留到。 */
  function histAttachmentBlock(h, attMap) {
    var att = attMap[h.refId];
    var name = att ? att.fileName : (h.toValue || h.fromValue);
    var removed = h.action === 'attachment.remove';

    var head = '<p class="text-sm font-bold text-ink">' + esc(HIST_LABEL[h.action]) + '：' +
      '<span class="' + (removed ? 'font-medium text-muted line-through' : '') + '">' +
      esc(name || '（未知檔案）') + '</span></p>';

    if (!att) return head;
    if (/^image\//.test(att.mimeType)) {
      return head +
        '<a href="' + esc(att.viewUrl) + '" target="_blank" rel="noopener" ' +
          'class="mt-2 block w-20 h-20 rounded-lg overflow-hidden border border-line bg-card ' +
          (removed ? 'opacity-70 hover:opacity-100 ' : '') + 'transition-opacity">' +
          thumbImg(att) + '</a>';
    }
    return head +
      '<a href="' + esc(att.viewUrl) + '" target="_blank" rel="noopener" ' +
        'class="mt-1 inline-block text-xs font-bold text-ecoco-blue">開啟檔案</a>';
  }

  function histEntryBlock(h, attMap) {
    if (h.action === 'create') {
      return '<p class="text-sm font-bold text-ink">開單</p>';
    }
    if (h.action === 'attachment.add' || h.action === 'attachment.remove') {
      return histAttachmentBlock(h, attMap);
    }
    return histValueBlock(HIST_LABEL[h.action] || h.action,
      histDisplayValue(h.action, h.fromValue), histDisplayValue(h.action, h.toValue));
  }

  /**
   * 一次編輯改五個欄位就會產生五列 History，分開畫會把時間軸淹掉。
   * 後端在同一次 cases.update 裡共用同一個時間戳，這裡就按「時間＋人」併成一組。
   */
  function groupHistory(history) {
    var groups = [];
    history.forEach(function (h) {
      var last = groups[groups.length - 1];
      if (last && last.at === h.at && last.actorEmail === h.actorEmail) {
        last.entries.push(h);
        if (!last.note && h.note) last.note = h.note;
        return;
      }
      groups.push({
        at: h.at, actorEmail: h.actorEmail, actorName: h.actorName,
        note: h.note || '', entries: [h],
      });
    });
    return groups;
  }

  function historyPanel(history, attMap) {
    history = history || [];
    attMap = attMap || {};
    if (!history.length) return '';

    var groups = groupHistory(history);   // 舊到新，與下方留言串的方向一致

    return '<div class="bg-white rounded-2xl border border-line shadow-sm p-5">' +
      '<p class="text-[10px] font-bold tracking-widest uppercase text-muted mb-4">處理紀錄</p>' +
      '<div class="space-y-4">' + groups.map(function (g) {
        return '<div class="relative pl-5 border-l-2 border-[#F0F3F7]">' +
          '<span class="absolute -left-[5px] top-1.5 w-2 h-2 rounded-full bg-ecoco-orange"></span>' +
          '<div class="space-y-2">' +
            g.entries.map(function (h) { return histEntryBlock(h, attMap); }).join('') +
          '</div>' +
          '<p class="text-xs font-medium text-muted mt-1">' +
            esc(g.actorName || g.actorEmail) + ' · ' + esc(UI.fmtDate(g.at)) + '</p>' +
          (g.note ? '<p class="mt-1 text-xs font-medium text-ink2 prose-plain">' + esc(g.note) + '</p>' : '') +
        '</div>';
      }).join('') + '</div></div>';
  }

  function commentThread(comments, atts) {
    // 後端是軟刪除，理論上不會回傳已刪除的留言，這裡再擋一次
    comments = (comments || []).filter(function (c) { return !c.isDeleted; });
    if (!comments.length) {
      return '<div class="bg-white rounded-2xl border border-line shadow-sm py-10 text-center">' +
        '<p class="text-sm font-medium text-muted">還沒有留言，先說明一下狀況吧</p></div>';
    }
    var me = (Auth.getUser() || {}).email;
    return '<div class="space-y-3">' + comments.map(function (cm) {
      var mine = cm.authorEmail === me;
      var own = atts.filter(function (a) { return a.commentId === cm.commentId; });
      return '<div class="bg-white rounded-2xl border border-line shadow-sm p-5' +
        (cm.parentId ? ' ml-6 border-l-2 border-l-[#F0F3F7]' : '') + '">' +
        '<div class="flex items-center gap-2">' +
          UI.avatar(cm.authorName, cm.authorEmail, 'sm') +
          '<div class="min-w-0">' +
            '<p class="text-sm font-bold text-ink truncate">' + esc(cm.authorName || cm.authorEmail) + '</p>' +
            '<p class="text-[10px] font-medium text-muted truncate">' + esc(cm.authorEmail) + '</p>' +
          '</div>' +
          '<span class="ml-auto text-xs font-medium text-muted shrink-0">' +
            esc(UI.fmtRelative(cm.createdAt)) + (cm.isEdited ? '（已編輯）' : '') + '</span>' +
        '</div>' +
        (String(cm.body || '').trim()
          ? '<div class="mt-3 prose-plain text-sm font-medium text-ink2 leading-relaxed">' +
            UI.linkify(cm.body) + '</div>'
          : '') +
        attachmentGrid(own) +
        (mine ? '<div class="mt-3 flex gap-1">' +
          '<button data-edit="' + esc(cm.commentId) + '" class="text-xs font-bold text-muted hover:text-ink px-2 py-1 rounded-full hover:bg-card">編輯</button>' +
          '<button data-del="' + esc(cm.commentId) + '" class="text-xs font-bold text-muted hover:text-red-600 px-2 py-1 rounded-full hover:bg-card">刪除</button>' +
          '</div>' : '') +
      '</div>';
    }).join('') + '</div>';
  }

  function mountComposer(caseId) {
    var box = document.getElementById('composer');
    var up = makeUploader();

    box.innerHTML =
      '<p class="text-[10px] font-bold tracking-widest uppercase text-muted mb-3">回覆</p>' +
      '<textarea id="cmBody" rows="4" class="' + UI.input + ' resize-y" ' +
        'placeholder="說明狀況、補充資訊、或回覆廠務部…"></textarea>' +
      '<div id="cmUp" class="mt-3"></div>' +
      '<div class="mt-4 flex justify-end">' +
        '<button id="cmSend" class="' + UI.btn.primary + '">送出留言</button>' +
      '</div>';
    box.querySelector('#cmUp').appendChild(up.el);

    var textarea = box.querySelector('#cmBody');
    var draftKey = 'faDraft:' + caseId;
    try {
      var d = localStorage.getItem(draftKey);
      if (d) textarea.value = d;
    } catch (e) {}
    textarea.addEventListener('input', function () {
      try { localStorage.setItem(draftKey, textarea.value); } catch (e) {}
    });

    box.querySelector('#cmSend').addEventListener('click', async function () {
      var body = textarea.value.trim();
      if (!body && !up.count()) { UI.toast('請先輸入內容', 'error'); return; }
      var btn = this;
      btn.disabled = true; btn.textContent = '送出中…';
      try {
        await API.addComment({ caseId: caseId, body: body, attachments: up.payload() });
        try { localStorage.removeItem(draftKey); } catch (e) {}
        UI.toast('已送出', 'ok');
        renderDetail(caseId);
      } catch (err) {
        btn.disabled = false; btn.textContent = '送出留言';
        UI.toast(err.message, 'error');
      }
    });

    // 留言的編輯 / 刪除
    var thread = document.getElementById('thread');
    thread.addEventListener('click', async function (e) {
      var del = e.target.closest('[data-del]');
      if (del) {
        if (!confirm('確定要刪除這則留言？')) return;
        try {
          await API.deleteComment(del.dataset.del);
          UI.toast('已刪除', 'ok');
          renderDetail(caseId);
        } catch (err) { UI.toast(err.message, 'error'); }
        return;
      }
      var ed = e.target.closest('[data-edit]');
      if (ed) editComment(ed.dataset.edit, caseId);
    });
  }

  function editComment(commentId, caseId) {
    var card = document.querySelector('[data-edit="' + commentId + '"]').closest('.bg-white');
    var current = card.querySelector('.prose-plain').textContent;
    var m = UI.modal({
      title: '編輯留言',
      width: 'sm:max-w-lg',
      body: '<textarea id="edBody" rows="6" class="' + UI.input + ' resize-y">' + esc(current) + '</textarea>',
    });
    m.footer.innerHTML = '<button id="edCancel" class="' + UI.btn.ghost + '">取消</button>' +
                         '<button id="edOk" class="' + UI.btn.primary + '">儲存</button>';
    m.footer.querySelector('#edCancel').addEventListener('click', m.close);
    m.footer.querySelector('#edOk').addEventListener('click', async function () {
      var body = m.body.querySelector('#edBody').value.trim();
      if (!body) { UI.toast('內容不能空白', 'error'); return; }
      this.disabled = true;
      try {
        await API.editComment(commentId, body);
        m.close();
        renderDetail(caseId);
      } catch (err) {
        this.disabled = false;
        UI.toast(err.message, 'error');
      }
    });
  }

  /* ══════════════ 開單 Modal ══════════════ */

  function openNewCase() {
    var up = makeUploader();
    var typeSel = null;   // mountTypeChips 要等 modal body 建好才能掛上去

    var lbl = 'block text-[10px] font-bold tracking-widest uppercase text-muted mb-1.5';

    var m = UI.modal({
      title: '開新異常單',
      body:
        '<div class="space-y-5">' +
          '<div>' +
            '<label class="' + lbl + '">異常類型 <span class="text-ecoco-orange">*</span></label>' +
            '<div id="typeRow" class="flex flex-wrap gap-2"></div>' +
          '</div>' +
          '<div>' +
            '<label id="lblPartNo" class="' + lbl + '">料號 <span class="text-ecoco-orange">*</span></label>' +
            '<input id="fPartNo" class="' + UI.input + '" placeholder="例：A-1023">' +
          '</div>' +
          '<div>' +
            '<label class="' + lbl + '">標題</label>' +
            '<input id="fTitle" class="' + UI.input + '" placeholder="選填，不填就用料號顯示">' +
          '</div>' +
          '<div class="grid grid-cols-2 gap-3">' +
            '<div><label class="' + lbl + '">品名</label><input id="fPartName" class="' + UI.input + '"></div>' +
            '<div><label class="' + lbl + '">廠商</label><input id="fVendor" class="' + UI.input + '"></div>' +
            '<div><label class="' + lbl + '">採購單號</label><input id="fPoNo" class="' + UI.input + '"></div>' +
            '<div><label class="' + lbl + '">數量</label><input id="fQty" type="number" class="' + UI.input + '"></div>' +
            '<div><label class="' + lbl + '">單位</label><input id="fUnit" class="' + UI.input + '" placeholder="PCS / KG / 箱"></div>' +
          '</div>' +
          '<div>' +
            '<label class="' + lbl + '">狀況說明 <span class="text-ecoco-orange">*</span></label>' +
            '<textarea id="fDesc" rows="6" class="' + UI.input + ' resize-y" ' +
              'placeholder="請說明發生什麼事、影響什麼、希望廠務部怎麼處理"></textarea>' +
          '</div>' +
          '<div>' +
            '<label class="' + lbl + '">附件</label>' +
            '<div id="newUp"></div>' +
          '</div>' +
        '</div>',
      onClose: saveDraft,
    });
    m.body.querySelector('#newUp').appendChild(up.el);

    m.footer.innerHTML =
      '<button id="ncCancel" class="' + UI.btn.ghost + '">取消</button>' +
      '<button id="ncOk" class="' + UI.btn.primary + '">送出異常單</button>';

    var $ = function (id) { return m.body.querySelector('#' + id); };

    // 「其他」類型不強制填料號，標記與 placeholder 要跟著切換，
    // 否則使用者看到星號卻送得出去（或反過來）會很困惑
    function partNoOptional() { return typeSel.get() === '其他'; }

    // 類型 chip 單選（跟編輯 Modal 共用同一個元件）
    typeSel = mountTypeChips(m.body.querySelector('#typeRow'), '', function () {
      var el = $('lblPartNo');
      if (!el) return;
      el.innerHTML = partNoOptional()
        ? '料號 <span class="text-muted">（選填）</span>'
        : '料號 <span class="text-ecoco-orange">*</span>';
      $('fPartNo').placeholder = partNoOptional() ? '此類型可不填' : '例：A-1023';
    });

    // 草稿（只存文字，不存附件）
    var DRAFT = 'faNewDraft';
    function saveDraft() {
      try {
        localStorage.setItem(DRAFT, JSON.stringify({
          type: typeSel.get(), title: $('fTitle').value, partNo: $('fPartNo').value,
          partName: $('fPartName').value, vendor: $('fVendor').value, poNo: $('fPoNo').value,
          qty: $('fQty').value, unit: $('fUnit').value, desc: $('fDesc').value,
        }));
      } catch (e) {}
    }
    try {
      var d = JSON.parse(localStorage.getItem(DRAFT) || 'null');
      if (d) {
        $('fTitle').value = d.title || ''; $('fPartNo').value = d.partNo || '';
        $('fPartName').value = d.partName || ''; $('fVendor').value = d.vendor || '';
        $('fPoNo').value = d.poNo || ''; $('fQty').value = d.qty || '';
        $('fUnit').value = d.unit || ''; $('fDesc').value = d.desc || '';
        if (d.type && window.CASE_TYPES.indexOf(d.type) !== -1) typeSel.set(d.type);
      }
    } catch (e) {}

    m.footer.querySelector('#ncCancel').addEventListener('click', m.close);
    m.footer.querySelector('#ncOk').addEventListener('click', async function () {
      if (!typeSel.get()) { UI.toast('請選擇異常類型', 'error'); return; }
      if (!partNoOptional() && !$('fPartNo').value.trim()) {
        UI.toast('請填寫料號', 'error'); return;
      }
      if (!$('fDesc').value.trim()) { UI.toast('請填寫狀況說明', 'error'); return; }

      var btn = this;
      btn.disabled = true; btn.textContent = '送出中…';
      try {
        var res = await API.createCase({
          type: typeSel.get(),
          title: $('fTitle').value.trim(),
          partNo: $('fPartNo').value.trim(),
          partName: $('fPartName').value.trim(),
          vendor: $('fVendor').value.trim(),
          poNo: $('fPoNo').value.trim(),
          qty: $('fQty').value.trim(),
          unit: $('fUnit').value.trim(),
          description: $('fDesc').value.trim(),
          attachments: up.payload(),
        });
        try { localStorage.removeItem(DRAFT); } catch (e) {}
        m.close();
        UI.toast('已建立 ' + res.case.caseId, 'ok');
        location.hash = '#/case/' + res.case.caseId;
      } catch (err) {
        btn.disabled = false; btn.textContent = '送出異常單';
        UI.toast(err.message, 'error');
      }
    });
  }

  /* ══════════════ 編輯 Modal ══════════════ */

  /** Sheets 可能把日期欄存成日期值，讀回來是 ISO 字串；<input type=date> 只吃 yyyy-MM-dd。 */
  function toDateInput(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    var d = new Date(s);
    if (isNaN(d)) return '';
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /**
   * 編輯一張異常單。
   *
   * 畫面依後端給的兩層權限決定要長出哪幾段（規則見 apps-script/Auth.gs）：
   *   canEditContent  類型、料號、描述、附件 —— 個人改個人的單（開單人與 admin）
   *   canEditCase     承辦人、處理結果 —— 廠務部要能接手處理，所以寬一級
   * 兩個都沒有的人根本看不到「編輯」按鈕；這裡再擋一次是因為權限判斷一律以後端為準。
   *
   * 欄位、要加的附件、要移除的附件合成一個 cases.update 送出去，
   * 因為每趟 /exec 固定要 ~1.15 秒，拆開送「換一張圖」就要等三倍。
   *
   * 移除附件是軟刪除：舊圖還在，只是不再出現在主畫面，
   * 要回頭看就到右側「處理紀錄」點那張縮圖。
   */
  function openEditCase(data) {
    var c = data.case;
    var perm = data.permissions || {};
    var canContent = !!perm.canEditContent;
    var canHandle = !!perm.canEditCase;
    if (!canContent && !canHandle) return;

    var current = (data.attachments || []).filter(function (a) { return !a.commentId; });
    var removeIds = {};
    var up = canContent ? makeUploader() : null;
    var typeSel = null;

    var lbl = 'block text-[10px] font-bold tracking-widest uppercase text-muted mb-1.5';

    var memberOpts = ['<option value="">（未指派）</option>'].concat(
      state.members.map(function (m) {
        return '<option value="' + esc(m.email) + '"' +
          (m.email === c.assignee ? ' selected' : '') + '>' +
          esc(m.name || m.email) + '</option>';
      })
    ).join('');

    var contentBlock = !canContent ? '' :
      '<div>' +
        '<label class="' + lbl + '">異常類型 <span class="text-ecoco-orange">*</span></label>' +
        '<div id="edTypeRow" class="flex flex-wrap gap-2"></div>' +
      '</div>' +
      '<div>' +
        '<label id="edLblPartNo" class="' + lbl + '">料號</label>' +
        '<input id="ePartNo" class="' + UI.input + '" value="' + esc(c.partNo || '') + '">' +
      '</div>' +
      '<div>' +
        '<label class="' + lbl + '">標題</label>' +
        '<input id="eTitle" class="' + UI.input + '" placeholder="選填，不填就用料號顯示" ' +
          'value="' + esc(c.title || '') + '">' +
      '</div>' +
      '<div class="grid grid-cols-2 gap-3">' +
        '<div><label class="' + lbl + '">品名</label>' +
          '<input id="ePartName" class="' + UI.input + '" value="' + esc(c.partName || '') + '"></div>' +
        '<div><label class="' + lbl + '">廠商</label>' +
          '<input id="eVendor" class="' + UI.input + '" value="' + esc(c.vendor || '') + '"></div>' +
        '<div><label class="' + lbl + '">採購單號</label>' +
          '<input id="ePoNo" class="' + UI.input + '" value="' + esc(c.poNo || '') + '"></div>' +
        '<div><label class="' + lbl + '">數量</label>' +
          '<input id="eQty" type="number" class="' + UI.input + '" value="' + esc(c.qty || '') + '"></div>' +
        '<div><label class="' + lbl + '">單位</label>' +
          '<input id="eUnit" class="' + UI.input + '" value="' + esc(c.unit || '') + '"></div>' +
        '<div><label class="' + lbl + '">需求日</label>' +
          '<input id="eNeedBy" type="date" class="' + UI.input + '" value="' + esc(toDateInput(c.needByDate)) + '"></div>' +
      '</div>' +
      '<div>' +
        '<label class="' + lbl + '">狀況說明 <span class="text-ecoco-orange">*</span></label>' +
        '<textarea id="eDesc" rows="6" class="' + UI.input + ' resize-y">' + esc(c.description || '') + '</textarea>' +
      '</div>' +
      (current.length
        ? '<div>' +
            '<label class="' + lbl + '">現有附件</label>' +
            '<p class="text-xs font-medium text-muted mb-2">移除的檔案不會消失，' +
              '會留在右側「處理紀錄」裡隨時可以回頭看</p>' +
            '<div id="edExisting" class="grid grid-cols-3 sm:grid-cols-4 gap-2"></div>' +
          '</div>'
        : '') +
      '<div>' +
        '<label class="' + lbl + '">新增附件</label>' +
        '<div id="edUp"></div>' +
      '</div>';

    var handlingBlock = !canHandle ? '' :
      '<div>' +
        '<label class="' + lbl + '">承辦人</label>' +
        '<select id="eAssignee" class="' + UI.input + '">' + memberOpts + '</select>' +
      '</div>' +
      '<div>' +
        '<label class="' + lbl + '">處理結果</label>' +
        '<textarea id="eResolution" rows="3" class="' + UI.input + ' resize-y" ' +
          'placeholder="結案前必須填寫">' + esc(c.resolution || '') + '</textarea>' +
      '</div>';

    // 廠務部改別人的單時，畫面上只會有處理欄位，要講清楚為什麼看不到內容欄位
    var contentHint = canContent ? '' :
      '<div class="bg-card rounded-xl px-4 py-3">' +
        '<p class="text-xs font-medium text-ink2 leading-relaxed">' +
          '案件內容（料號、狀況說明、附件）只有開單人能修改。' +
          '要補充資訊或附照片，請直接在下方留言。</p>' +
      '</div>';

    var m = UI.modal({
      title: '編輯 ' + c.caseId,
      body: '<div class="space-y-5">' + contentHint + contentBlock + handlingBlock +
        '<div>' +
          '<label class="' + lbl + '">修改原因（選填）</label>' +
          '<input id="eNote" class="' + UI.input + '" placeholder="例：廠商重拍了清楚的缺陷照片">' +
        '</div>' +
      '</div>',
    });

    var $ = function (id) { return m.body.querySelector('#' + id); };

    if (canContent) {
      m.body.querySelector('#edUp').appendChild(up.el);

      // 類型 chip 跟開單共用；「其他」不強制填料號，星號要跟著切
      typeSel = mountTypeChips($('edTypeRow'), c.type, function (t) {
        var el = $('edLblPartNo');
        if (!el) return;
        el.innerHTML = t === '其他'
          ? '料號 <span class="text-muted">（選填）</span>'
          : '料號 <span class="text-ecoco-orange">*</span>';
      });
    }

    // 現有附件：點一下切換「要不要移除」，真正送出才生效
    var existingBox = $('edExisting');
    function paintExisting() {
      if (!existingBox) return;
      existingBox.innerHTML = current.map(function (a) {
        var marked = !!removeIds[a.attachmentId];
        var inner = /^image\//.test(a.mimeType)
          ? thumbImg(a)
          : '<div class="w-full h-full flex items-center justify-center px-1 text-[10px] font-bold ' +
            'text-muted text-center break-all">' + esc(a.fileName) + '</div>';
        return '<div class="relative aspect-square rounded-xl overflow-hidden border bg-card transition-all ' +
          (marked ? 'border-red-400 opacity-40' : 'border-line') + '">' + inner +
          '<button type="button" data-att="' + esc(a.attachmentId) + '" ' +
            'class="absolute top-1 right-1 w-6 h-6 rounded-full text-white text-sm leading-none ' +
            'transition-colors ' + (marked ? 'bg-green-500' : 'bg-ink/70 hover:bg-red-600') + '" ' +
            'title="' + (marked ? '取消移除' : '移除') + '">' +
            (marked ? '&#8634;' : '&times;') + '</button></div>';
      }).join('');
    }
    paintExisting();
    if (existingBox) {
      existingBox.addEventListener('click', function (e) {
        var b = e.target.closest('[data-att]');
        if (!b) return;
        var id = b.dataset.att;
        if (removeIds[id]) delete removeIds[id]; else removeIds[id] = true;
        paintExisting();
      });
    }

    m.footer.innerHTML =
      '<button id="edCancel" class="' + UI.btn.ghost + '">取消</button>' +
      '<button id="edSave" class="' + UI.btn.primary + '">儲存修改</button>';
    m.footer.querySelector('#edCancel').addEventListener('click', m.close);

    m.footer.querySelector('#edSave').addEventListener('click', async function () {
      // 只收「這次真的畫出來」的欄位。沒有權限的那一組完全不進 patch，
      // 免得送出去被後端以 FORBIDDEN 擋掉整包。
      var next = {};
      if (canContent) {
        next.type = typeSel.get();
        next.title = $('eTitle').value.trim();
        next.partNo = $('ePartNo').value.trim();
        next.partName = $('ePartName').value.trim();
        next.vendor = $('eVendor').value.trim();
        next.poNo = $('ePoNo').value.trim();
        next.qty = $('eQty').value.trim();
        next.unit = $('eUnit').value.trim();
        next.needByDate = $('eNeedBy').value.trim();
        next.description = $('eDesc').value.trim();

        if (!next.type) { UI.toast('請選擇異常類型', 'error'); return; }
        if (next.type !== '其他' && !next.partNo) { UI.toast('請填寫料號', 'error'); return; }
        if (!next.description) { UI.toast('請填寫狀況說明', 'error'); return; }
      }
      if (canHandle) {
        next.assignee = $('eAssignee').value.trim();
        next.resolution = $('eResolution').value.trim();
      }

      // 只送真的改過的欄位。後端雖然也會 diff，但整包送出去會把
      // 「別人在我開著這個 Modal 的期間改掉的欄位」一起蓋回舊值。
      var before = {
        type: c.type, title: c.title, partNo: c.partNo, partName: c.partName,
        vendor: c.vendor, poNo: c.poNo, qty: c.qty, unit: c.unit,
        needByDate: toDateInput(c.needByDate), description: c.description,
        assignee: c.assignee, resolution: c.resolution,
      };
      var patch = {};
      Object.keys(next).forEach(function (k) {
        if (next[k] !== String(before[k] == null ? '' : before[k]).trim()) patch[k] = next[k];
      });

      var toRemove = Object.keys(removeIds);
      var toAdd = up ? up.payload() : [];
      if (!Object.keys(patch).length && !toRemove.length && !toAdd.length) {
        UI.toast('沒有任何修改');
        return;
      }

      var btn = this;
      btn.disabled = true; btn.textContent = '儲存中…';
      try {
        await API.updateCase(c.caseId, patch, {
          addAttachments: toAdd,
          removeAttachmentIds: toRemove,
          note: $('eNote').value.trim(),
        });
        m.close();
        UI.toast('已儲存修改', 'ok');
        renderDetail(c.caseId);
      } catch (err) {
        btn.disabled = false; btn.textContent = '儲存修改';
        UI.toast(err.message, 'error');
      }
    });
  }

  /* ══════════════ 錯誤顯示 ══════════════ */

  function showError(box, err, replace) {
    if (!box) return;
    var html = '<div class="bg-white rounded-2xl border border-red-200 p-6">' +
      '<p class="text-[10px] font-bold tracking-widest uppercase text-red-600 mb-2">載入失敗</p>' +
      '<p class="text-sm font-medium text-ink2 leading-relaxed">' + esc(err.message) + '</p></div>';
    if (replace) box.insertAdjacentHTML('beforeend', html);
    else box.innerHTML = html;
  }

  /* ══════════════ 路由 ══════════════ */

  async function route() {
    if (!Auth.getUser()) return;
    var hash = location.hash || '#/';
    var m = hash.match(/^#\/case\/(.+)$/);
    window.scrollTo(0, 0);
    if (m) return renderDetail(decodeURIComponent(m[1]));

    // 開站的第一次渲染直接用 session.login/resume 那趟帶回來的資料，不再多打 API
    var boot = Auth.takeBoot();
    if (boot) {
      state.stats = boot.stats || null;
      pendingMeta = boot.meta || null;
      applyMeta(pendingMeta);
      return renderList(boot.list);
    }
    return renderList();
  }

  /* ══════════════ 啟動 ══════════════ */

  function bindHeader(u) {
    document.getElementById('userAvatar').textContent = UI.initials(u.name, u.email);
    document.getElementById('userName').textContent = u.name || u.email;
    document.getElementById('menuName').textContent = u.name || '';
    document.getElementById('menuEmail').textContent = u.email;
    document.getElementById('menuRole').textContent =
      u.role === 'admin' ? '管理員' : u.role === 'facility' ? '廠務部' : '一般使用者';

    var sheet = document.getElementById('menuSheet');
    if (window.CONFIG.SHEET_URL) sheet.href = window.CONFIG.SHEET_URL;
    else sheet.classList.add('hidden');

    var menu = document.getElementById('userMenu');
    document.getElementById('btnUser').addEventListener('click', function (e) {
      e.stopPropagation();
      menu.classList.toggle('hidden');
    });
    document.addEventListener('click', function () { menu.classList.add('hidden'); });
    document.getElementById('btnLogout').addEventListener('click', function () { Auth.logout(); });
    document.getElementById('btnNew').addEventListener('click', openNewCase);
  }

  function applyMeta(meta) {
    if (!meta) return;
    state.members = meta.members || [];
    if (meta.config && meta.config.sheetUrl && !window.CONFIG.SHEET_URL) {
      var el = document.getElementById('menuSheet');
      if (el) { el.href = meta.config.sheetUrl; el.classList.remove('hidden'); }
    }
  }

  var pendingMeta = null;
  var started = false;

  Auth.init(function (u) {
    view = document.getElementById('view');
    if (!started) {
      started = true;
      bindHeader(u);
      window.addEventListener('hashchange', route);
      applyMeta(pendingMeta);
    }
    route();
  });
})();
