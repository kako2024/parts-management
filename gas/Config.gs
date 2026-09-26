/**
 * Config.gs
 * ------------------------------------------------------------------
 * 設定値の集約。
 * 秘匿したい値（スプレッドシートID / グループアドレス / DriveフォルダID）は
 * スクリプトプロパティに保存し、コードには埋め込まない。
 *
 * 初回セットアップ時に Setup.gs の initProperties() を 1 度だけ実行すること。
 * ------------------------------------------------------------------
 */

/** シート名・列定義など、公開されて困らない定数 */
var CONST = {
  SHEET_ITEMS: 'items',
  SHEET_LOGS: 'logs',

  ITEM_HEADERS: [
    'item_id', 'name', 'category', 'location', 'stock_status',
    'quantity', 'photo_url', 'note', 'updated_at', 'updated_by', 'is_deleted'
  ],
  LOG_HEADERS: [
    'log_id', 'timestamp', 'item_id', 'user_email',
    'action_type', 'before_state', 'after_state'
  ],

  /** 在庫ステータスの許容値（これ以外は弾く） */
  STOCK_STATUSES: ['余裕あり', '残りわずか', '在庫なし'],

  /** 操作種別 */
  ACTION_CREATE: 'CREATE',
  ACTION_UPDATE_STATUS: 'UPDATE_STATUS',
  ACTION_UPDATE: 'UPDATE',
  ACTION_DELETE: 'DELETE',

  TIMEZONE: 'Asia/Tokyo',

  /** IDトークン検証結果のキャッシュ秒数（トークン自体の exp を超えない範囲で） */
  TOKEN_CACHE_SEC: 300,
  /** グループ所属判定のキャッシュ秒数 */
  GROUP_CACHE_SEC: 600,
  /** 読み取り用の備品・履歴キャッシュの秒数（シートを直接編集したときは、この秒数以内に反映される） */
  ITEMS_CACHE_SEC: 300,

  /** アップロード写真の上限（デコード後バイト数） */
  MAX_PHOTO_BYTES: 6 * 1024 * 1024,
  /** 書き込みロックの待ち時間(ms) */
  LOCK_WAIT_MS: 20000
};

/** プロパティ読み出しの薄いラッパ */
function prop_(key, required) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  if (required && !v) {
    throw new ApiError_(
      'CONFIG_MISSING',
      'スクリプトプロパティ "' + key + '" が未設定です。Setup.gs の initProperties() を実行してください。',
      500
    );
  }
  return v;
}

function cfgSpreadsheetId_()  { return prop_('SPREADSHEET_ID', true); }
function cfgClientId_()       { return prop_('GOOGLE_CLIENT_ID', true); }
function cfgGroupEmail_()     { return prop_('ALLOWED_GROUP_EMAIL', true); }
function cfgPhotoFolderId_()  { return prop_('PHOTO_FOLDER_ID', true); }

/**
 * 追加の許可メールアドレス（カンマ区切り）。
 * グループに入れられない外部アカウントを個別に通したいときだけ設定する。省略可。
 */
function cfgExtraAllowedEmails_() {
  var raw = prop_('EXTRA_ALLOWED_EMAILS', false) || '';
  return raw.split(',')
    .map(function (s) { return s.trim().toLowerCase(); })
    .filter(function (s) { return !!s; });
}
