/**
 * Repository.gs
 * ------------------------------------------------------------------
 * スプレッドシートへの読み書き。
 * ここより上のレイヤ（Api.gs）はシートの構造を知らない。
 * ------------------------------------------------------------------
 */

/** 1 回の実行（リクエスト）の中では、スプレッドシートを開くのを 1 度で済ませる */
var SS_ = null;

function ss_() {
  if (!SS_) SS_ = SpreadsheetApp.openById(cfgSpreadsheetId_());
  return SS_;
}

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  lap_('openSheet(' + name + ')');
  if (!sh) {
    throw new ApiError_('SHEET_NOT_FOUND', 'シート "' + name + '" が見つかりません。initSpreadsheet() を実行してください。', 500);
  }
  return sh;
}

/* =========================================================
 * items
 * =======================================================*/

/**
 * items シートを丸ごと読み込み、行番号付きのオブジェクト配列で返す。
 * @return {{rows: Array<Object>, idx: Object, sheet: Sheet}}
 */
function readItems_() {
  var sh = sheet_(CONST.SHEET_ITEMS);
  var values = sh.getDataRange().getValues();
  lap_('readItems(' + (values.length - 1) + 'rows)');
  if (values.length < 1) {
    throw new ApiError_('SHEET_SCHEMA_ERROR', 'items シートが空です。', 500);
  }
  var idx = headerIndex_(values[0]);
  assertHeaders_(idx, CONST.ITEM_HEADERS, CONST.SHEET_ITEMS);

  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var id = toStr_(row[idx.item_id]).trim();
    if (!id) continue; // 空行スキップ
    rows.push({
      _row: r + 1, // 1始まりのシート行番号
      item_id: id,
      name: toStr_(row[idx.name]),
      category: toStr_(row[idx.category]),
      location: toStr_(row[idx.location]),
      stock_status: toStr_(row[idx.stock_status]),
      quantity: toNumOrNull_(row[idx.quantity]),
      photo_url: toStr_(row[idx.photo_url]),
      note: toStr_(row[idx.note]),
      updated_at: toStr_(row[idx.updated_at]),
      updated_by: toStr_(row[idx.updated_by]),
      is_deleted: toBool_(row[idx.is_deleted])
    });
  }
  return { rows: rows, idx: idx, sheet: sh };
}

/* ---------- 読み取り用の備品キャッシュ（PERF.md 項目 5） ----------
 * 一覧・単票の読み取りでは、シートを開いて全体を読む代わりに CacheService の写しを使う。
 * 書き込み系の処理は必ずシートを読む（findItem_）。シートを直接編集した場合は
 * CONST.ITEMS_CACHE_SEC 秒以内に反映される。値は 1 件 100KB までなので、JSON を分割して保存する。
 *
 * 写しは「版」ごとに別のキーへ置く。書き込み（insertItem_ / updateItemRow_）はシートへの反映後に
 * 版を新しくするだけで、写しは消さない。読み取りは「版を確かめてからシートを読み、その版のキーへ置く」。
 * 読み取りの途中で書き込みがあっても、古い内容は古い版のキーに入るので二度と読まれない。
 * 版ごとにキーが分かれるので、別々の読み取りの分割片が混ざることもない。
 */
var ITEMS_CACHE_KEY_ = 'items:v2';
/** 分割の単位（文字数）。全角 3 バイトでも 100KB に収まる大きさ */
var ITEMS_CACHE_CHUNK_ = 30000;
/** 版のキーの有効期限（CacheService の上限）。切れたら読み取り側が新しい版を作る */
var CACHE_VERSION_SEC_ = 21600;

/** verKey の現在の版。無ければ作る */
function cacheVersion_(cache, verKey) {
  var v = cache.get(verKey);
  if (!v) {
    v = Utilities.getUuid();
    cache.put(verKey, v, CACHE_VERSION_SEC_);
  }
  return v;
}

/** この実行で版を新しくする予定のキー（commitCacheVersions_ でまとめて反映する） */
var PENDING_CACHE_VERSIONS_ = {};

/** 書き込みのあとで、verKey の版を新しくするよう予約する */
function bumpCacheVersion_(verKey) {
  PENDING_CACHE_VERSIONS_[verKey] = true;
}

/**
 * 予約した版をまとめて新しくし、それまでの写しを読まれなくする。書き込みの処理の最後に 1 回だけ呼ぶ
 * （withLock_ が呼ぶ）。書き込みを他の実行から見えるようにしてから版を変える
 * （先に変えると、他の実行が新しい版に古い内容を入れ得る）。
 */
function commitCacheVersions_() {
  var keys = Object.keys(PENDING_CACHE_VERSIONS_);
  if (!keys.length) return;
  SpreadsheetApp.flush();
  var cache = CacheService.getScriptCache();
  var fresh = {};
  keys.forEach(function (k) { fresh[k] = Utilities.getUuid(); });
  cache.putAll(fresh, CACHE_VERSION_SEC_);
  PENDING_CACHE_VERSIONS_ = {};
  lap_('commitCache');
}

/** 論理削除を含む全備品（_row なし）。キャッシュにあればそれを返す */
function readItemsForRead_() {
  var cache = CacheService.getScriptCache();
  var base = ITEMS_CACHE_KEY_ + ':' + cacheVersion_(cache, ITEMS_CACHE_KEY_ + ':ver');
  var head = cache.get(base);
  if (head) {
    var keys = [];
    for (var i = 0; i < Number(head); i++) keys.push(base + ':' + i);
    var got = cache.getAll(keys);
    var parts = keys.map(function (k) { return got[k]; });
    if (parts.every(function (p) { return typeof p === 'string'; })) {
      lap_('items(cache)');
      return JSON.parse(parts.join(''));
    }
  }

  var rows = readItems_().rows.map(stripInternal_);
  var json = JSON.stringify(rows);
  var chunks = {};
  var n = Math.max(1, Math.ceil(json.length / ITEMS_CACHE_CHUNK_));
  for (var j = 0; j < n; j++) chunks[base + ':' + j] = json.slice(j * ITEMS_CACHE_CHUNK_, (j + 1) * ITEMS_CACHE_CHUNK_);
  try {
    cache.putAll(chunks, CONST.ITEMS_CACHE_SEC);
    cache.put(base, String(n), CONST.ITEMS_CACHE_SEC); // 本体をすべて置いてから目印を置く
  } catch (e) {
    console.warn('items cache put failed: ' + e.message); // 置けなくても次回シートを読むだけ
  }
  lap_('items(store)');
  return rows;
}

function invalidateItemsCache_() {
  bumpCacheVersion_(ITEMS_CACHE_KEY_ + ':ver');
}

/** 有効な（論理削除されていない）備品一覧 */
function listItems_(includeDeleted) {
  var rows = readItemsForRead_();
  return includeDeleted ? rows : rows.filter(function (it) { return !it.is_deleted; });
}

/** 読み取り用の単票（書き込みには findItem_ を使う） */
function findItemForRead_(itemId) {
  var rows = readItemsForRead_();
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].item_id === itemId) return rows[i];
  }
  return null;
}

function findItem_(itemId) {
  var data = readItems_();
  var target = null;
  for (var i = 0; i < data.rows.length; i++) {
    if (data.rows[i].item_id === itemId) { target = data.rows[i]; break; }
  }
  return { item: target, ctx: data };
}

function stripInternal_(item) {
  var o = {};
  for (var k in item) {
    if (k.charAt(0) === '_') continue;
    o[k] = item[k];
  }
  return o;
}

/** 次の item_id を採番（ITEM-0001 形式） */
function nextItemId_(rows) {
  var max = 0;
  for (var i = 0; i < rows.length; i++) {
    var m = /^ITEM-(\d+)$/.exec(rows[i].item_id);
    if (m) {
      var n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  var next = max + 1;
  return 'ITEM-' + ('0000' + next).slice(-4);
}

/**
 * 備品を新規追加する。
 * @param {Object} input  {name, category, location, stock_status, quantity, note, photo_url, item_id?}
 * @param {string} userEmail
 * @return {Object} 追加された item
 */
function insertItem_(input, userEmail) {
  var data = readItems_();
  var idx = data.idx;

  var itemId = sanitizeText_(input.item_id, 64);
  if (itemId) {
    // 手入力の ID（既存 QR ラベルの流用など）: 重複チェック
    var dup = data.rows.some(function (r) { return r.item_id === itemId; });
    if (dup) {
      throw new ApiError_('ITEM_ID_DUPLICATED', '備品ID "' + itemId + '" は既に使われています。', 409);
    }
  } else {
    itemId = nextItemId_(data.rows);
  }

  var now = nowString_();
  var record = {
    item_id: itemId,
    name: sanitizeText_(input.name, 120),
    category: sanitizeText_(input.category, 60),
    location: sanitizeText_(input.location, 120),
    stock_status: sanitizeText_(input.stock_status, 20),
    quantity: toNumOrNull_(input.quantity),
    photo_url: sanitizeText_(input.photo_url, 500),
    note: sanitizeText_(input.note, 1000),
    updated_at: now,
    updated_by: userEmail,
    is_deleted: false
  };

  var width = data.sheet.getLastColumn();
  var rowArr = new Array(width).fill('');
  CONST.ITEM_HEADERS.forEach(function (h) {
    var v = record[h];
    if (h === 'is_deleted') v = false;
    if (h === 'quantity' && v === null) v = '';
    rowArr[idx[h]] = v;
  });

  data.sheet.appendRow(rowArr);
  invalidateItemsCache_();
  lap_('appendItem');
  return record;
}

/**
 * 既存行を部分更新する。
 * @param {Object} item  readItems_ が返した行オブジェクト（_row を持つ）
 * @param {Object} patch 更新したい列だけ
 * @param {Object} ctx   readItems_ の戻り値
 * @param {string} userEmail
 */
function updateItemRow_(item, patch, ctx, userEmail) {
  var sh = ctx.sheet;
  var idx = ctx.idx;
  var row = item._row;

  Object.keys(patch).forEach(function (key) {
    if (idx[key] === undefined) return;
    var v = patch[key];
    if (key === 'quantity' && v === null) v = '';
    sh.getRange(row, idx[key] + 1).setValue(v);
  });

  var now = nowString_();
  sh.getRange(row, idx.updated_at + 1).setValue(now);
  sh.getRange(row, idx.updated_by + 1).setValue(userEmail);
  invalidateItemsCache_();
  lap_('writeRow');

  var merged = stripInternal_(item);
  Object.keys(patch).forEach(function (k) { merged[k] = patch[k]; });
  merged.updated_at = now;
  merged.updated_by = userEmail;
  return merged;
}

/* =========================================================
 * logs
 * =======================================================*/

/**
 * 次の log_id を採番する。その日の最後の連番を CacheService に覚えておき、シートの読み込みを省く
 * （書き込みはロックの中で行うので、連番の取り合いは起きない）。覚えていなければシートを読む。
 */
function nextLogId_(sh) {
  var today = todayCompact_();
  var cache = CacheService.getScriptCache();
  var seqKey = 'logseq:' + today;
  var known = cache.get(seqKey);
  if (known !== null) {
    var seqNext = Number(known) + 1;
    cache.put(seqKey, String(seqNext), 6 * 60 * 60);
    return 'LOG-' + today + '-' + ('00' + seqNext).slice(-3);
  }
  var id = nextLogIdFromSheet_(sh, today);
  cache.put(seqKey, String(parseInt(id.split('-')[2], 10)), 6 * 60 * 60);
  return id;
}

function nextLogIdFromSheet_(sh, today) {
  var last = sh.getLastRow();
  var seq = 0;
  if (last > 1) {
    // 直近 200 行だけ見れば日付連番としては十分
    var start = Math.max(2, last - 199);
    var ids = sh.getRange(start, 1, last - start + 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      var m = /^LOG-(\d{8})-(\d+)$/.exec(toStr_(ids[i][0]));
      if (m && m[1] === today) {
        var n = parseInt(m[2], 10);
        if (n > seq) seq = n;
      }
    }
  }
  return 'LOG-' + today + '-' + ('00' + (seq + 1)).slice(-3);
}

/**
 * 履歴を 1 行追加し、追加した履歴を返す。
 * before/after はオブジェクトでも文字列でも可（オブジェクトは JSON 化）。
 */
function appendLog_(itemId, userEmail, actionType, before, after) {
  var sh = sheet_(CONST.SHEET_LOGS);
  var logId = nextLogId_(sh);
  var fmt = function (v) {
    if (v === null || v === undefined) return '';
    return (typeof v === 'object') ? JSON.stringify(v) : String(v);
  };
  var log = {
    log_id: logId,
    timestamp: nowString_(),
    item_id: itemId,
    user_email: userEmail,
    action_type: actionType,
    before_state: fmt(before),
    after_state: fmt(after)
  };
  sh.appendRow([log.log_id, log.timestamp, log.item_id, log.user_email, log.action_type, log.before_state, log.after_state]);
  bumpCacheVersion_(logVersionKey_(itemId));
  lap_('appendLog');
  return log; // readLogs_ と同じ形。画面が履歴を取り直さずに済むよう API の応答に含める
}

/* ---------- 詳細画面用の履歴キャッシュ（PERF.md 項目 5） ----------
 * 備品ごとの直近 LOG_CACHE_LIMIT 件を CacheService に置き、その備品の履歴を追記したら版を新しくする。
 */
var LOG_CACHE_LIMIT_ = 30;

/** 備品ごとの版のキー（備品キャッシュと同じく、版ごとに写しのキーを分ける） */
function logVersionKey_(itemId) { return 'logs:v2:' + itemId + ':ver'; }

/** 備品の直近の履歴（新しい順、limit は LOG_CACHE_LIMIT_ まで） */
function readItemLogs_(itemId, limit) {
  var cache = CacheService.getScriptCache();
  var key = 'logs:v2:' + itemId + ':' + cacheVersion_(cache, logVersionKey_(itemId));
  var hit = cache.get(key);
  if (hit) {
    lap_('logs(cache)');
    return JSON.parse(hit).slice(0, limit);
  }
  var logs = readLogs_(itemId, LOG_CACHE_LIMIT_);
  try {
    cache.put(key, JSON.stringify(logs), CONST.ITEMS_CACHE_SEC);
  } catch (e) {
    console.warn('logs cache put failed: ' + e.message);
  }
  return logs.slice(0, limit);
}

/**
 * 履歴を取得する。itemId 指定時はその備品のみ。新しい順。
 */
function readLogs_(itemId, limit) {
  var sh = sheet_(CONST.SHEET_LOGS);
  var values = sh.getDataRange().getValues();
  lap_('readLogs(' + (values.length - 1) + 'rows)');
  if (values.length < 2) return [];
  var idx = headerIndex_(values[0]);
  assertHeaders_(idx, CONST.LOG_HEADERS, CONST.SHEET_LOGS);

  var out = [];
  for (var r = values.length - 1; r >= 1; r--) {
    var row = values[r];
    var id = toStr_(row[idx.item_id]);
    if (itemId && id !== itemId) continue;
    out.push({
      log_id: toStr_(row[idx.log_id]),
      timestamp: toStr_(row[idx.timestamp]),
      item_id: id,
      user_email: toStr_(row[idx.user_email]),
      action_type: toStr_(row[idx.action_type]),
      before_state: toStr_(row[idx.before_state]),
      after_state: toStr_(row[idx.after_state])
    });
    if (limit && out.length >= limit) break;
  }
  return out;
}
