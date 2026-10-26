/**
 * app/photo.js — 写真の下書き（追加・外す・代表）、詳細の写真と拡大表示、縮小
 * 読み込む順と各ファイルの役割は app/core.js の冒頭にある。
 */
'use strict';

/* ---------- 写真 ---------- */

function photoInputError(message) {
  var error = $('#photo-error');
  if (error) error.textContent = message;
  toast(message, 'error');
}

function photoIdFromUrl(url) {
  var m = String(url).match(/\/d\/([^/?#]+)/) || String(url).match(/[?&]id=([^&#]+)/);
  if (m) return 'legacy-' + m[1];
  var hash = 2166136261;
  for (var i = 0; i < url.length; i++) { hash ^= url.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return 'legacy-' + (hash >>> 0).toString(16);
}

/** 写真の配列から id の写真を探す（無ければ undefined） */
function findPhoto(photos, id) {
  return photos.find(function (p) { return p.id === id; });
}

function itemPhotos(item) {
  if (!item) return [];
  if (Array.isArray(item.photos)) return item.photos;
  return item.photo_url ? [{ id: photoIdFromUrl(item.photo_url), url: item.photo_url }] : [];
}

function initialPhotoDraft(item) {
  var photos = itemPhotos(item).map(function (p) { return { id: p.id, url: p.url }; });
  return { photos: photos, primary: (photos.filter(function (p) { return p.url === item.photo_url; })[0] || photos[0] || {}).id || '', waiting: [] };
}

function photoPayload(photos) {
  return photos.map(function (p) { return p.photo ? { id: p.id, photo: p.photo } : { id: p.id, url: p.url }; });
}

function mergePhotoDraft(latest, draft) {
  var merged = initialPhotoDraft(latest);
  var pending = (draft ? draft.photos.concat(draft.waiting || []) : []).filter(function (p) {
    return p.photo && !merged.photos.some(function (x) { return x.id === p.id; });
  });
  pending.forEach(function (p) {
    if (merged.photos.length < (CFG.MAX_PHOTOS || 4)) merged.photos.push(p); else merged.waiting.push(p);
  });
  if (draft && merged.photos.some(function (p) { return p.id === draft.primary; })) merged.primary = draft.primary;
  if (!merged.primary && merged.photos.length) merged.primary = merged.photos[0].id;
  return merged;
}

function renderFormPhotos() {
  var draft = state.photoDraft;
  if (!draft || !$('#photo-slot')) return;
  function card(p, i, waiting) {
    var label = waiting ? '待機中の写真' + (i + 1) : '写真' + (i + 1);
    return '<figure class="border border-slate-200 rounded-xl overflow-hidden" data-form-photo="' + esc(p.id) + '">' +
      '<img src="' + esc(p.previewUrl || p.url) + '" alt="' + label + '"' + PHOTO_REFERRER + ' class="w-full aspect-[4/3] object-cover bg-slate-200">' +
      '<figcaption class="p-3 space-y-2"><p class="text-sm font-semibold">' + label + (draft.primary === p.id ? ' ・ 代表' : '') + '</p>' +
      '<div class="grid grid-cols-2 gap-2">' +
      (waiting ? '<button type="button" data-photo-add="' + esc(p.id) + '" class="h-11 rounded-lg bg-slate-100"' + (draft.photos.length >= (CFG.MAX_PHOTOS || 4) ? ' disabled' : '') + '>追加する</button>' :
      '<button type="button" data-photo-primary="' + esc(p.id) + '" aria-label="' + label + 'を代表にする" aria-pressed="' + (draft.primary === p.id) + '" class="h-11 rounded-lg bg-slate-100">' + (draft.primary === p.id ? '代表' : '代表にする') + '</button>') +
      '<button type="button" data-photo-remove="' + esc(p.id) + '" aria-label="' + label + 'を外す" class="h-11 rounded-lg border border-slate-300">外す</button></div></figcaption></figure>';
  }
  var slot = $('#photo-slot');
  var scrollLeft = slot.scrollLeft;
  var multiple = draft.photos.length + draft.waiting.length > 1;
  slot.classList.toggle('photo-strip--multiple', multiple);
  if (multiple) slot.setAttribute('tabindex', '0'); else slot.removeAttribute('tabindex');
  $('#photo-scroll-hint').classList.toggle('hidden', !multiple);
  slot.innerHTML = (draft.photos.length ? draft.photos.map(function (p, i) { return card(p, i, false); }).join('') :
    '<div class="h-32 rounded-xl bg-slate-100 flex items-center justify-center text-slate-500">写真なし</div>') +
    draft.waiting.map(function (p, i) { return card(p, i, true); }).join('');
  slot.scrollLeft = scrollLeft;
  var full = draft.photos.length >= (CFG.MAX_PHOTOS || 4);
  $('#photo-limit').textContent = full ? '写真は4枚までです。追加するには写真を外してください' :
    '写真は4枚までです。あと' + ((CFG.MAX_PHOTOS || 4) - draft.photos.length) + '枚追加できます' +
    (draft.waiting.length ? '。待機中の写真を追加するか外してください' : '');
  ['#btn-photo-pick', '#btn-photo-album', '#f-photo', '#f-photo-album'].forEach(function (id) { $(id).disabled = full; });
}

function onFormPhotoAction(ev) {
  var btn = ev.target.closest('[data-photo-remove], [data-photo-primary], [data-photo-add]');
  if (!btn || !state.photoDraft) return;
  var d = state.photoDraft;
  var id = btn.getAttribute('data-photo-remove') || btn.getAttribute('data-photo-primary') || btn.getAttribute('data-photo-add');
  var oldCards = $$('[data-form-photo]', $('#photo-slot'));
  var oldIndex = oldCards.indexOf(btn.closest('[data-form-photo]'));
  if (btn.hasAttribute('data-photo-remove')) {
    d.photos = d.photos.filter(function (p) { return p.id !== id; });
    d.waiting = d.waiting.filter(function (p) { return p.id !== id; });
    if (d.primary === id) d.primary = (d.photos[0] || {}).id || '';
  } else if (btn.hasAttribute('data-photo-primary')) d.primary = id;
  else if (d.photos.length < (CFG.MAX_PHOTOS || 4)) {
    var p = d.waiting.filter(function (x) { return x.id === id; })[0];
    if (p) { d.photos.push(p); d.waiting = d.waiting.filter(function (x) { return x.id !== id; }); }
    if (!d.primary) d.primary = id;
  }
  renderFormPhotos();
  var cards = $$('[data-form-photo]', $('#photo-slot'));
  var card = cards.filter(function (f) { return f.getAttribute('data-form-photo') === id; })[0] || cards[Math.min(oldIndex, cards.length - 1)];
  var focus = card ? $('button:not(:disabled)', card) : $('#btn-photo-album');
  focus.focus();
  revealPhotoCard(card);
}

/**
 * 横並びの写真の帯で、操作したカードが帯の外に一部はみ出していたら、カードの左端（吸着位置）まで帯を動かす。
 * focus() は一部でも見えている要素ではスクロールしないため、はみ出したままになることがある。
 */
function revealPhotoCard(card) {
  var slot = $('#photo-slot');
  if (!card || !slot.classList.contains('photo-strip--multiple')) return;
  var c = card.getBoundingClientRect();
  var s = slot.getBoundingClientRect();
  if (c.left >= s.left && c.right <= s.right) return;
  slot.scrollLeft += c.left - s.left - (parseFloat(getComputedStyle(slot).paddingLeft) || 0);
}

async function onPhotoSelected(ev) {
  var input = ev.target;
  var files = Array.prototype.slice.call(input.files || []);
  input.value = '';
  if (!files.length || !state.photoDraft) return;
  var draft = state.photoDraft;
  var remaining = (CFG.MAX_PHOTOS || 4) - draft.photos.length;
  if (files.length > remaining) return photoInputError('あと' + remaining + '枚まで選べます。枚数を減らして選び直してください');
  $('#photo-error').textContent = '';
  loading(true, '画像を処理中…');
  var errors = [];
  try {
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      try {
        if (file.type && !/^image\//i.test(file.type)) throw new Error('画像ファイルを選んでください。JPEGまたはPNGで選び直してください');
        var result = await compressImage(file, CFG.PHOTO_MAX_EDGE || 1280, CFG.PHOTO_QUALITY || 0.82);
        if (state.photoDraft !== draft) return;
        var id = 'photo-' + newOp().id;
        draft.photos.push({ id: id, photo: { data: result.data, mimeType: result.mimeType, filename: result.filename }, previewUrl: result.previewUrl });
        if (!draft.primary) draft.primary = id;
      } catch (err) { errors.push((i + 1) + '枚目: ' + err.message); }
    }
    if (state.photoDraft === draft) {
      renderFormPhotos();
      if (errors.length) photoInputError(errors.join(' / ')); else toast('写真を選択しました（保存時にアップロード）', 'info');
    }
  } finally { loading(false); }
}

function clearPhotoDraft() {
  state.photoDraft = initialPhotoDraft(state.formBase);
  $('#f-photo').value = ''; $('#f-photo-album').value = '';
  $('#photo-error').textContent = '';
  renderFormPhotos();
}

function detailImage(p, name, i) {
  return '<img src="' + esc(detailPhotoUrl(p.url)) + '" alt="' + esc(name) + ' 写真' + (i + 1) + '" decoding="async"' + PHOTO_REFERRER +
    ' class="w-full aspect-[4/3] object-cover bg-slate-200">';
}

function expandPhoto(button) {
  var id = button.getAttribute('data-photo-expand');
  var photos = itemPhotos(state.currentItem);
  var p = photos.filter(function (x) { return x.id === id; })[0];
  if (!p) return;
  var dialog = document.createElement('dialog');
  dialog.setAttribute('aria-label', '写真' + (photos.indexOf(p) + 1) + 'の拡大');
  dialog.className = 'rounded-xl p-3 max-w-full bg-white';
  dialog.innerHTML = '<button class="h-11 px-4 rounded-lg bg-slate-100" autofocus>閉じる</button><img src="' + esc(p.url) +
    '" alt="' + esc(state.currentItem.name) + 'の拡大写真"' + PHOTO_REFERRER + ' style="max-width:90vw;max-height:75vh;object-fit:contain">';
  $('button', dialog).addEventListener('click', function () { dialog.close(); });
  $('img', dialog).addEventListener('error', function () {
    var msg = document.createElement('p'); msg.setAttribute('role', 'alert'); msg.textContent = '拡大写真を読み込めませんでした。閉じて詳細の写真を読み直してください';
    this.replaceWith(msg);
  });
  dialog.addEventListener('close', function () { dialog.remove(); if (button.isConnected) button.focus(); });
  document.body.appendChild(dialog); dialog.showModal();
}

/**
 * canvas で長辺 maxEdge に縮小し JPEG 化する。
 * スマホの原寸写真（3〜8MB）をそのまま送ると GAS 側で詰まるため必須。
 */
// PHOTO.md 項目3: EXIFの向きはブラウザのデコードへ任せ、二重に回転しない。
function compressImage(file, maxEdge, quality) {
  return new Promise(function (resolve, reject) {
    var url, img = new Image(), canvas;
    function cleanup() {
      if (url) URL.revokeObjectURL(url);
      img.onload = img.onerror = null;
      img.src = '';
      if (canvas) canvas.width = canvas.height = 1;
    }
    img.onload = function () {
      try {
        var w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) throw new Error('寸法を取得できません');
        var scale = Math.min(1, maxEdge / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
        canvas = document.createElement('canvas');
        canvas.width = cw; canvas.height = ch;
        var ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('描画領域を確保できません');
        ctx.drawImage(img, 0, 0, cw, ch);
        var dataUrl = canvas.toDataURL('image/jpeg', quality);
        if (!/^data:image\/jpeg;base64,/.test(dataUrl)) throw new Error('JPEGに変換できません');
        var data = dataUrl.split(',')[1];
        if (!data || data.length * 3 / 4 > 6 * 1024 * 1024) throw new Error('写真が大きすぎます');
        resolve({ data: data, mimeType: 'image/jpeg',
          filename: (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg', previewUrl: dataUrl });
      } catch (err) {
        reject(new Error('写真を処理できません。小さいJPEGで選び直してください'));
      } finally { cleanup(); }
    };
    img.onerror = function () {
      cleanup();
      reject(new Error('この写真を読み込めません。JPEGまたはPNGに変換して選び直してください'));
    };
    try { url = URL.createObjectURL(file); img.src = url; }
    catch (err) { cleanup(); reject(new Error('写真を処理できません。小さいJPEGで選び直してください')); }
  });
}
