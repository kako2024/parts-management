/**
 * app/core.js — 備品管理 SPA の画面側。状態 state と共通の小道具
 * ------------------------------------------------------------------
 * 画面遷移・API 通信・Google ログインを app/ の下のファイルで扱う。
 * 依存: config.js / cache.js / perf.js / Tailwind CDN / Google Identity Services / html5-qrcode
 *
 * app/ のファイルは普通の <script> で、index.html に書いた次の順に読み込む。
 * 関数と var はグローバルで共有する（ファイルをまたいで呼べる）。
 * 外側で実行するのは定数の初期化と、最後の main.js の boot() だけなので、
 * 関数を足すときは、どのファイルに置いても呼び出せる。外側で別ファイルの関数を呼ぶ初期化は置かない。
 *
 *   core.js    状態 state（ログイン・表示中の備品・写真の下書き・情報の新しさ）と、
 *              DOM の取り出し・エスケープ・トースト・比較などの共通処理
 *   api.js     GAS への通信 api()（読取と保存の期限、認証切れの扱い）と、操作 ID を付けた保存 sendOp()・
 *              ログインの区切り startSession()・認証切れ・ゲスト解除
 *   auth.js    Google ログインの初期化と ID トークンの読み取り。端末内キャッシュの保存と表示
 *              （本体は cache.js）、ログイン後の起動 afterLogin()・ログアウト
 *   sync.js    一覧・詳細の上の「最新の情報です」などの表示。画面遷移 goto() と戻るボタンの履歴
 *   list.js    一覧の取得 loadItems()、Drive の写真を表示サイズで取る URL、一覧の描画 renderList()・絞り込み
 *   detail.js  詳細の取得と描画、写真だけの送り直し、履歴の表示。在庫ステータスの更新・削除と、
 *              保存を待たずに出す仮の表示・成功・競合のときの描き直し
 *   form.js    登録・編集フォームの表示、送信 submitForm()、競合・操作 ID 不一致の扱い
 *   photo.js   写真の下書き（追加・外す・代表）、詳細の写真と拡大表示、縮小
 *   scan.js    QR スキャンと該当備品への移動
 *   main.js    アカウントシート、写真の読み込み失敗の扱いとイベントの登録 bindEvents()、起動 boot()
 * ------------------------------------------------------------------
 */
'use strict';

var CFG = window.APP_CONFIG || {};
var noop = function () {};
var PERF = window.PERF || { enabled: false, begin: noop, mark: noop, end: noop, api: noop, watchImages: noop, bypassToken: noop };

/* ================================================================
 * 状態
 * ==============================================================*/
var state = {
  guest: false,         // 紹介用リンク（?guest=）でログインを省略しているか
  idToken: null,        // メモリ内のみに保持する（localStorage には置かない）
  cacheEmail: null,     // キャッシュの持ち主の照合に使うメール（ID トークンから取り出す。認証省略時は null）
  session: 0,           // ログイン・ログアウトのたびに増やす。古いセッションの API 応答を捨てるため
  tokenExpMs: 0,
  user: null,
  meta: { categories: [], locations: [], stockStatuses: ['余裕あり', '残りわずか', '在庫なし'] },
  items: [],
  filters: { keyword: '', category: '', location: '', stock_status: '', restock: false },
  view: 'list',
  stack: [],            // 戻るボタン用の履歴
  currentItem: null,
  currentLogs: null,    // 表示中の詳細の履歴（null は未取得）
  detailRev: 0,         // 詳細を描き直すたびに増やす。非同期の応答が、その後の表示を上書きしないように使う
  saving: false,        // 更新の応答待ち（その間は詳細の操作ボタンを押せなくする）
  writeSeq: 0,          // 手元で更新した回数（全体）。裏の一覧取得が更新前の内容で上書きしないように使う
  itemRev: {},          // 手元で更新した回数（備品ごと）。裏の詳細取得が更新前の内容で上書きしないように使う
  scanner: null,
  scanning: false,
  pendingItemId: null,  // ログイン前に ?item= で指定された備品
  photoDraft: null,     // { photos: [{id,url}|{id,photo,previewUrl}], primary, waiting }
  formOp: null,         // 結果を確認できなかった保存の操作。フォームから送り直すときに同じ操作 ID を使う
  photoRetry: null,     // 部分失敗した下書きと保存済み参照、固定した版/再送payload
  formBase: null,       // 編集フォームを開いたときの備品。変えた項目だけを送り、その版（version）を添える
  // 情報の新しさ（PLAN-2 項目 3）。status: none / checking（確認中）/ fresh / offline（通信できない）/ error
  // confirmedAt はサーバーで最後に確かめた時刻（備品の updated_at とは別）。listKey は表示中の一覧の絞り込み
  fresh: {
    list: { status: 'none', confirmedAt: null, listKey: null },
    detail: { itemId: null, status: 'none', confirmedAt: null }
  }
};

/* ================================================================
 * 小道具
 * ==============================================================*/
function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

function esc(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** JSON にしたときに同じ値か（備品・履歴・写真の配列をまとめて比べる） */
function sameJson(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function show(el) { el && el.classList.remove('hidden'); }
function hide(el) { el && el.classList.add('hidden'); }

function toast(message, type) {
  var area = $('#toast-area');
  var el = document.createElement('div');
  el.className = 'toast toast-' + (type || 'info');
  el.textContent = message;
  area.appendChild(el);
  setTimeout(function () {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(function () { el.remove(); }, 260);
  }, type === 'error' ? 4200 : 2400);
}

var loadingDepth = 0;
function loading(on, text) {
  loadingDepth += on ? 1 : -1;
  if (loadingDepth < 0) loadingDepth = 0;
  $('#loading-text').textContent = text || '読み込み中…';
  if (loadingDepth > 0) show($('#loading')); else hide($('#loading'));
  if (loadingDepth === 0) {
    var q = afterIdleQueue;
    afterIdleQueue = [];
    q.forEach(function (fn) { fn(); });
  }
}

/**
 * ローディングの覆いが消えた時点で fn を呼ぶ（計測の終点を利用者の見た目に揃えるため）。
 * 覆いが出ていなければその場で呼ぶ。
 */
var afterIdleQueue = [];
function whenIdle(fn) {
  if (loadingDepth === 0) fn(); else afterIdleQueue.push(fn);
}

function statusClass(status) {
  if (status === '余裕あり') return 'badge-ok';
  if (status === '残りわずか') return 'badge-low';
  if (status === '在庫なし') return 'badge-out';
  return 'badge-none';
}

function statusSelectedClass(status) {
  if (status === '余裕あり') return 'selected-ok';
  if (status === '残りわずか') return 'selected-low';
  if (status === '在庫なし') return 'selected-out';
  return '';
}
