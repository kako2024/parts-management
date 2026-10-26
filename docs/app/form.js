/**
 * app/form.js — 登録・編集フォームと送信 submitForm()、競合・操作 ID 不一致の扱い
 * 読み込む順と各ファイルの役割は app/core.js の冒頭にある。
 */
'use strict';

/* ================================================================
 * 登録 / 編集フォーム
 * ==============================================================*/

/**
 * @param {Object|null} item     編集対象。null なら新規
 * @param {string=} presetItemId 新規時に ID を固定したい場合（QR 先行発行など）
 */
/**
 * @param {Object=} draft 保存に失敗したときに入力を戻すための値 { values: {...}, photo: photoDraft|null, op? }
 *   op があれば、次の保存はその操作の送り直しになる（結果を確認できなかった保存。二重に保存しない）
 * @param {{replace: boolean}=} nav replace なら画面の履歴を積まない
 */
function openForm(item, presetItemId, draft, nav) {
  // PHOTO.md 項目5: 部分失敗から編集へ進む場合も、失敗下書きと代表の希望を保持する。
  var retry = state.photoRetry;
  if (!draft && item && retry && retry.itemId === item.item_id) {
    var photo = item.version === retry.baseVersion ? retry.draft : mergePhotoDraft(item, retry.draft);
    draft = { values: item, photo: { photos: photo.photos.slice(), primary: photo.primary, waiting: photo.waiting.slice() } };
    if (retry.needsReview || item.version !== retry.baseVersion) draft.conflict = [{ key: 'photos', theirs: '最新の写真', mine: '保存できなかった写真の下書き。代表は再確認してください' }];
  }
  state.photoDraft = (draft && draft.photo) || initialPhotoDraft(item);
  state.formOp = (draft && draft.op) || null;
  state.formBase = item || null;
  var isEdit = !!item;
  var base = item || {
    item_id: presetItemId || '',
    name: '', category: '', location: '',
    stock_status: state.meta.stockStatuses[0],
    quantity: '', note: '', spec: '', photo_url: ''
  };
  var v = draft ? Object.assign({}, base, draft.values) : base;

  var statusOptions = state.meta.stockStatuses.map(function (s) {
    return '<option value="' + esc(s) + '"' + (s === v.stock_status ? ' selected' : '') + '>' + esc(s) + '</option>';
  }).join('');

  var datalist = function (id, values) {
    return '<datalist id="' + id + '">' +
      (values || []).map(function (x) { return '<option value="' + esc(x) + '"></option>'; }).join('') +
      '</datalist>';
  };

  var idField = isEdit
    ? '<div><span class="field-label">備品ID</span>' +
      '<p class="text-sm font-mono bg-slate-100 rounded-lg px-3 py-2.5">' + esc(v.item_id) + '</p></div>'
    : '<div><label class="field-label" for="f-item-id">備品ID（空欄なら自動採番）</label>' +
      '<input id="f-item-id" class="field-input" type="text" autocapitalize="characters" ' +
      'placeholder="ITEM-0001" value="' + esc(v.item_id) + '"></div>';

  $('#view-form').innerHTML = '' +
    '<form id="item-form" class="space-y-4" novalidate>' +
         conflictNotice(draft && draft.conflict) +
    '  <div class="bg-white rounded-2xl p-4 shadow-sm space-y-3">' +
    '    <span class="field-label">写真</span>' +
    '    <div id="photo-slot" class="photo-strip space-y-3" role="region" aria-label="追加・編集中の写真"></div>' +
    '    <p id="photo-scroll-hint" class="photo-scroll-hint text-xs text-slate-500 hidden">左右にスワイプして写真を見られます</p>' +
    '    <p id="photo-limit" aria-live="polite" class="text-sm text-slate-600"></p>' +
    '    <p id="photo-error" role="alert" class="text-sm text-rose-700"></p>' +
    '    <input id="f-photo" type="file" accept="image/*" capture="environment" aria-label="撮影する" class="hidden">' +
    '    <input id="f-photo-album" type="file" accept="image/*" multiple aria-label="アルバムから選ぶ" class="hidden">' +
    '    <div class="grid grid-cols-2 gap-2">' +
    '      <button type="button" id="btn-photo-pick" class="h-11 rounded-xl bg-slate-100 font-semibold text-sm active:bg-slate-200" aria-label="撮影する" aria-describedby="photo-limit">撮影する</button>' +
    '      <button type="button" id="btn-photo-album" aria-label="アルバムから選ぶ" aria-describedby="photo-limit" class="h-11 rounded-xl bg-slate-100 font-semibold text-sm active:bg-slate-200">アルバムから選ぶ</button>' +
    '    </div>' +
    '    <div>' +
    '      <button type="button" id="btn-photo-clear" class="h-11 rounded-xl bg-white border border-slate-300 text-slate-600 font-semibold text-sm active:bg-slate-50">選択を取消</button>' +
    '    </div>' +
    '  </div>' +

    '  <div class="bg-white rounded-2xl p-4 shadow-sm space-y-4">' +
         idField +
    '    <div><label class="field-label" for="f-name">備品名 <span class="text-rose-500">*</span></label>' +
    '      <input id="f-name" class="field-input" type="text" required value="' + esc(v.name) + '" placeholder="コピー用紙 A4"></div>' +
    '    <div><label class="field-label" for="f-spec">仕様（一覧に表示）</label>' +
    '      <input id="f-spec" class="field-input" type="text" value="' + esc(v.spec || '') + '" placeholder="六角 1.5 / プラス 1.0 など"></div>' +
    '    <div><label class="field-label" for="f-category">カテゴリ</label>' +
    '      <input id="f-category" class="field-input" type="text" list="dl-category" value="' + esc(v.category) + '" placeholder="事務用品">' +
           datalist('dl-category', state.meta.categories) + '</div>' +
    '    <div><label class="field-label" for="f-location">保管場所</label>' +
    '      <input id="f-location" class="field-input" type="text" list="dl-location" value="' + esc(v.location) + '" placeholder="本館-3F-A棚-2段">' +
           datalist('dl-location', state.meta.locations) + '</div>' +
    '    <div class="grid grid-cols-2 gap-3">' +
    '      <div><label class="field-label" for="f-status">在庫ステータス</label>' +
    '        <select id="f-status" class="field-input">' + statusOptions + '</select></div>' +
    '      <div><label class="field-label" for="f-quantity">個数</label>' +
    '        <input id="f-quantity" class="field-input" type="number" inputmode="numeric" min="0" value="' + esc(v.quantity) + '"></div>' +
    '    </div>' +
    '    <div><label class="field-label" for="f-note">備考</label>' +
    '      <textarea id="f-note" class="field-input" rows="3" placeholder="発注先・型番など">' + esc(v.note) + '</textarea></div>' +
    '  </div>' +

    '  <button type="submit" class="w-full h-14 rounded-2xl bg-slate-900 text-white font-bold text-base active:bg-slate-700">' +
         (isEdit ? '保存する' : '登録する') +
    '  </button>' +
    '</form>';

  $('#item-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    submitForm(isEdit, v.item_id);
  });
  $('#btn-photo-pick').addEventListener('click', function () { $('#f-photo').click(); });
  $('#btn-photo-album').addEventListener('click', function () { $('#f-photo-album').click(); });
  $('#f-photo-album').addEventListener('change', onPhotoSelected);
  $('#btn-photo-clear').addEventListener('click', clearPhotoDraft);
  $('#f-photo').addEventListener('change', onPhotoSelected);
  $('#photo-slot').addEventListener('click', onFormPhotoAction);
  renderFormPhotos();

  return goto('form', { title: isEdit ? '備品を編集' : '備品を登録', replace: !!(nav && nav.replace) });
}

/** 編集で送る項目（変えた項目だけを送る。PLAN-2 項目 2） */
var EDIT_FIELDS = ['name', 'category', 'location', 'stock_status', 'quantity', 'note', 'spec'];

/** フォームと備品の値を比べられる形にそろえる（個数は空欄と null を同じに扱う） */
function fieldText(key, v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

/** 競合で戻ったフォームの上に、他の人が変えた項目を出す */
function conflictNotice(conflict) {
  if (!conflict || !conflict.length) return '';
  return '' +
    '<div id="conflict-notice" class="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-sm text-amber-900 space-y-1">' +
    '  <p class="font-semibold">他の人が先にこの備品を更新していました（まだ保存していません）</p>' +
    conflict.map(function (c) {
      return '<p>' + esc(fieldLabel(c.key)) + '：「' + esc(c.theirs) + '」に変わっていました' +
        (c.mine !== undefined ? '（あなたの入力「' + esc(c.mine) + '」を残しています）' : '（最新の値にしました）') + '</p>';
    }).join('') +
    '  <p>内容を確かめて、もう一度「保存する」を押してください。</p>' +
    '</div>';
}

/**
 * 編集の保存が競合で止められた。入力を残してフォームに戻る。自分が変えていない項目は最新の値にし
 * （他の人の変更を古い値で戻さない）、自分が変えた項目は入力のまま残す。次の保存は最新の版を基にする。
 */
function onEditConflict(err, base, draft, rev) {
  var latest = err.data && err.data.item;
  if (!latest) {
    // 備品が見つからなかった（行が消えたなど）。最新を出せないので、入力と写真を残したフォームに戻る
    if (stillShowing(rev)) {
      showDetail(base, null);
      openForm(base, null, { values: draft.values, photo: draft.photo });
      refreshDetail(base.item_id); // 裏で取り直して一覧・キャッシュを最新にする（フォームはそのまま。消えていれば一覧から除く）
    }
    toast('この備品の最新の内容を確かめられなかったため、保存しませんでした。入力を残してフォームに戻りました', 'error');
    return;
  }
  var values = {};
  var conflict = [];
  EDIT_FIELDS.forEach(function (k) {
    var mine = fieldText(k, draft.values[k]);
    var changedByMe = mine !== fieldText(k, base[k]);
    var changedByOthers = fieldText(k, latest[k]) !== fieldText(k, base[k]);
    values[k] = changedByMe ? draft.values[k] : fieldText(k, latest[k]);
    if (changedByOthers) conflict.push({ key: k, theirs: fieldText(k, latest[k]), mine: changedByMe ? mine : undefined });
  });
  rememberDetail(latest, null);
  upsertListItem(latest);
  if (stillShowing(rev)) {
    showDetail(latest, null);
    var photo = draft.photo;
    if (!sameJson([itemPhotos(base), base.photo_url], [itemPhotos(latest), latest.photo_url])) {
      photo = mergePhotoDraft(latest, draft.photo);
      conflict.push({ key: 'photos', theirs: '最新の写真', mine: '追加した写真の下書き。外す操作と代表は再確認してください' });
    }
    openForm(latest, null, { values: values, photo: photo, conflict: conflict });
  }
  toast('他の人が先にこの備品を更新していたため、保存しませんでした。入力を残してフォームに戻りました', 'error');
}

function submitForm(isEdit, itemId) {
  var name = $('#f-name').value.trim();
  if (!name) {
    toast('備品名を入力してください', 'error');
    $('#f-name').focus();
    return;
  }

  var payload = {
    name: name,
    category: $('#f-category').value.trim(),
    location: $('#f-location').value.trim(),
    stock_status: $('#f-status').value,
    quantity: $('#f-quantity').value === '' ? null : Number($('#f-quantity').value),
    note: $('#f-note').value.trim(),
    spec: $('#f-spec').value.trim()
  };
  if (state.photoDraft.waiting.length) {
    photoInputError('待機中の写真があります。写真を外して追加するか、待機中の写真を外してください');
    return;
  }
  payload.photos = photoPayload(state.photoDraft.photos);
  payload.primary_photo_id = state.photoDraft.primary;

  var action;
  var base = isEdit ? state.formBase : null;
  var send = payload;
  if (isEdit) {
    action = 'updateItem';
    // 変えた項目と写真だけを、開いたときの版を添えて送る（他の人が変えた項目を古い値で戻さない）
    send = { item_id: itemId, base_version: base && base.version };
    EDIT_FIELDS.forEach(function (k) {
      if (!base || fieldText(k, payload[k]) !== fieldText(k, base[k])) send[k] = payload[k];
    });
    var basePhotoState = [photoPayload(itemPhotos(base)), initialPhotoDraft(base).primary]; // 開いたときの写真と代表
    if (!sameJson([payload.photos, payload.primary_photo_id], basePhotoState)) {
      send.photos = payload.photos; send.primary_photo_id = payload.primary_photo_id;
    }
    if (Object.keys(send).length === 2) {
      toast('変更はありません', 'info');
      return;
    }
  } else {
    action = 'createItem';
    var manualId = $('#f-item-id') ? $('#f-item-id').value.trim() : '';
    if (manualId) payload.item_id = manualId;
  }

  // 保存に失敗したらフォームに戻すための入力（写真は選び直さなくて済むよう下書きごと持つ）
  var draft = {
    values: {
      name: payload.name, category: payload.category, location: payload.location,
      stock_status: payload.stock_status, quantity: $('#f-quantity').value, note: payload.note, spec: payload.spec,
      item_id: isEdit ? itemId : (payload.item_id || '')
    },
    photo: state.photoDraft
  };
  state.photoDraft = null;
  var op = state.formOp || newOp();
  state.formOp = null;

  var perfKey = isEdit ? 'C 編集' : 'C 登録';
  PERF.begin(perfKey);
  PERF.begin(perfKey + '確定');

  // 保存を待たずに、入力どおりの詳細を出す（楽観的更新。PERF.md 項目 6）
  var prev = isEdit ? state.currentItem : null;
  var prevLogs = isEdit ? state.currentLogs : [];
  var primaryPhoto = findPhoto(draft.photo.photos, draft.photo.primary) || {};
  if (isEdit) noteLocalWrite(itemId);
  var optimistic = Object.assign({}, prev || { item_id: payload.item_id || '（採番中）', is_deleted: false }, {
    name: payload.name, category: payload.category, location: payload.location,
    stock_status: payload.stock_status, quantity: payload.quantity, note: payload.note, spec: payload.spec,
    photos: draft.photo.photos.map(function (p) { return { id: p.id, url: p.previewUrl || p.url }; }),
    photo_url: primaryPhoto.previewUrl || primaryPhoto.url || '',
    updated_at: '（保存中）', updated_by: state.user ? state.user.email : ''
  });
  state.saving = true;
  // 戻るでフォームに戻らないよう、フォームの 1 つ前が詳細ならその履歴も外して詳細へ移る
  if (state.stack[state.stack.length - 1] === 'detail') state.stack.pop();
  var rev = showDetail(optimistic, prevLogs, { pending: true });
  goto('detail', { replace: true });
  whenIdle(function () { PERF.end(perfKey); });

  sendOp(action, send, op)
    .then(function (data) {
      state.saving = false;
      var showing = stillShowing(rev); // applySaved が描き直す前に確かめる
      if (state.photoRetry && state.photoRetry.itemId === data.item.item_id) state.photoRetry = null;
      applySaved(data.item, data.log, prevLogs, rev);
      mergeMeta(payload.category, payload.location); // 新しいカテゴリ・場所を候補に反映
      PERF.end(perfKey + '確定');
      if (data.photoError) {
        onPhotoNotSaved(data.item, draft.photo, showing, data.photoErrors);
        return;
      }
      toast(isEdit ? '保存しました' : '登録しました（' + data.item.item_id + '）', 'success');
    })
    .catch(function (err) {
      state.saving = false;
      var msg = err.message || '通信エラー';
      if (err.code === 'OP_MISMATCH') return onOpMismatch(err, isEdit, draft, rev, prev, prevLogs);
      if (err.code === 'CONFLICT' && isEdit) return onEditConflict(err, base, draft, rev);
      // 結果を確認できなかったときは、次の保存を同じ操作の送り直しにする（二重に登録しない）
      if (err.unknown) draft.op = op;
      if (!stillShowing(rev)) {
        toast('「' + payload.name + '」を' + (err.unknown ? '保存できたか確認できませんでした' : '保存できませんでした') +
          '（' + msg + '）', 'error');
        return;
      }
      if (isEdit) {
        showDetail(prev, prevLogs);
        openForm(prev, null, draft);
      } else {
        openForm(null, null, draft, { replace: true });
      }
      toast(err.unknown
        ? '保存できたか確認できませんでした（' + msg + '）。もう一度「' + (isEdit ? '保存する' : '登録する') + '」を押すと、二重に保存せずに確かめます'
        : '保存できませんでした（' + msg + '）。入力内容を残してフォームに戻りました', 'error');
    });
}

/**
 * 備品は登録できたが写真を保存できなかった（PLAN-2 項目 1）。選んだ写真を手元に残し、詳細の
 * 「写真だけ送り直す」で写真だけを送れるようにする（備品は増えず、ほかの項目も送らない）。
 */
function onPhotoNotSaved(item, draft, showing, errors) {
  if (!draft) return;
  var saved = itemPhotos(item);
  var failedIds = (errors || []).map(function (e) { return e.id; });
  var failed = draft.photos.filter(function (p) {
    return p.photo && (!failedIds.length || failedIds.indexOf(p.id) !== -1) &&
      !saved.some(function (x) { return x.id === p.id; });
  });
  if (!failed.length) {
    if (state.photoRetry && state.photoRetry.itemId === item.item_id) state.photoRetry = null;
    toast('写真はすでに保存されています。最新の写真を確認してください', 'info');
    return;
  }
  // 同ID確認のitemは現在の備品。元操作の成功集合/代表と違えば他者の変更を再確認する。
  // 保存できなかった写真だけを戻し、他者が追加した写真や取り外した成功写真を勝手に変更しない。
  var expected = draft.photos.filter(function (p) {
    return failedIds.length ? failedIds.indexOf(p.id) === -1 : !failed.some(function (x) { return x.id === p.id; });
  });
  var expectedPrimary = (findPhoto(expected, draft.primary) || expected[0] || {}).id || '';
  var changed = !sameJson(saved.map(function (p) { return p.id; }), expected.map(function (p) { return p.id; })) ||
    initialPhotoDraft(item).primary !== expectedPrimary || expected.some(function (p) {
      return p.url && !saved.some(function (x) { return x.id === p.id && x.url === p.url; });
    });
  var photos = draft.photos.map(function (p) {
    return saved.filter(function (x) { return x.id === p.id; })[0] ||
      (failed.some(function (x) { return x.id === p.id; }) ? p : null);
  }).filter(Boolean);
  var retryDraft = changed ? mergePhotoDraft(item, { photos: failed, primary: draft.primary, waiting: [] }) :
    { photos: photos, primary: draft.primary, waiting: [] };
  state.photoRetry = { itemId: item.item_id, baseVersion: item.version, draft: retryDraft,
    needsReview: changed, failedNumbers: failed.map(function (p) { return draft.photos.indexOf(p) + 1; }), op: null, payload: null };
  if (showing && state.currentItem && state.currentItem.item_id === item.item_id) showDetail(state.currentItem, state.currentLogs);
  toast('備品は保存しましたが、一部の写真を保存できませんでした。詳細の「写真だけ送り直す」で送れます', 'error');
}

/**
 * 結果を確認できなかった保存を、内容を変えて送り直した。最初の保存はすでに済んでいた（サーバーは何もしていない）。
 * 登録なら、済んでいた備品を表示する（入力し直した内容で登録し直すと重複するため）。
 * 編集なら、フォームに戻る。次の保存は新しい操作として、いま入力している内容を保存する。
 */
function onOpMismatch(err, isEdit, draft, rev, prev, prevLogs) {
  var saved = err.data && err.data.item;
  if (!isEdit && saved) {
    applySaved(saved, null, null, rev); // 表示中なら詳細をその備品にして、履歴を取りに行く
    toast('前回の登録は完了していました（' + saved.item_id + '）。入力し直した内容は反映していないので、必要なら編集してください', 'error');
    return;
  }
  draft.op = null;
  if (stillShowing(rev)) {
    if (isEdit) {
      showDetail(saved || prev, prevLogs);
      openForm(saved || prev, null, draft);
    } else {
      openForm(null, null, draft, { replace: true });
    }
  }
  toast('前回の保存は完了していました。いま入力している内容を保存するには、もう一度押してください', 'error');
}

function mergeMeta(category, location) {
  if (category && state.meta.categories.indexOf(category) === -1) {
    state.meta.categories.push(category);
    state.meta.categories.sort();
  }
  if (location && state.meta.locations.indexOf(location) === -1) {
    state.meta.locations.push(location);
    state.meta.locations.sort();
  }
  rebuildFilterOptions();
}
