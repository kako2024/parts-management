/**
 * Util.gs
 * ------------------------------------------------------------------
 * 共通ユーティリティとエラー型。
 * ------------------------------------------------------------------
 */

/**
 * API 用の例外。code / message / httpish なステータスを持つ。
 * GAS Web App は常に HTTP 200 を返すため、status はレスポンス JSON に載せて
 * フロント側で分岐させる用途で使う。
 */
function ApiError_(code, message, status, data) {
  var e = new Error(message);
  e.name = 'ApiError';
  e.code = code;
  e.status = status || 400;
  if (data !== undefined) e.data = data; // 画面が次の操作を決めるための値（OP_MISMATCH の備品など）
  return e;
}

/**
 * このリクエストでシートへの書き込みを始めたか。書き込みの途中で失敗すると、一部だけ保存された
 * 可能性があるので、エラーの応答に maybeSaved を付けて画面に知らせる（画面は同じ操作 ID で送り直す）。
 */
var WRITE_STARTED_ = false;

function noteWriteStarted_() {
  WRITE_STARTED_ = true;
}

/* =========================================================
 * 処理時間の計測（PERF.md の内訳計測用）
 * リクエストに debugTiming: true があるときだけ区間ごとの ms を記録し、
 * レスポンスの timing に載せる。無いときは何もしない。
 * =======================================================*/

var TIMING_ = null;

/** @param {number} t0 計測の起点（doPost に入った時刻） */
function timingStart_(enabled, t0) {
  TIMING_ = enabled ? { t0: t0, last: t0, laps: [] } : null;
}

/** 前回の lap_ からの経過を label として記録する */
function lap_(label) {
  if (!TIMING_) return;
  var now = Date.now();
  TIMING_.laps.push(label + '=' + (now - TIMING_.last));
  TIMING_.last = now;
}

/** JSON レスポンスを組み立てる */
function jsonOut_(obj) {
  if (TIMING_) {
    lap_('rest');
    obj.timing = { total: Date.now() - TIMING_.t0, laps: TIMING_.laps.join(' ') };
    TIMING_ = null;
  }
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function okRes_(data) {
  return jsonOut_({ ok: true, data: data === undefined ? null : data });
}

function errRes_(err) {
  var code = (err && err.code) || 'INTERNAL_ERROR';
  var status = (err && err.status) || 500;
  var message = (err && err.message) || String(err);
  if (status >= 500) {
    console.error('[API ERROR] ' + code + ' : ' + message + '\n' + (err && err.stack));
  }
  var error = { code: code, message: message, status: status };
  if (WRITE_STARTED_) error.maybeSaved = true;
  if (err && err.data !== undefined) error.data = err.data;
  return jsonOut_({ ok: false, error: error });
}

/** 'YYYY-MM-DD HH:mm:ss' */
function nowString_() {
  return Utilities.formatDate(new Date(), CONST.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
}

/** 'YYYYMMDD' */
function todayCompact_() {
  return Utilities.formatDate(new Date(), CONST.TIMEZONE, 'yyyyMMdd');
}

/** 値を安全に文字列化（Date はフォーマット、null/undefined は空文字） */
function toStr_(v) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, CONST.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
  }
  return String(v);
}

/** シートの TRUE/FALSE 表現を真偽値へ寄せる */
function toBool_(v) {
  if (v === true) return true;
  if (v === false || v === '' || v === null || v === undefined) return false;
  var s = String(v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

/** 数値化。空なら null */
function toNumOrNull_(v) {
  if (v === '' || v === null || v === undefined) return null;
  var n = Number(v);
  return isNaN(n) ? null : n;
}

/** 入力文字列のトリム + 長さ制限 */
function sanitizeText_(v, maxLen) {
  var s = toStr_(v).trim();
  if (maxLen && s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

/** ヘッダー行から {列名: 0始まりindex} を作る */
function headerIndex_(headerRow) {
  var idx = {};
  for (var i = 0; i < headerRow.length; i++) {
    var key = toStr_(headerRow[i]).trim();
    if (key) idx[key] = i;
  }
  return idx;
}

/** 必須ヘッダーが揃っているか検証 */
function assertHeaders_(idx, required, sheetName) {
  var missing = required.filter(function (h) { return idx[h] === undefined; });
  if (missing.length) {
    throw new ApiError_(
      'SHEET_SCHEMA_ERROR',
      'シート "' + sheetName + '" に必要な列がありません: ' + missing.join(', '),
      500
    );
  }
}
