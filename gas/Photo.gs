/**
 * Photo.gs
 * ------------------------------------------------------------------
 * 備品写真を Google Drive に保存する。
 * フロントからは Base64（data URL のヘッダを除いた本体）で受け取る。
 * ------------------------------------------------------------------
 */

var ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * @param {{data: string, mimeType: string, filename: string}} photo
 * @param {string} itemId
 * @param {string} userEmail
 * @return {string} 表示用 URL
 */
function savePhoto_(photo, itemId, userEmail) {
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
  var name = itemId + '_' + Utilities.formatDate(new Date(), CONST.TIMEZONE, 'yyyyMMdd_HHmmss') + '.' + ext;
  var blob = Utilities.newBlob(bytes, mime, name);

  var folder = DriveApp.getFolderById(cfgPhotoFolderId_());
  var file = folder.createFile(blob);
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
