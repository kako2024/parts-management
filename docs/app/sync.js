/**
 * app/sync.js — 一覧・詳細の上の「最新の情報です」などの表示と、画面遷移 goto()・戻る
 * 読み込む順と各ファイルの役割は app/core.js の冒頭にある。
 */
'use strict';

/* ================================================================
 * 情報の新しさと通信状態（PLAN-2 項目 3）
 * 一覧と詳細の上に「確認中」「最新（何時に確認）」「通信できません（いつの情報か）」を出し、
 * 手で取り直せるようにする。キャッシュを先に出す動き（PERF.md 4.2）はそのまま。
 * ==============================================================*/

/** これより長くサーバーで確かめていない情報は、目立たせて知らせる */
var STALE_WARN_MS = 24 * 60 * 60 * 1000;

/** 失敗を状態に分ける。通信の失敗は offline、それ以外（サーバーの誤りなど）は error */
function failureStatus(err) {
  return (err && (err.code === 'NETWORK_ERROR' || err.code === 'BAD_RESPONSE')) ? 'offline' : 'error';
}

function setListFresh(patch) {
  state.fresh.list = Object.assign({}, state.fresh.list, patch);
  renderSync();
}

function setDetailFresh(itemId, patch) {
  var cur = state.fresh.detail;
  var base = cur.itemId === itemId ? cur : { itemId: itemId, status: 'none', confirmedAt: null };
  state.fresh.detail = Object.assign({}, base, patch, { itemId: itemId });
  renderSync();
}

function agoText(ms) {
  var min = Math.floor((Date.now() - ms) / 60000);
  if (min < 1) return 'たった今';
  if (min < 60) return min + ' 分前';
  if (min < 24 * 60) return Math.floor(min / 60) + ' 時間前';
  return Math.floor(min / (24 * 60)) + ' 日前';
}

function clockText(ms) {
  var d = new Date(ms);
  var now = new Date();
  var hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  return d.toDateString() === now.toDateString() ? hm : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
}

/** 状態の 1 行（kind は list / detail。「更新」ボタンで取り直す） */
function syncHtml(f, kind) {
  if (!f || f.status === 'none') return '';
  var when = f.confirmedAt ? agoText(f.confirmedAt) + '（' + clockText(f.confirmedAt) + '）に確認した情報' : '';
  var old = f.confirmedAt && f.status !== 'fresh' && Date.now() - f.confirmedAt > STALE_WARN_MS;
  var text;
  var tone = 'text-slate-500';
  if (f.status === 'checking') {
    text = '最新を確認中…' + (when ? '（表示中は ' + when + '）' : '');
  } else if (f.status === 'fresh') {
    text = '最新の情報です（' + clockText(f.confirmedAt || Date.now()) + ' に確認）';
  } else {
    tone = 'text-rose-600';
    text = (f.status === 'offline' ? '通信できません。' : '最新の情報を取得できませんでした。') +
      (when ? when + 'を表示しています' : '最新の情報を表示できていません');
  }
  if (old) {
    tone = 'text-amber-700';
    text = '1 日以上確認できていない古い情報です。' + text;
  }
  var busy = f.status === 'checking';
  return '<span class="sync-text flex-1 ' + tone + '" data-sync-status="' + esc(f.status) + '"' + (old ? ' data-sync-old="1"' : '') + '>' +
    esc(text) + '</span>' +
    '<button class="sync-refresh shrink-0 text-xs font-semibold text-slate-700 underline disabled:opacity-40" ' +
    'data-sync-refresh="' + kind + '"' + (busy ? ' disabled' : '') + '>' +
    (f.status === 'offline' || f.status === 'error' ? '再試行' : '更新') + '</button>';
}

/** 一覧と詳細の状態の行を描き直す（相対時刻を進めるため、1 分ごとにも呼ぶ） */
function renderSync() {
  var listBox = $('#sync-list');
  if (listBox) listBox.innerHTML = syncHtml(state.fresh.list, 'list');
  var detailBox = $('#sync-detail');
  if (detailBox) {
    var f = state.fresh.detail;
    var cur = state.currentItem;
    detailBox.innerHTML = cur && f.itemId === cur.item_id ? syncHtml(f, 'detail') : '';
  }
}

/** 状態の行の「更新」「再試行」 */
function onSyncRefresh(kind) {
  if (kind === 'list') return loadItems({ background: true });
  if (kind === 'detail' && state.currentItem) return refreshDetail(state.currentItem.item_id);
}

/* ================================================================
 * 画面遷移
 * ==============================================================*/

var VIEWS = ['list', 'detail', 'form', 'scan'];

function goto(view, opts) {
  opts = opts || {};
  if (state.view !== view && !opts.replace) state.stack.push(state.view);
  state.view = view;

  VIEWS.forEach(function (v) { hide($('#view-' + v)); });
  show($('#view-' + view));

  // スキャナはスキャン画面から離れたら必ず止める（カメラ・電池対策）
  if (view !== 'scan') stopScanner();

  var titles = { list: '備品一覧', detail: '備品詳細', form: opts.title || '備品登録', scan: 'QR スキャン' };
  $('#header-title').textContent = titles[view] || CFG.APP_NAME;

  if (view === 'list') {
    state.stack = [];
    hide($('#btn-back'));
  } else {
    show($('#btn-back'));
  }

  $$('#bottom-nav .nav-btn').forEach(function (b) {
    var key = b.getAttribute('data-nav');
    var on = (key === 'list' && view === 'list') ||
             (key === 'scan' && view === 'scan') ||
             (key === 'new' && view === 'form');
    b.classList.toggle('active', on);
  });

  window.scrollTo(0, 0);
  var main = $('main');
  if (main) main.scrollTop = 0;

  if (view === 'list') {
    if (opts.itemsLoaded) return Promise.resolve();
    // 一覧を一度出していれば、それを見せたまま裏で最新を取る
    return listRenderedOnce ? loadItems({ background: true }) : loadItems();
  }
  if (view === 'scan') return startScanner();
  return Promise.resolve();
}

function back() {
  var prev = state.stack.pop() || 'list';
  goto(prev, { replace: true });
  if (prev === 'list') { state.stack = []; hide($('#btn-back')); }
}
