/**
 * app/auth.js — Google ログイン、端末内キャッシュ（本体は cache.js）、ログイン後の起動 afterLogin() とログアウト
 * 読み込む順と各ファイルの役割は app/core.js の冒頭にある。
 */
'use strict';

/* ================================================================
 * 認証（Google Identity Services）
 * ==============================================================*/

function initGoogleSignIn() {
  if (!window.google || !google.accounts || !google.accounts.id) {
    // GIS スクリプトの読み込み待ち
    return setTimeout(initGoogleSignIn, 120);
  }
  PERF.mark('A 起動→一覧', 'gis');
  google.accounts.id.initialize({
    client_id: CFG.GOOGLE_CLIENT_ID,
    callback: onCredentialResponse,
    auto_select: true,
    cancel_on_tap_outside: false,
    use_fedcm_for_prompt: true
  });
  google.accounts.id.renderButton($('#gsi-button'), {
    type: 'standard',
    theme: 'filled_blue',
    size: 'large',
    shape: 'pill',
    text: 'signin_with',
    locale: 'ja',
    width: 260
  });
  google.accounts.id.prompt(); // 既にログイン済みなら自動で通る
}

function onCredentialResponse(response) {
  if (!response || !response.credential) {
    showLogin('ログインに失敗しました。もう一度お試しください。');
    return;
  }
  startSession();
  state.idToken = response.credential;
  state.tokenExpMs = decodeJwtExp(response.credential);
  state.cacheEmail = decodeJwtEmail(response.credential);
  PERF.mark('A 起動→一覧', 'credential');
  afterLogin();
}

/** ID トークンのメールアドレス（キャッシュの持ち主の照合用。検証はしない。認可は GAS が行う） */
function decodeJwtEmail(jwt) {
  try {
    var part = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return String(JSON.parse(decodeURIComponent(escape(atob(part)))).email || '').toLowerCase();
  } catch (e) {
    return '';
  }
}

function decodeJwtExp(jwt) {
  try {
    var part = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    var payload = JSON.parse(decodeURIComponent(escape(atob(part))));
    return Number(payload.exp) * 1000;
  } catch (e) {
    return 0;
  }
}

/* ---------- 端末内キャッシュ（docs/cache.js。PERF.md 項目 4） ---------- */

/** キャッシュの持ち主として照合するメール。ログイン確認前は ID トークンのもの */
function cacheOwner() {
  return state.user && state.user.email ? state.user.email : state.cacheEmail;
}

/** 要補充のほかに絞り込みが無いか */
function filtersOnlyRestock() {
  var f = state.filters;
  return !f.keyword && !f.category && !f.location && !f.stock_status;
}

function filtersEmpty() {
  var f = state.filters;
  return !f.keyword && !f.category && !f.location && !f.stock_status && !f.restock;
}

/** 絞り込みなしの一覧を取得したときだけ、キャッシュの一覧を差し替える */
function rememberList(items) {
  if (!state.user || !filtersEmpty()) return;
  ItemCache.saveList(CFG.GAS_API_URL, state.user.email, items, {
    categories: state.meta.categories,
    locations: state.meta.locations,
    stockStatuses: state.meta.stockStatuses
  });
}

function rememberDetail(item, logs) {
  ItemCache.saveDetail(CFG.GAS_API_URL, cacheOwner(), item, logs);
}

function applyMeta(meta) {
  if (!meta) return;
  state.meta.categories = meta.categories || [];
  state.meta.locations = meta.locations || [];
  state.meta.stockStatuses = meta.stockStatuses || state.meta.stockStatuses;
}

/** ログイン確認の応答を待たずに、前回のデータで画面を出す */
function showFromCache(cached) {
  state.user = { email: cached.email, name: '', picture: '' };
  applyMeta(cached.meta);
  renderUserChip();
  hide($('#view-login'));
  show($('#app'));
  rebuildFilterOptions();
  if (state.pendingItemId) {
    var id = state.pendingItemId;
    state.pendingItemId = null;
    openDetail(id);
    return;
  }
  goto('list', { itemsLoaded: true });
  showItems(cached.items || []);
}

function afterLogin() {
  // 前のユーザーのキャッシュは、ログイン確認の成否を待たずにこの時点で消す
  ItemCache.discardIfNotOwner(CFG.GAS_API_URL, state.cacheEmail);
  var cached = ItemCache.load(CFG.GAS_API_URL, state.cacheEmail);
  if (cached) {
    PERF.mark('A 起動→一覧', 'cache');
    state.fresh.list = { status: 'checking', confirmedAt: cached.confirmedAt, listKey: JSON.stringify(state.filters) };
    showFromCache(cached);
    renderSync();
  } else {
    loading(true, 'サインイン中…');
  }
  // 一覧も同時に受け取り、起動時の API 呼び出しを 1 回で済ませる（PERF.md 3.3 #2）
  var seq = state.writeSeq;
  api('loginCheck', { withItems: true, filters: state.filters })
    .then(function (data) {
      PERF.mark('A 起動→一覧', 'loginCheck');
      if (cached && cached.email !== String(data.user.email).toLowerCase()) {
        // 認証省略時など、照合できないまま別ユーザーのデータを出していた場合
        ItemCache.clear();
        cached = null;
        state.items = [];
        renderList();
      }
      state.user = data.user;
      applyMeta(data);
      renderUserChip();
      hide($('#view-login'));
      show($('#app'));
      rebuildFilterOptions();
      // 取得の間に手元で更新していたら、この一覧は更新前の内容なので使わない
      var fresh = state.writeSeq === seq;
      if (data.items && fresh) rememberList(data.items);
      if (data.items) setListFresh({ status: 'fresh', confirmedAt: Date.now(), listKey: JSON.stringify(state.filters) });

      if (cached) {
        // 画面は出ているので、最新の一覧に差し替えるだけ（一覧を見ているときのみ）
        if (data.items && fresh && state.view === 'list') showItems(applyRestockFilter(data.items));
        else if (!data.items && state.view === 'list') loadItems({ background: true });
        return;
      }
      if (state.pendingItemId) {
        var id = state.pendingItemId;
        state.pendingItemId = null;
        return openDetail(id);
      }
      // 一覧を返さない古い GAS なら従来どおり getItems で取る
      if (!data.items) return goto('list');
      goto('list', { itemsLoaded: true });
      showItems(applyRestockFilter(data.items));
    })
    .catch(function (err) {
      if (err.status === 403) {
        ItemCache.clear();
        showLogin(err.message + '\n管理者にグループへの追加を依頼してください。');
      } else if (err.status !== 401) {
        if (cached) {
          // 前回のデータは出ているので、画面は残して知らせるだけにする（一覧の上にも、いつの情報かを出す）
          setListFresh({ status: failureStatus(err) });
          toast(err.message || '最新のデータを取得できませんでした', 'error');
          return;
        }
        showLogin(err.message || 'ログイン処理に失敗しました。');
      }
    })
    .then(function () { if (!cached) loading(false); }, function () { if (!cached) loading(false); });
}

function showLogin(message) {
  hide($('#app'));
  show($('#view-login'));
  var box = $('#login-error');
  if (message) {
    box.textContent = message;
    show(box);
  } else {
    hide(box);
  }
  stopScanner();
}

function logout() {
  startSession();
  try { google.accounts.id.disableAutoSelect(); } catch (e) {}
  var wasGuest = state.guest;
  state.idToken = null;
  state.user = null;
  state.cacheEmail = null;
  state.items = [];
  ItemCache.clear();
  closeUserSheet();
  if (wasGuest) leaveGuest();
  showLogin('ログアウトしました。');
}

function renderUserChip() {
  var u = state.user || {};
  var img = $('#user-avatar');
  var ini = $('#user-initial');
  if (u.picture) {
    img.src = u.picture;
    show(img); hide(ini);
  } else {
    ini.textContent = (u.name || u.email || '?').charAt(0).toUpperCase();
    hide(img); show(ini);
  }
  $('#sheet-name').textContent = u.name || '';
  $('#sheet-email').textContent = u.email || '';
}
