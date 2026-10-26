/**
 * app/api.js — GAS への通信 api() と、操作 ID を付けた保存 sendOp()（送り直しで二重に保存しない）
 * 読み込む順と各ファイルの役割は app/core.js の冒頭にある。
 */
'use strict';

/* ================================================================
 * API
 * ==============================================================*/

/**
 * GAS Web App を叩く。
 *
 * Content-Type を text/plain にしているのは意図的。
 * application/json にするとブラウザが CORS プリフライト(OPTIONS)を送るが、
 * GAS はそれに応答しないためリクエストが失敗する。
 * text/plain なら「単純リクエスト」扱いになりプリフライトが発生しない。
 */
function api(action, payload) {
  var req = {
    action: action,
    idToken: state.idToken,
    payload: payload || {}
  };
  if (PERF.enabled) req.debugTiming = true; // GAS に処理時間の内訳を返させる（PERF.md）
  var body = JSON.stringify(req);
  var sentAt = performance.now();
  var session = state.session;
  // 送ってから応答までの間にログアウト・別ユーザーでのログインがあったら、応答は画面にもキャッシュにも使わない。
  // 決着しない Promise を返して後続の処理ごと止める（覆いの数は startSession で数え直す）
  var stale = function () { return state.session !== session; };
  var never = function () { return new Promise(function () {}); };

  // PHOTO.md 項目9: 応答と本文の両方に期限を設ける。保存は期限後も実行済みの可能性がある。
  var writing = ['createItem', 'updateItem', 'updateStatus', 'deleteItem'].indexOf(action) >= 0;
  var configured = Number(writing ? CFG.API_WRITE_TIMEOUT_MS : CFG.API_READ_TIMEOUT_MS);
  var timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : (writing ? 420000 : 60000);
  var controller = new AbortController();
  var timedOut = false;
  var timer = setTimeout(function () { timedOut = true; controller.abort(); }, timeoutMs);

  return fetch(CFG.GAS_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: body,
    redirect: 'follow',
    signal: controller.signal
  }).then(function (res) {
    return res.text();
  }).then(function (text) {
    clearTimeout(timer);
    if (stale()) return never();
    var json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      PERF.api(action, Math.round(performance.now() - sentAt));
      throw {
        code: 'BAD_RESPONSE',
        message: 'サーバーの応答を解析できませんでした。GAS のデプロイ設定（アクセスできるユーザー = 全員）を確認してください。'
      };
    }
    PERF.api(action, Math.round(performance.now() - sentAt), json.timing);
    if (!json.ok) {
      var err = json.error || { code: 'UNKNOWN', message: '不明なエラー' };
      if (err.status === 401) handleAuthExpired(err.message);
      throw err;
    }
    return json.data;
  }).catch(function (err) {
    clearTimeout(timer);
    if (stale()) return never();
    if (err && typeof err.code === 'string') throw err;
    throw {
      code: 'NETWORK_ERROR',
      message: timedOut
        ? 'サーバーの応答が時間内に完了しませんでした。通信環境を確認して再試行してください。'
        : 'サーバーに接続できませんでした。通信環境と GAS_API_URL の設定を確認してください。'
    };
  });
}

/* ---------- 更新操作の送信（操作 ID つき。PLAN-2 項目 1） ----------
 * 保存のたびに一意な操作 ID を付けて送る。サーバーは同じ操作 ID の送り直しを二重に実行しない（gas/Op.gs）。
 * 保存できたか分からない失敗（通信の失敗・応答の異常・書き込みの途中での失敗）では、同じ操作 ID で
 * 自動で送り直す。それでも分からなければ err.unknown を付けて返し、画面は「結果を確認できていない」と伝える。
 */
// 自動の送り直しの間隔（2 回まで）。config.js の OP_RETRY_DELAYS_MS で変えられる（_test/ui.js は短くする）
var OP_RETRY_DELAYS_MS = Array.isArray(CFG.OP_RETRY_DELAYS_MS) ? CFG.OP_RETRY_DELAYS_MS : [1500, 4000];

function newOp() {
  var id;
  if (window.crypto && crypto.randomUUID) {
    id = crypto.randomUUID();
  } else {
    var bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    id = Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  return { id: id, attempt: 0 };
}

/** 保存できたかどうか分からない失敗か */
function outcomeUnknown(err) {
  return !!err && (err.code === 'NETWORK_ERROR' || err.code === 'BAD_RESPONSE' || err.maybeSaved === true);
}

/** 更新系の API を操作 ID つきで送る。op は送り直すたびに attempt が増える */
function sendOp(action, payload, op) {
  op.attempt++;
  var body = Object.assign({}, payload, { op_id: op.id, op_attempt: op.attempt });
  return api(action, body).catch(function (err) {
    if (!outcomeUnknown(err)) throw err;
    var wait = OP_RETRY_DELAYS_MS[op.attempt - 1];
    if (wait === undefined) {
      err.unknown = true;
      throw err;
    }
    return new Promise(function (resolve) { setTimeout(resolve, wait); })
      .then(function () { return sendOp(action, payload, op); });
  });
}

/**
 * 新しいセッションに切り替える（ログイン・ログアウト・認証切れのとき）。
 * これより前に送った API の応答は api() が捨てるので、覆いと後回しの処理もここで数え直す。
 */
function startSession() {
  state.session++;
  state.saving = false;
  state.photoRetry = null;
  state.fresh = {
    list: { status: 'none', confirmedAt: null, listKey: null },
    detail: { itemId: null, status: 'none', confirmedAt: null }
  };
  loadingDepth = 0;
  afterIdleQueue = [];
  hide($('#loading'));
}

function handleAuthExpired(message) {
  startSession();
  var wasGuest = state.guest;
  state.idToken = null;
  state.user = null;
  if (wasGuest) {
    leaveGuest();
    message = '紹介用のリンクは無効になりました。Google でログインしてください。';
  }
  showLogin(message || 'ログインの有効期限が切れました。もう一度ログインしてください。');
}

// 紹介用リンクの利用をやめ、Google ログインに戻す（boot で初期化していないので、ここで呼ぶ）。
function leaveGuest() {
  state.guest = false;
  try { localStorage.removeItem('guest:token'); } catch (e) {}
  initGoogleSignIn();
}
