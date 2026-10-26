/**
 * app/main.js — アカウントシート、イベントの登録 bindEvents()、起動 boot()
 * 読み込む順と各ファイルの役割は app/core.js の冒頭にある。
 */
'use strict';

/* ================================================================
 * アカウントシート
 * ==============================================================*/
function openUserSheet() { show($('#user-sheet')); }
function closeUserSheet() { hide($('#user-sheet')); }

/* ================================================================
 * イベント配線
 * ==============================================================*/

/**
 * 写真の読み込みに失敗したら、1 秒後に 1 回だけ読み直す（一時的な失敗に備える）。
 * 2 回目も失敗したら「読み込めなかった」と分かる表示に置き換える（「写真なし」の 📦 とは分ける。PLAN-2 項目 4）。
 *   - 一覧のサムネイル：⚠ の枠にし、一覧の上に「読み込めなかった写真を読み直す」を出す
 *   - 詳細の写真：「写真を読み込めませんでした」と「再読み込み」ボタンを出す
 * 読み直すまでに画面を離れていたら（その画面が隠れている）、取りに行かずに失敗の表示にする。
 * 手で読み直したときも、自動の読み直しは 1 回だけなので、読み直しが続くことはない。
 * img.dataset.retry: 未設定 → 読み直し待ち '1' → 読み直しも失敗 'done'（docs/perf.js もこれを見る）
 */
function onImageError(ev) {
  var img = ev.target;
  if (!img || img.tagName !== 'IMG' || !img.isConnected || !img.closest('#item-list, #view-detail')) return;
  if (!img.dataset.retry) {
    img.dataset.retry = '1';
    var src = img.getAttribute('src');
    setTimeout(function () {
      // 待つ間に描き直しで外れた、または別の写真に変わった img は読み直さない
      if (!img.isConnected || img.getAttribute('src') !== src) return;
      if (img.closest('section.hidden')) return markPhotoFailed(img); // 画面を離れていた
      img.removeAttribute('src');
      img.setAttribute('src', src);
    }, 1000);
    return;
  }
  markPhotoFailed(img);
}

function markPhotoFailed(img) {
  img.dataset.retry = 'done';
  if (img.dataset.thumb) {
    var mark = document.createElement('div');
    mark.setAttribute('data-photo-failed', '1');
    mark.className = 'w-16 h-16 rounded-xl bg-rose-50 border border-rose-200 shrink-0 flex flex-col items-center justify-center text-rose-500';
    mark.innerHTML = '<span class="text-xl leading-none">⚠</span><span class="text-[10px] mt-0.5">読めません</span>';
    img.replaceWith(mark);
    show($('#btn-photo-reload-list'));
    return;
  }
  if (img.closest('#view-detail')) {
    var box = document.createElement('div');
    var figure = img.closest('[data-detail-photo]');
    var index = $$('#view-detail [data-detail-photo]').indexOf(figure);
    if (index === 0) box.id = 'photo-failed';
    box.setAttribute('data-photo-failed', '1');
    box.className = 'w-full aspect-[4/3] bg-rose-50 flex flex-col items-center justify-center gap-2 text-rose-600';
    box.innerHTML = '<span class="text-4xl">⚠</span><p class="text-sm">写真' + (index + 1) + 'を読み込めなかった（写真を読み込めませんでした）</p>' +
      '<button' + (index === 0 ? ' id="btn-photo-reload"' : '') + ' data-photo-reload="' + esc(figure.getAttribute('data-detail-photo')) + '" class="h-11 px-4 rounded-xl bg-white border border-rose-300 text-sm font-semibold">再読み込み</button>';
    $('[data-photo-expand]', figure).disabled = true;
    img.replaceWith(box);
  }
}

function bindEvents() {
  document.addEventListener('error', onImageError, true); // img の error は伝わらないので捕捉段階で受ける
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('[data-sync-refresh]');
    if (b && !b.disabled) onSyncRefresh(b.getAttribute('data-sync-refresh'));
  });
  $('#btn-photo-reload-list').addEventListener('click', renderList); // 読み込めなかった写真を取り直す
  setInterval(renderSync, 60 * 1000); // 「N 分前」を進める
  $('#btn-back').addEventListener('click', back);
  $('#btn-user').addEventListener('click', openUserSheet);
  $('#btn-logout').addEventListener('click', logout);
  $$('[data-close-sheet]').forEach(function (el) {
    el.addEventListener('click', closeUserSheet);
  });

  $$('#bottom-nav .nav-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var key = btn.getAttribute('data-nav');
      if (key === 'new') openForm(null);
      else goto(key === 'list' ? 'list' : 'scan');
    });
  });

  // 一覧のカード（イベント委譲）
  $('#item-list').addEventListener('click', function (ev) {
    var card = ev.target.closest('[data-item-id]');
    if (!card) return;
    PERF.begin('B 一覧→詳細');
    openDetail(card.getAttribute('data-item-id'));
  });

  // 詳細のボタン（イベント委譲）
  $('#view-detail').addEventListener('click', function (ev) {
    var statusBtn = ev.target.closest('[data-set-status]');
    if (statusBtn) return updateStatus(statusBtn.getAttribute('data-set-status'));
    if (ev.target.closest('#btn-edit')) return openForm(state.currentItem);
    if (ev.target.closest('#btn-photo-retry')) return retryPhoto();
    var expand = ev.target.closest('[data-photo-expand]');
    if (expand) return expandPhoto(expand);
    var reload = ev.target.closest('[data-photo-reload]');
    if (reload && state.currentItem) {
      var figure = reload.closest('[data-detail-photo]');
      var photos = itemPhotos(state.currentItem);
      var p = photos.filter(function (x) { return x.id === reload.getAttribute('data-photo-reload'); })[0];
      if (!p) return;
      $('[data-photo-failed]', figure).outerHTML = detailImage(p, state.currentItem.name, photos.indexOf(p));
      $('[data-photo-expand]', figure).disabled = false;
      $('[data-photo-expand]', figure).focus();
      return;
    }
    if (ev.target.closest('#btn-delete')) return deleteItem();
  });

  // 検索（入力が止まってから投げる）
  var timer = null;
  $('#search-input').addEventListener('input', function (ev) {
    state.filters.keyword = ev.target.value;
    clearTimeout(timer);
    timer = setTimeout(loadItems, 350);
  });

  [['#filter-status', 'stock_status'], ['#filter-category', 'category'], ['#filter-location', 'location']]
    .forEach(function (pair) {
      $(pair[0]).addEventListener('change', function (ev) {
        state.filters[pair[1]] = ev.target.value;
        ev.target.classList.toggle('active', !!ev.target.value);
        // 在庫を選んだら要補充は外す（どちらも在庫ステータスの絞り込みなので、同時には使わない）
        if (pair[1] === 'stock_status' && ev.target.value) state.filters.restock = false;
        rebuildFilterOptions();
        loadItems();
      });
    });

  // 要補充（残りわずか・在庫なし）の入口。押すたびに付け外しする（PLAN-2 項目 5）
  $('#btn-restock').addEventListener('click', function () {
    state.filters.restock = !state.filters.restock;
    if (state.filters.restock) state.filters.stock_status = '';
    rebuildFilterOptions();
    loadItems();
  });

  $('#btn-clear-filter').addEventListener('click', function () {
    state.filters = { keyword: '', category: '', location: '', stock_status: '', restock: false };
    $('#search-input').value = '';
    rebuildFilterOptions();
    loadItems();
  });

  $('#btn-manual-go').addEventListener('click', function () {
    var id = $('#manual-id').value.trim();
    if (!id) return;
    $('#manual-id').value = '';
    PERF.begin('B ID入力→詳細');
    openDetail(extractItemId(id));
  });
  $('#manual-id').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); $('#btn-manual-go').click(); }
  });

  // タブが裏に回ったらカメラを止める
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stopScanner();
    else if (state.view === 'scan' && state.user) startScanner();
  });

  // Android の戻るキー / ブラウザバック
  window.addEventListener('popstate', function () {
    if (state.view !== 'list') {
      back();
      history.pushState(null, '', location.href);
    }
  });
  history.pushState(null, '', location.href);
}

/* ================================================================
 * 起動
 * ==============================================================*/

function checkConfig() {
  var problems = [];
  if (!CFG.GAS_API_URL || /XXXXXXXX/.test(CFG.GAS_API_URL)) {
    problems.push('config.js の GAS_API_URL が未設定です。');
  }
  if (!CFG.GOOGLE_CLIENT_ID || /xxxxxxxxxxxx/.test(CFG.GOOGLE_CLIENT_ID)) {
    problems.push('config.js の GOOGLE_CLIENT_ID が未設定です。');
  }
  return problems;
}

// 紹介用リンク（?guest=トークン）。トークンは localStorage に保存し、URL からは消す。
function readGuestToken() {
  try {
    var p = new URLSearchParams(location.search);
    var t = p.get('guest');
    if (t) {
      localStorage.setItem('guest:token', t);
      p.delete('guest');
      var q = p.toString();
      history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash);
    }
    return localStorage.getItem('guest:token') || null;
  } catch (e) {
    return null;
  }
}

/**
 * app/ の各ファイルが読み込めたかを、ファイルごとに1つずつ置いた関数で確かめる。
 * 回線が弱いと一部のファイルだけ読めないことがあり、そのまま起動すると、そのファイルの操作だけが黙って壊れる。
 */
var APP_FILE_MARKERS = {
  'core.js': 'esc', 'api.js': 'sendOp', 'auth.js': 'afterLogin', 'sync.js': 'goto', 'list.js': 'renderList',
  'detail.js': 'renderDetail', 'form.js': 'submitForm', 'photo.js': 'compressImage', 'scan.js': 'startScanner'
};

function missingAppFiles() {
  return Object.keys(APP_FILE_MARKERS).filter(function (f) { return typeof window[APP_FILE_MARKERS[f]] !== 'function'; });
}

// core.js が無くても出せるよう、DOM を直接さわる
function showLoadError(files) {
  var app = document.getElementById('app');
  var login = document.getElementById('view-login');
  var box = document.getElementById('login-error');
  if (app) app.classList.add('hidden');
  if (login) login.classList.remove('hidden');
  if (box) {
    box.textContent = '画面の読み込みに失敗しました（' + files.join('、') + '）。再読み込みしてください。';
    box.classList.remove('hidden');
  }
}

function boot() {
  var missing = missingAppFiles();
  if (missing.length) {
    showLoadError(missing);
    return;
  }
  PERF.begin('A 起動→一覧', 0); // ナビゲーション開始時点から計る
  bindEvents();

  var params = new URLSearchParams(location.search);
  var itemParam = params.get('item');
  if (itemParam) state.pendingItemId = extractItemId(itemParam);

  var problems = checkConfig();
  if (problems.length) {
    showLogin(problems.join('\n'));
    return;
  }

  showLogin('');

  // 計測用の認証省略（?perf=1 かつトークンが置かれているときだけ。PERF.md 1.5）
  var bypass = PERF.bypassToken();
  if (!bypass) {
    bypass = readGuestToken();
    if (bypass) state.guest = true;
  }
  if (bypass) {
    PERF.mark('A 起動→一覧', 'credential(bypass)');
    startSession();
    state.idToken = bypass;
    afterLogin();
    return;
  }
  initGoogleSignIn();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
