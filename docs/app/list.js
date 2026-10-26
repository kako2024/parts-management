/**
 * app/list.js — 一覧の取得・描画、検索と絞り込み、写真を表示サイズで取る URL
 * 読み込む順と各ファイルの役割は app/core.js の冒頭にある。
 */
'use strict';

/* ================================================================
 * 一覧
 * ==============================================================*/

var listRenderedOnce = false;

/** 取得した一覧を state に入れて描画する */
function showItems(items) {
  // 前回のデータで出した一覧と同じなら描き直さない（写真の読み込みをやり直させないため）
  var same = listRenderedOnce && sameJson(items, state.items);
  state.items = items;
  if (!same) renderList();
  if (!listRenderedOnce) {
    listRenderedOnce = true;
    whenIdle(function () {
      PERF.end('A 起動→一覧');
      PERF.watchImages('D 一覧写真', $('#item-list'));
    });
  }
}

/** @param {{background: boolean}=} opts background なら「読み込み中」の覆いを出さない */
function loadItems(opts) {
  var background = !!(opts && opts.background);
  var filters = JSON.stringify(state.filters);
  var seq = state.writeSeq;
  if (!background) loading(true, '備品を読み込み中…');
  setListFresh({ status: 'checking' });
  return api('getItems', state.filters)
    .then(function (data) {
      PERF.mark('A 起動→一覧', 'getItems');
      if (filters !== JSON.stringify(state.filters)) return; // 取得中に絞り込みが変わった
      if (seq !== state.writeSeq) {                          // 取得中に手元で更新した（この一覧は更新前）
        setListFresh({ status: 'none' });
        return;
      }
      state.fresh.list = { status: 'fresh', confirmedAt: Date.now(), listKey: filters };
      showItems(applyRestockFilter(data.items || []));
      rememberList(data.items || []);
      renderSync();
    })
    .catch(function (err) {
      if (filters !== JSON.stringify(state.filters)) return;
      // 表示中の一覧が今の絞り込みの結果でなければ、それを見せ続けない（絞り込んだ結果と取り違えるため）
      if (state.fresh.list.listKey !== filters) {
        state.items = [];
        state.fresh.list = { status: failureStatus(err), confirmedAt: null, listKey: null };
        renderList();
      }
      setListFresh({ status: failureStatus(err) });
      toast(err.message || '取得に失敗しました', 'error');
    })
    .then(function () { if (!background) loading(false); }, function () { if (!background) loading(false); });
}

/* ---------- 写真の大きさ（PERF.md 項目 7） ----------
 * Drive の写真（https://lh3.googleusercontent.com/d/＜ID＞）は、末尾に「=w128-h128-c」などを付けると
 * その大きさに縮めた画像が返る。表示する大きさに合わせて取り、転送量を減らす。
 * それ以外の URL（選んだばかりの写真の data URL など）はそのまま使う。
 *
 * 写真の img には referrerpolicy="no-referrer"（PHOTO_REFERRER）を付ける。lh3 は Referer 付きの要求が
 * 同時に重なると 429 を HTML で返し、ブラウザはそれを ORB で遮る（PERF.md 2.4）。Referer が無ければ 429 にならない。
 */
var PHOTO_REFERRER = ' referrerpolicy="no-referrer"';
var DRIVE_PHOTO_RE = /^https:\/\/lh3\.googleusercontent\.com\/d\/[^=\/?#]+$/;

function devicePixelScale() {
  return Math.min(3, Math.max(1, Math.round(window.devicePixelRatio || 1)));
}

/** 一覧のサムネイル（64px 角）用。画面の画素密度に合わせた正方形に切り抜いて取る */
function thumbUrl(url) {
  if (!DRIVE_PHOTO_RE.test(url)) return url;
  var px = 64 * devicePixelScale();
  return url + '=w' + px + '-h' + px + '-c';
}

/** 詳細（画面幅いっぱい）用。画面の幅に合わせて取る（100px 刻み、元の大きさ 1280px まで） */
function detailPhotoUrl(url) {
  if (!DRIVE_PHOTO_RE.test(url)) return url;
  var w = Math.min(1280, Math.ceil(window.innerWidth * devicePixelScale() / 100) * 100);
  return url + '=w' + w;
}

function renderList() {
  var box = $('#item-list');
  hide($('#btn-photo-reload-list')); // 描き直すと写真は取り直される
  $('#list-count').textContent = (state.filters.restock ? '要補充 ' : '') + state.items.length + ' 件';

  if (!state.items.length) {
    // 取得できなかったのに「該当なし」と見せない（PLAN-2 項目 3）
    var f = state.fresh.list;
    var failed = (f.status === 'offline' || f.status === 'error') && f.listKey !== JSON.stringify(state.filters);
    $('#list-count').textContent = failed ? '' : (state.filters.restock ? '要補充 ' : '') + '0 件';
    box.innerHTML = failed
      ? '<div id="list-failed" class="text-center py-16 text-rose-600">' +
        '  <div class="text-5xl mb-3">📡</div>' +
        '  <p class="text-sm">' + (f.status === 'offline' ? '通信できないため、' : '') + '一覧を取得できませんでした</p>' +
        '  <p class="text-xs text-slate-500 mt-1">通信できる場所で「再試行」を押してください</p>' +
        '</div>'
      : '<div id="list-empty" class="text-center py-16 text-slate-400">' +
        '  <div class="text-5xl mb-3">' + (state.filters.restock && filtersOnlyRestock() ? '✅' : '🔍') + '</div>' +
        '  <p class="text-sm">' + (state.filters.restock && filtersOnlyRestock() ? '補充が必要な備品はありません' : '該当する備品がありません') + '</p>' +
        '</div>';
    return;
  }

  box.innerHTML = state.items.map(function (it) {
    var thumb = it.photo_url
      ? '<img src="' + esc(thumbUrl(it.photo_url)) + '" alt="" loading="lazy" decoding="async" width="64" height="64" data-thumb="1"' + PHOTO_REFERRER + ' ' +
        'class="w-16 h-16 rounded-xl object-cover bg-slate-200 shrink-0">'
      : '<div class="w-16 h-16 rounded-xl bg-slate-200 shrink-0 flex items-center justify-center text-2xl">📦</div>';

    var qty = (it.quantity === null || it.quantity === '') ? '' :
      '<span class="text-xs text-slate-500">残 ' + esc(it.quantity) + '</span>';

    return '' +
      '<button class="w-full text-left bg-white rounded-2xl p-3 shadow-sm active:bg-slate-50 flex gap-3 items-center" ' +
      '        data-item-id="' + esc(it.item_id) + '">' +
      thumb +
      '  <div class="flex-1 min-w-0">' +
      '    <div class="flex items-center gap-2">' +
      '      <span class="badge ' + statusClass(it.stock_status) + '">' + esc(it.stock_status || '未設定') + '</span>' +
           qty +
      '    </div>' +
      '    <p class="mt-1 font-semibold text-[15px] truncate">' + esc(it.name) + '</p>' +
      '    <p class="text-xs text-slate-500 truncate">' +
           [it.spec, it.location].filter(Boolean).map(esc).join(' ・ ') + '</p>' +
      '  </div>' +
      '  <svg class="w-5 h-5 text-slate-300 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">' +
      '    <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>' +
      '</button>';
  }).join('');
}

/** 「要補充」で出す在庫ステータス（PLAN-2 項目 5。GAS の CONST.RESTOCK_STATUSES と同じ） */
var RESTOCK_STATUSES = ['残りわずか', '在庫なし'];

/** 要補充で絞り込んでいれば、その在庫ステータスだけにする（要補充に対応していない古い GAS の応答にも備える） */
function applyRestockFilter(items) {
  if (!state.filters.restock) return items;
  return items.filter(function (it) { return RESTOCK_STATUSES.indexOf(it.stock_status) !== -1; });
}

function rebuildFilterOptions() {
  $('#btn-restock').classList.toggle('active', !!state.filters.restock);
  $('#btn-restock').setAttribute('aria-pressed', state.filters.restock ? 'true' : 'false');
  fillSelect($('#filter-status'), '在庫: すべて', state.meta.stockStatuses, state.filters.stock_status);
  fillSelect($('#filter-category'), 'カテゴリ: すべて', state.meta.categories, state.filters.category);
  fillSelect($('#filter-location'), '場所: すべて', state.meta.locations, state.filters.location);
}

function fillSelect(sel, placeholder, values, current) {
  sel.innerHTML = '<option value="">' + esc(placeholder) + '</option>' +
    (values || []).map(function (v) {
      return '<option value="' + esc(v) + '"' + (v === current ? ' selected' : '') + '>' + esc(v) + '</option>';
    }).join('');
  sel.classList.toggle('active', !!current);
}
