/**
 * Repository.gs
 * ------------------------------------------------------------------
 * スプレッドシートへの読み書き。
 * ここより上のレイヤ（Api.gs）はシートの構造を知らない。
 * ------------------------------------------------------------------
 */

function ss_() {
  return SpreadsheetApp.openById(cfgSpreadsheetId_());
}

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
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

/** 有効な（論理削除されていない）備品一覧 */
function listItems_(includeDeleted) {
  var data = readItems_();
  var rows = includeDeleted ? data.rows : data.rows.filter(function (it) { return !it.is_deleted; });
  return rows.map(stripInternal_);
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

  var merged = stripInternal_(item);
  Object.keys(patch).forEach(function (k) { merged[k] = patch[k]; });
  merged.updated_at = now;
  merged.updated_by = userEmail;
  return merged;
}

/* =========================================================
 * logs
 * =======================================================*/

function nextLogId_(sh) {
  var today = todayCompact_();
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
 * 履歴を 1 行追加する。
 * before/after はオブジェクトでも文字列でも可（オブジェクトは JSON 化）。
 */
function appendLog_(itemId, userEmail, actionType, before, after) {
  var sh = sheet_(CONST.SHEET_LOGS);
  var logId = nextLogId_(sh);
  var fmt = function (v) {
    if (v === null || v === undefined) return '';
    return (typeof v === 'object') ? JSON.stringify(v) : String(v);
  };
  sh.appendRow([
    logId,
    nowString_(),
    itemId,
    userEmail,
    actionType,
    fmt(before),
    fmt(after)
  ]);
  return logId;
}

/**
 * 履歴を取得する。itemId 指定時はその備品のみ。新しい順。
 */
function readLogs_(itemId, limit) {
  var sh = sheet_(CONST.SHEET_LOGS);
  var values = sh.getDataRange().getValues();
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
