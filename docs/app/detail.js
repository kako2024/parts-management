/**
 * app/detail.js — 詳細の取得・描画、在庫ステータスの更新・削除、保存を待たずに出す仮の表示
 * 読み込む順と各ファイルの役割は app/core.js の冒頭にある。
 */
'use strict';

/* ================================================================
 * 詳細
 * ==============================================================*/

/** 詳細画面の表示で終わる計測（開始は各操作の側で行う） */
var DETAIL_SCENES = ['B 一覧→詳細', 'B QR→詳細', 'B ID入力→詳細', 'C 登録', 'C 編集'];

/**
 * 詳細を開く。手元（キャッシュ・一覧）に備品があれば API を待たずに表示し、裏で最新を取って差し替える。
 */
function openDetail(itemId) {
  var hit = findLocalItem(itemId);
  if (hit) {
    DETAIL_SCENES.forEach(function (k) { PERF.mark(k, 'cache'); });
    state.fresh.detail = { itemId: itemId, status: 'checking', confirmedAt: hit.confirmedAt || null };
    showDetail(hit.item, hit.logs);
    goto('detail');
    whenIdle(function () {
      DETAIL_SCENES.forEach(function (k) { PERF.end(k); });
      PERF.watchImages('D 詳細写真', $('#view-detail'));
    });
    refreshDetail(itemId);
    return Promise.resolve();
  }

  loading(true, '読み込み中…');
  return api('getItem', { item_id: itemId, withLogs: true })
    .then(function (data) {
      DETAIL_SCENES.forEach(function (k) { PERF.mark(k, 'getItem'); });
      state.fresh.detail = { itemId: data.item.item_id, status: 'fresh', confirmedAt: Date.now() };
      showDetail(data.item, data.logs || []);
      rememberDetail(data.item, data.logs || []);
      return goto('detail');
    })
    .then(function () {
      whenIdle(function () {
        DETAIL_SCENES.forEach(function (k) { PERF.end(k); });
        PERF.watchImages('D 詳細写真', $('#view-detail'));
      });
    })
    .catch(function (err) {
      if (err.code === 'ITEM_NOT_FOUND') {
        toast('備品 ' + itemId + ' は未登録です', 'error');
        if (confirmRegister(itemId)) return;
      } else {
        toast(err.message || '取得に失敗しました', 'error');
      }
    })
    .then(function () { loading(false); }, function () { loading(false); });
}

/** 手元にある備品（と履歴）。キャッシュ → 表示中の一覧の順に探す */
function findLocalItem(itemId) {
  var hit = ItemCache.findItem(CFG.GAS_API_URL, cacheOwner(), itemId);
  if (hit) return hit;
  var it = state.items.filter(function (x) { return x.item_id === itemId; })[0];
  return it ? { item: it, logs: null, confirmedAt: state.fresh.list.confirmedAt } : null;
}

/** 表示中の詳細を裏で最新に差し替える。別の画面・別の備品に移っていたら画面は触らない */
/**
 * 詳細を描き、表示中の備品として覚える。詳細の描画はすべてここを通す。
 * @param {{pending: boolean}=} opts pending なら保存中の表示にし、操作ボタンを押せなくする
 * @return {number} この描画の番号（stillShowing に渡す）
 */
function showDetail(item, logs, opts) {
  state.detailRev++;
  state.currentItem = item;
  state.currentLogs = logs;
  renderDetail(item, logs, opts);
  renderSync();
  return state.detailRev;
}

/** rev の描画のあと、別の描画や別の画面に移っていないか */
function stillShowing(rev) {
  return state.view === 'detail' && state.detailRev === rev;
}

/** 表示中の詳細を裏で最新に差し替える。別の画面・別の描画に移っていたら画面は触らない */
function refreshDetail(itemId) {
  var rev = state.detailRev;
  var itemRev = state.itemRev[itemId];
  setDetailFresh(itemId, { status: 'checking' });
  api('getItem', { item_id: itemId, withLogs: true })
    .then(function (data) {
      // 取得の間にこの備品を手元で更新していたら、この応答は更新前の内容なので画面にもキャッシュにも使わない
      if (state.itemRev[itemId] !== itemRev) {
        if (state.fresh.detail.itemId === itemId && state.fresh.detail.status === 'checking') setDetailFresh(itemId, { status: 'none' });
        return;
      }
      rememberDetail(data.item, data.logs || []);
      setDetailFresh(itemId, { status: 'fresh', confirmedAt: Date.now() });
      if (!stillShowing(rev)) return;
      // 手元の表示と同じなら描き直さない（写真の読み込みをやり直させないため）
      if (sameJson([data.item, data.logs || []], [state.currentItem, state.currentLogs])) return;
      showDetail(data.item, data.logs || []);
    })
    .catch(function (err) {
      if (err.code === 'ITEM_NOT_FOUND') {
        ItemCache.remove(CFG.GAS_API_URL, cacheOwner(), itemId);
        state.items = state.items.filter(function (x) { return x.item_id !== itemId; });
        renderList();
        if (stillShowing(rev)) {
          toast('備品 ' + itemId + ' は削除されたか、未登録です', 'error');
          goto('list', { replace: true });
        }
      } else {
        setDetailFresh(itemId, { status: failureStatus(err) });
        if (stillShowing(rev)) toast(err.message || '最新のデータを取得できませんでした', 'error');
      }
    });
}

function confirmRegister(itemId) {
  if (window.confirm('この ID は未登録です。\n新しい備品として登録しますか？\n\nID: ' + itemId)) {
    openForm(null, itemId);
    return true;
  }
  return false;
}

function renderDetail(item, logs, opts) {
  var pending = !!(opts && opts.pending);
  var dis = pending ? ' disabled' : '';
  var photos = itemPhotos(item);
  var previousPhotos = $('#detail-photos');
  var photoScroll = previousPhotos && previousPhotos.getAttribute('data-photo-item') === item.item_id ? previousPhotos.scrollLeft : 0;
  var photo = photos.length ? photos.map(function (p, i) {
    return '<figure data-detail-photo="' + esc(p.id) + '" class="bg-white">' + detailImage(p, item.name, i) +
      '<figcaption class="flex items-center justify-between px-4 py-2 text-sm">写真' + (i + 1) +
      (p.url === item.photo_url ? ' ・ 代表' : '') +
      '<button data-photo-expand="' + esc(p.id) + '" class="h-11 px-3 rounded-lg bg-slate-100" aria-label="写真' + (i + 1) + 'を拡大">拡大</button></figcaption></figure>';
  }).join('') : '<div class="w-full aspect-[4/3] bg-slate-200 flex items-center justify-center text-6xl">📦</div>';

  var statusButtons = state.meta.stockStatuses.map(function (s) {
    var sel = (s === item.stock_status) ? statusSelectedClass(s) : '';
    return '<button class="status-btn ' + sel + '" data-set-status="' + esc(s) + '"' + dis + '>' + esc(s) + '</button>';
  }).join('');

  var rows = [
    ['備品ID', item.item_id],
    ['仕様', item.spec || '—'],
    ['カテゴリ', item.category || '—'],
    ['保管場所', item.location || '—'],
    ['個数', (item.quantity === null || item.quantity === '') ? '—' : item.quantity],
    ['備考', item.note || '—'],
    ['最終更新', item.updated_at || '—'],
    ['更新者', item.updated_by || '—']
  ].map(function (r) {
    return '<div class="flex gap-3 py-2.5 border-b border-slate-100 last:border-0">' +
           '  <dt class="w-24 shrink-0 text-xs font-semibold text-slate-500 pt-0.5">' + esc(r[0]) + '</dt>' +
           '  <dd class="flex-1 text-sm break-words whitespace-pre-wrap">' + esc(r[1]) + '</dd>' +
           '</div>';
  }).join('');

  var logHtml = !logs
    ? '<li class="py-4 text-sm text-slate-400 text-center">履歴を読み込み中…</li>'
    : logs.length
    ? logs.slice(0, 10).map(function (l) {
        return '<li class="py-2.5 border-b border-slate-100 last:border-0">' +
               '  <div class="flex items-baseline justify-between gap-2">' +
               '    <span class="text-xs font-semibold text-slate-700">' + esc(actionLabel(l.action_type)) + '</span>' +
               '    <span class="text-[11px] text-slate-400 shrink-0">' + esc(l.timestamp) + '</span>' +
               '  </div>' +
               '  <p class="text-xs text-slate-500 mt-0.5 break-all">' + esc(summarizeLog(l)) + '</p>' +
               '  <p class="text-[11px] text-slate-400 break-all">' + esc(l.user_email) + '</p>' +
               '</li>';
      }).join('')
    : '<li class="py-4 text-sm text-slate-400 text-center">履歴はまだありません</li>';

  $('#view-detail').innerHTML = '' +
    '<div id="sync-detail" class="flex items-center gap-2 px-4 py-2 text-xs bg-slate-100 border-b border-slate-200 empty:hidden"></div>' +
    '<div class="detail-layout">' +
    '<div class="detail-photos-col">' +
    '<div id="detail-photos" data-photo-item="' + esc(item.item_id) + '" class="bg-white photo-strip' + (photos.length > 1 ? ' photo-strip--multiple' : '') + '" role="region" aria-label="備品の写真"' + (photos.length > 1 ? ' tabindex="0"' : '') + '>' + photo + '</div>' +
    (photos.length > 1 ? '<p class="photo-scroll-hint px-4 py-2 text-xs text-slate-500">左右にスワイプして写真を見られます</p>' : '') +
    '</div>' +
    '<div class="p-4 space-y-4 min-w-0">' +
    '  <div>' +
    '    <span class="badge ' + statusClass(item.stock_status) + '">' + esc(item.stock_status || '未設定') + '</span>' +
         (pending ? '<span id="saving-indicator" class="ml-2 text-xs text-slate-500">保存中…</span>' : '') +
    '    <h2 class="mt-2 text-xl font-bold leading-snug">' + esc(item.name) + '</h2>' +
    '  </div>' +
         photoRetryPanel(item, dis) +

    '  <div class="bg-white rounded-2xl p-4 shadow-sm">' +
    '    <p class="text-xs font-semibold text-slate-500 mb-2.5">在庫ステータスを変更</p>' +
    '    <div class="grid grid-cols-3 gap-2">' + statusButtons + '</div>' +
    '  </div>' +

    '  <div class="bg-white rounded-2xl p-4 shadow-sm">' +
    '    <dl>' + rows + '</dl>' +
    '  </div>' +

    '  <div class="bg-white rounded-2xl p-4 shadow-sm">' +
    '    <p class="text-xs font-semibold text-slate-500 mb-1">更新履歴</p>' +
    '    <ul>' + logHtml + '</ul>' +
    '  </div>' +

    '  <div class="grid grid-cols-2 gap-2">' +
    '    <button id="btn-edit" class="h-12 rounded-xl bg-slate-900 text-white font-semibold active:bg-slate-700 disabled:opacity-50"' + dis + '>編集</button>' +
    '    <button id="btn-delete" class="h-12 rounded-xl bg-white border border-rose-300 text-rose-600 font-semibold active:bg-rose-50 disabled:opacity-50"' + dis + '>削除</button>' +
    '  </div>' +
    '</div>' +
    '</div>';
  $('#detail-photos').scrollLeft = photoScroll;
}

/**
 * 部分失敗の下書きがあれば、保存できなかった写真番号と再送ボタンを出す（PHOTO.md 項目5）。
 */
function photoRetryPanel(item, dis) {
  var pr = state.photoRetry;
  if (!pr || pr.itemId !== item.item_id) return '';
  var failed = pr.draft.photos.concat(pr.draft.waiting).filter(function (p) { return p.photo; });
  return '<div id="photo-retry" class="bg-amber-50 border border-amber-200 rounded-2xl p-4 space-y-3">' +
    '<p class="text-sm text-amber-900">' + failed.length + '枚の写真を保存できませんでした。選んだ写真はこの画面に残っています。</p>' +
    failed.map(function (p, i) {
      return '<p class="text-sm">写真' + (pr.failedNumbers ? pr.failedNumbers[i] : pr.draft.photos.indexOf(p) + 1) + 'を保存できませんでした</p>';
    }).join('') +
    (pr.needsReview ? '<p class="text-sm">他の人が写真を変更していました。代表と外す操作を編集フォームで確認してください。</p>' : '') +
    '<button id="btn-photo-retry" class="w-full h-11 rounded-xl bg-amber-600 text-white font-semibold disabled:opacity-50"' + dis + '>写真だけ送り直す</button></div>';
}

// PHOTO.md 項目5: 成功済み写真はURL参照で保持し、失敗分だけ画像データを送り直す。
// 応答不明なら操作ID・payload・版を固定する。他者の変更は必ず競合として再判断する。
function retryPhoto() {
  var pr = state.photoRetry;
  var item = state.currentItem;
  var logs = state.currentLogs;
  if (!pr || !item || pr.itemId !== item.item_id || state.saving) return;
  if (pr.needsReview || pr.draft.waiting.length) {
    return openForm(item, null, { values: item, photo: mergePhotoDraft(item, pr.draft),
      conflict: [{ key: 'photos', theirs: '最新の写真', mine: '失敗下書きを保持。代表と外す操作は再確認してください' }] });
  }
  var op = pr.op || newOp();
  var payload = pr.payload || {
    item_id: item.item_id, photos: photoPayload(pr.draft.photos),
    primary_photo_id: pr.draft.primary, base_version: pr.baseVersion
  };
  pr.op = op;
  pr.payload = payload;
  state.saving = true;
  noteLocalWrite(item.item_id);
  var rev = showDetail(item, logs, { pending: true });
  sendOp('updateItem', payload, op)
    .then(function (data) {
      state.saving = false;
      if (state.photoRetry === pr) state.photoRetry = null;
      var showing = stillShowing(rev);
      applySaved(data.item, data.log, logs, rev);
      if (data.photoError) return onPhotoNotSaved(data.item, pr.draft, showing, data.photoErrors);
      toast('写真を保存しました', 'success');
    })
    .catch(function (err) {
      state.saving = false;
      if (err.code === 'CONFLICT') {
        pr.op = null; pr.payload = null;
        var latest = err.data && err.data.item;
        if (latest && stillShowing(rev)) {
          rememberDetail(latest, null); upsertListItem(latest); showDetail(latest, null);
          openForm(latest, null, { values: latest, photo: mergePhotoDraft(latest, pr.draft),
            conflict: [{ key: 'photos', theirs: '最新の写真', mine: '保存できなかった写真の下書き' }] });
          state.photoRetry = null;
        } else if (stillShowing(rev)) {
          showDetail(item, logs);
        }
        toast('写真を送り直す前に他の人が更新していました。下書きを残したので、最新の写真と代表を確かめて保存してください', 'error');
        return;
      }
      if (!err.unknown) { pr.op = null; pr.payload = null; }
      if (stillShowing(rev)) showDetail(item, logs);
      toast((err.unknown ? '写真を保存できたか確認できませんでした' : '写真を保存できませんでした') +
        '（' + (err.message || '通信エラー') + '）。もう一度「写真だけ送り直す」を押してください', 'error');
    });
}

function actionLabel(type) {
  var map = {
    CREATE: '新規登録',
    UPDATE_STATUS: '在庫ステータス更新',
    UPDATE: '情報更新',
    DELETE: '削除'
  };
  return map[type] || type;
}

function summarizeLog(l) {
  var b = parseMaybeJson(l.before_state);
  var a = parseMaybeJson(l.after_state);
  if (l.action_type === 'UPDATE_STATUS' && b && a) {
    return (b.stock_status || '—') + ' → ' + (a.stock_status || '—');
  }
  if (l.action_type === 'CREATE' && a) {
    return (a.name || '') + (a.stock_status ? '（' + a.stock_status + '）' : '');
  }
  if (l.action_type === 'UPDATE' && a && typeof a === 'object') {
    return Object.keys(a).filter(function (k) { return k.charAt(0) !== '_' && (k !== 'photo_url' || !a.photos); }).map(function (k) { return fieldLabel(k); }).join(' / ') + ' を変更';
  }
  return l.after_state || '';
}

function parseMaybeJson(v) {
  if (!v) return null;
  try { return JSON.parse(v); } catch (e) { return v; }
}

function fieldLabel(key) {
  var map = {
    name: '備品名', category: 'カテゴリ', location: '保管場所',
    stock_status: '在庫', quantity: '個数', note: '備考', spec: '仕様',
    photo_url: '代表写真', photos: '写真', is_deleted: '削除フラグ'
  };
  return map[key] || key;
}

/* ---------- 更新の即時反映（楽観的更新。PERF.md 項目 6） ----------
 * 押した直後に画面を変え、API の応答は裏で待つ。成功したら応答の備品と履歴で描き直して
 * 一覧・キャッシュにも反映する。失敗したら元の表示に戻して知らせる。
 */

/** 一覧（表示中の state.items）の同じ備品を置き換える。新しい備品は絞り込みがないときだけ先頭に足す */
function upsertListItem(item) {
  var found = false;
  state.items = state.items.map(function (x) {
    if (x.item_id !== item.item_id) return x;
    found = true;
    return item;
  });
  if (!found && filtersEmpty()) state.items = [item].concat(state.items);
  renderList();
}

/**
 * 保存に成功した備品を反映する。履歴は、応答の 1 件を手元の履歴の先頭に足す（取り直さない）。
 * @param {number} rev 楽観的に描いたときの番号。まだその表示のままなら描き直す
 */
/** 手元で備品を更新した（楽観的表示・保存の反映）。これより前に始めた裏の取得の応答は捨てられる */
function noteLocalWrite(itemId) {
  state.writeSeq++;
  state.itemRev[itemId] = (state.itemRev[itemId] || 0) + 1;
}

function applySaved(item, log, baseLogs, rev) {
  noteLocalWrite(item.item_id);
  // 保存の応答はサーバーの内容なので、この備品は今確かめたことになる
  state.fresh.detail = { itemId: item.item_id, status: 'fresh', confirmedAt: Date.now() };
  var logs = baseLogs ? (log ? [log].concat(baseLogs) : baseLogs) : null;
  rememberDetail(item, logs);
  upsertListItem(item);
  if (stillShowing(rev)) {
    showDetail(item, logs);
    if (!logs) refreshDetail(item.item_id); // 履歴をまだ持っていなければ取りに行く
  }
}

/**
 * 保存が競合で止められた（PLAN-2 項目 2。他の人が先に更新していた）。サーバーが返した最新の備品を
 * 一覧・キャッシュ・表示中の詳細に反映して知らせる。何も保存されていない。
 */
function showLatestAfterConflict(err, rev, what) {
  var latest = err.data && err.data.item;
  if (latest) {
    applySaved(latest, null, null, rev); // 表示中なら最新を出し、履歴を取り直す
  } else if (stillShowing(rev)) {
    refreshDetail(state.currentItem.item_id);
  }
  toast('他の人が先にこの備品を更新していたため、' + what + 'を保存しませんでした。最新の内容を表示したので、確かめてからもう一度操作してください', 'error');
}

function updateStatus(newStatus) {
  var prev = state.currentItem;
  var prevLogs = state.currentLogs;
  if (!prev || prev.stock_status === newStatus || state.saving) return;

  PERF.begin('C ステータス更新');
  PERF.begin('C ステータス確定');
  state.saving = true;
  noteLocalWrite(prev.item_id);
  var rev = showDetail(Object.assign({}, prev, { stock_status: newStatus }), prevLogs, { pending: true });
  whenIdle(function () { PERF.end('C ステータス更新'); });

  sendOp('updateStatus', { item_id: prev.item_id, stock_status: newStatus, base_version: prev.version }, newOp())
    .then(function (data) {
      state.saving = false;
      applySaved(data.item, data.log, prevLogs, rev);
      PERF.end('C ステータス確定');
      toast('「' + newStatus + '」に更新しました', 'success');
    })
    .catch(function (err) {
      state.saving = false;
      if (err.code === 'CONFLICT') return showLatestAfterConflict(err, rev, '在庫ステータス');
      if (stillShowing(rev)) showDetail(prev, prevLogs);
      if (err.unknown) {
        // 保存されたかもしれないので、元に戻したままにせずサーバーの状態を読み直す
        noteLocalWrite(prev.item_id);
        refreshDetail(prev.item_id);
        toast('更新できたか確認できませんでした（' + (err.message || '通信エラー') + '）。サーバーの状態を読み直します', 'error');
        return;
      }
      toast('更新できなかったため、元の表示に戻しました（' + (err.message || '通信エラー') + '）', 'error');
    });
}

function deleteItem() {
  var item = state.currentItem;
  if (!item) return;
  if (!window.confirm('「' + item.name + '」を削除します。\n（データは残り、一覧から非表示になります）')) return;

  loading(true, '削除中…');
  var rev = state.detailRev;
  sendOp('deleteItem', { item_id: item.item_id, base_version: item.version }, newOp())
    .then(function () {
      noteLocalWrite(item.item_id);
      ItemCache.remove(CFG.GAS_API_URL, cacheOwner(), item.item_id);
      state.items = state.items.filter(function (x) { return x.item_id !== item.item_id; });
      renderList();
      toast('削除しました', 'success');
      return goto('list', { replace: true });
    })
    .catch(function (err) {
      if (err.code === 'CONFLICT') return showLatestAfterConflict(err, rev, '削除');
      if (err.unknown) {
        toast('削除できたか確認できませんでした（' + (err.message || '通信エラー') + '）。もう一度「削除」を押すと確かめられます', 'error');
        return;
      }
      toast(err.message || '削除に失敗しました', 'error');
    })
    .then(function () { loading(false); }, function () { loading(false); });
}
