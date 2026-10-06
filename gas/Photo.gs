/**
 * Photo.gs
 * ------------------------------------------------------------------
 * 備品写真を Google Drive に保存する。
 * フロントからは Base64（data URL のヘッダを除いた本体）で受け取る。
 * ------------------------------------------------------------------
 */

// PHOTO.md 項目6: この書き込みで作成/取り外し候補となったDriveファイル。
var PHOTO_CANDIDATES_ = null;

var ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * @param {{data: string, mimeType: string, filename: string}} photo
 * @param {string} itemId
 * @param {string} userEmail
 * @return {string} 表示用 URL
 */
function savePhoto_(photo, itemId, userEmail) {
  return storePhoto_(preparePhoto_(photo), itemId, userEmail);
}

/**
 * 写真を検証して復号する（Drive にはまだ保存しない）。形式・大きさの誤りはここで弾くので、
 * シートに書き込む前に呼べば、写真の誤りで備品だけが登録されることはない。
 * @return {{bytes: Array, mime: string, ext: string}}
 */
function preparePhoto_(photo) {
  if (!photo || !photo.data) {
    throw new ApiError_('PHOTO_INVALID', '画像データが空です。', 400);
  }
  var mime = String(photo.mimeType || 'image/jpeg').toLowerCase();
  if (ALLOWED_IMAGE_TYPES.indexOf(mime) === -1) {
    throw new ApiError_('PHOTO_TYPE_UNSUPPORTED', '対応していない画像形式です: ' + mime, 400);
  }

  // data URL が丸ごと来ても受け付ける
  var b64 = String(photo.data);
  var comma = b64.indexOf(',');
  if (b64.slice(0, 5) === 'data:' && comma !== -1) b64 = b64.slice(comma + 1);

  // Base64 は元データの約 4/3。デコード前に概算で弾く
  if (b64.length * 3 / 4 > CONST.MAX_PHOTO_BYTES) {
    throw new ApiError_('PHOTO_TOO_LARGE', '画像サイズが大きすぎます。', 413);
  }

  var bytes;
  try {
    bytes = Utilities.base64Decode(b64);
  } catch (e) {
    throw new ApiError_('PHOTO_INVALID', '画像データを復号できませんでした。', 400);
  }

  var ext = mime === 'image/png' ? 'png' : (mime === 'image/webp' ? 'webp' : 'jpg');
  return { bytes: bytes, mime: mime, ext: ext };
}

/**
 * preparePhoto_ で検証した写真を Drive に保存する。
 * @return {string} 表示用 URL
 */
function storePhoto_(prepared, itemId, userEmail) {
  var name = itemId + '_' + Utilities.formatDate(new Date(), CONST.TIMEZONE, 'yyyyMMdd_HHmmss') + '.' + prepared.ext;
  var blob = Utilities.newBlob(prepared.bytes, prepared.mime, name);

  var folder = DriveApp.getFolderById(cfgPhotoFolderId_());
  var file = folder.createFile(blob);
  recordPhotoCandidate_(file.getId()); // 属性設定で失敗しても候補を失わない
  file.setDescription('備品ID: ' + itemId + ' / 登録者: ' + userEmail);

  // リンクを知っている人が閲覧可（<img> から参照するため）
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    // 組織ポリシーで外部共有が禁止されている場合はここで落ちる。
    // 社内限定で運用するならフォルダ側の共有設定に任せて続行する。
    console.warn('setSharing failed (組織ポリシーの可能性): ' + e.message);
  }

  lap_('savePhoto');
  return 'https://lh3.googleusercontent.com/d/' + file.getId();
}

/** photo_url から Drive ファイル ID を取り出す（削除時などに使用） */
function fileIdFromPhotoUrl_(url) {
  var m = /lh3\.googleusercontent\.com\/d\/([A-Za-z0-9_-]+)/.exec(String(url || ''));
  if (m) return m[1];
  m = /drive\.google\.com\/(?:file\/d\/|uc\?id=)([A-Za-z0-9_-]+)/.exec(String(url || ''));
  return m ? m[1] : null;
}

/** PHOTO.md 項目4: 既存の1枚を安定したIDへ正規化する。 */
function legacyPhotoId_(url) {
  var id = fileIdFromPhotoUrl_(url);
  if (!id) {
    var h = 2166136261;
    for (var i = 0; i < url.length; i++) h = Math.imul(h ^ url.charCodeAt(i), 16777619) >>> 0;
    id = h.toString(16);
  }
  return 'legacy-' + id;
}
function readPhotos_(raw, primaryUrl) {
  if (raw) {
    try {
      var list = JSON.parse(raw);
      if (Array.isArray(list)) return list;
    } catch (e) { console.error('photos JSON invalid'); }
  }
  return primaryUrl ? [{ id: legacyPhotoId_(primaryUrl), url: primaryUrl }] : [];
}

/** 全入力を保存前に検証。既存URLはその備品のID/URL参照だけを許す。 */
function preparePhotos_(payload, item) {
  if (payload.photos === undefined) {
    if (payload.primary_photo_id !== undefined) throw new ApiError_('PHOTO_INVALID', '代表の指定にはphotosが必要です。', 400);
    return null;
  }
  if (payload.photo !== undefined) throw new ApiError_('PHOTO_INVALID', 'photoとphotosは同時に指定できません。', 400);
  var list = payload.photos;
  if (!Array.isArray(list) || list.length > CONST.MAX_PHOTOS) throw new ApiError_('PHOTO_LIMIT', '写真は4枚までです。', 400);
  var old = (item && item.photos) || [], seen = {};
  var prepared = list.map(function (entry) {
    if (!entry || typeof entry.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(entry.id) || seen[entry.id]) throw new ApiError_('PHOTO_INVALID', '写真IDが不正または重複しています。', 400);
    seen[entry.id] = true;
    var existing = old.filter(function (p) { return p.id === entry.id; })[0];
    if (entry.photo !== undefined) {
      if (existing || entry.url !== undefined) throw new ApiError_('PHOTO_INVALID', '写真IDを新規画像に使い回せません。', 400);
      return { id: entry.id, prepared: preparePhoto_(entry.photo) };
    }
    if (!existing || existing.url !== entry.url) throw new ApiError_('PHOTO_INVALID', 'この備品の写真ではありません。', 400);
    return { id: existing.id, url: existing.url };
  });
  var primary = toStr_(payload.primary_photo_id);
  if (primary && !seen[primary]) throw new ApiError_('PHOTO_INVALID', '代表の写真が並びにありません。', 400);
  return { entries: prepared, primary: primary || ((item && old.filter(function (p) { return p.url === item.photo_url && seen[p.id]; })[0]) || {}).id || (prepared[0] && prepared[0].id) || '' };
}

/** 保存失敗はIDごとに返し、保存済みの参照はそのまま保つ。 */
function storePhotos_(selection, itemId, email) {
  var photos = [], errors = [];
  selection.entries.forEach(function (entry) {
    if (entry.url) { photos.push({ id: entry.id, url: entry.url }); return; }
    try { photos.push({ id: entry.id, url: storePhoto_(entry.prepared, itemId, email) }); }
    catch (e) {
      console.error('photo save failed: ' + itemId + '/' + entry.id + ': ' + e.message);
      errors.push({ id: entry.id, message: '写真を保存できませんでした。写真だけ送り直してください。' });
    }
  });
  var primary = photos.filter(function (p) { return p.id === selection.primary; })[0] || photos[0];
  return { photos: photos, photo_url: primary ? primary.url : '', errors: errors };
}
function photoResponse_(res, errors) {
  if (errors && errors.length) {
    res.photoErrors = errors;
    res.photoError = errors.length + '枚の写真を保存できませんでした。';
  }
  return res;
}

/** 未記録の結果を保持。履歴がある古い結果だけを片付ける。 */
function photoOpState_(item, before, after, errors) {
  var saved = {};
  try { saved = JSON.parse((item && item._photo_ops) || '{}'); } catch (e) {}
  var ids = Object.keys(saved), logged = loggedOpIds_(ids);
  ids.forEach(function (id) { if (logged[id]) delete saved[id]; });
  var mark = currentOpMark_();
  if (mark) saved[splitMark_(mark).id] = { mark: mark, before: before, after: after, errors: errors };
  return JSON.stringify(saved);
}

/** 今回の書き込みだけを候補にする。同ID確認では候補を作り直さない。 */
function recordPhotoCandidate_(id) {
  if (PHOTO_CANDIDATES_ && id && PHOTO_CANDIDATES_.indexOf(id) === -1) PHOTO_CANDIDATES_.push(id);
}
function recordOldPhotos_(item) {
  var urls = (item.photos || []).map(function (p) { return p.url; });
  urls.push(item.photo_url);
  urls.forEach(function (url) { recordPhotoCandidate_(fileIdFromPhotoUrl_(url)); });
}

/**
 * PHOTO.md 項目6: ロック内の最後に、キャッシュを使わず確定した全行の参照を確認する。
 * 書き込みが例外になっても、書かれた行にある写真は守る。確認不能なら全候補を残す。
 * 履歴は参照として数えない（古いURLが読めなくなるのは確定事項）。
 */
function cleanupPhotos_() {
  var candidates = PHOTO_CANDIDATES_ || [];
  PHOTO_CANDIDATES_ = null;
  if (!candidates.length) return;
  var used = Object.create(null);
  try {
    SpreadsheetApp.flush();
    var values = sheet_(CONST.SHEET_ITEMS).getDataRange().getValues();
    var idx = headerIndex_(values[0]);
    assertHeaders_(idx, CONST.ITEM_HEADERS, CONST.SHEET_ITEMS);
    values.slice(1).forEach(function (row) {
      // 論理削除やIDの空欄も含め、シートに残る参照は保護する。
      var urls = [row[idx.photo_url]];
      var raw = idx.photos === undefined ? '' : row[idx.photos];
      if (raw) {
        var photos = JSON.parse(String(raw));
        if (!Array.isArray(photos)) throw new Error('photosが配列ではありません');
        photos.forEach(function (p) {
          if (!p || typeof p.url !== 'string') throw new Error('photosのURLを確認できません');
          urls.push(p.url);
        });
      }
      urls.forEach(function (url) { var id = fileIdFromPhotoUrl_(url); if (id) used[id] = true; });
    });
  } catch (e) {
    console.error('photo cleanup verification failed; kept ' + candidates.join(',') + ': ' + e.message);
    return;
  }
  candidates.forEach(function (id) {
    if (used[id]) return;
    try { DriveApp.getFileById(id).setTrashed(true); }
    catch (e) { console.error('photo cleanup failed: ' + id + ': ' + e.message); }
  });
}
