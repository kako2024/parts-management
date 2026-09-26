/**
 * app.js — 備品管理 SPA
 * ------------------------------------------------------------------
 * 画面遷移・API 通信・Google ログインをすべてここで扱う。
 * 依存: config.js / Tailwind CDN / Google Identity Services / html5-qrcode
 * ------------------------------------------------------------------
 */
(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};
  var noop = function () {};
  var PERF = window.PERF || { enabled: false, begin: noop, mark: noop, end: noop, api: noop, watchImages: noop, bypassToken: noop };

  /* ================================================================
   * 状態
   * ==============================================================*/
  var state = {
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
    photoDraft: null,     // { data, mimeType, filename, previewUrl }
    formOp: null,         // 結果を確認できなかった保存の操作。フォームから送り直すときに同じ操作 ID を使う
    photoRetry: null,     // 登録で保存できなかった写真 { itemId, photo, op }。詳細の「写真だけ送り直す」で使う
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

    return fetch(CFG.GAS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: body,
      redirect: 'follow'
    }).then(function (res) {
      return res.text().then(function (text) {
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
      });
    }, function () {
      if (stale()) return never();
      throw {
        code: 'NETWORK_ERROR',
        message: 'サーバーに接続できませんでした。通信環境と GAS_API_URL の設定を確認してください。'
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
    state.idToken = null;
    state.user = null;
    showLogin(message || 'ログインの有効期限が切れました。もう一度ログインしてください。');
  }

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
    state.idToken = null;
    state.user = null;
    state.cacheEmail = null;
    state.items = [];
    ItemCache.clear();
    closeUserSheet();
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

  /* ================================================================
   * 一覧
   * ==============================================================*/

  var listRenderedOnce = false;

  /** 取得した一覧を state に入れて描画する */
  function showItems(items) {
    // 前回のデータで出した一覧と同じなら描き直さない（写真の読み込みをやり直させないため）
    var same = listRenderedOnce && JSON.stringify(items) === JSON.stringify(state.items);
    state.items = items;
    if (!same) renderList();
    if (!listRenderedOnce) {
      listRenderedOnce = true;
      whenIdle(function () {
        PERF.end('A 起動→一覧');
        PERF.watchImages('D 一覧写真', $('#item-list'));
      });
    }
  }

  /** @param {{background: boolean}=} opts background なら「読み込み中」の覆いを出さない */
  function loadItems(opts) {
    var background = !!(opts && opts.background);
    var filters = JSON.stringify(state.filters);
    var seq = state.writeSeq;
    if (!background) loading(true, '備品を読み込み中…');
    setListFresh({ status: 'checking' });
    return api('getItems', state.filters)
      .then(function (data) {
        PERF.mark('A 起動→一覧', 'getItems');
        if (filters !== JSON.stringify(state.filters)) return; // 取得中に絞り込みが変わった
        if (seq !== state.writeSeq) {                          // 取得中に手元で更新した（この一覧は更新前）
          setListFresh({ status: 'none' });
          return;
        }
        state.fresh.list = { status: 'fresh', confirmedAt: Date.now(), listKey: filters };
        showItems(applyRestockFilter(data.items || []));
        rememberList(data.items || []);
        renderSync();
      })
      .catch(function (err) {
        if (filters !== JSON.stringify(state.filters)) return;
        // 表示中の一覧が今の絞り込みの結果でなければ、それを見せ続けない（絞り込んだ結果と取り違えるため）
        if (state.fresh.list.listKey !== filters) {
          state.items = [];
          state.fresh.list = { status: failureStatus(err), confirmedAt: null, listKey: null };
          renderList();
        }
        setListFresh({ status: failureStatus(err) });
        toast(err.message || '取得に失敗しました', 'error');
      })
      .then(function () { if (!background) loading(false); }, function () { if (!background) loading(false); });
  }

  /* ---------- 写真の大きさ（PERF.md 項目 7） ----------
   * Drive の写真（https://lh3.googleusercontent.com/d/＜ID＞）は、末尾に「=w128-h128-c」などを付けると
   * その大きさに縮めた画像が返る。表示する大きさに合わせて取り、転送量を減らす。
   * それ以外の URL（選んだばかりの写真の data URL など）はそのまま使う。
   *
   * 写真の img には referrerpolicy="no-referrer"（PHOTO_REFERRER）を付ける。lh3 は Referer 付きの要求が
   * 同時に重なると 429 を HTML で返し、ブラウザはそれを ORB で遮る（PERF.md 2.4）。Referer が無ければ 429 にならない。
   */
  var PHOTO_REFERRER = ' referrerpolicy="no-referrer"';
  var DRIVE_PHOTO_RE = /^https:\/\/lh3\.googleusercontent\.com\/d\/[^=\/?#]+$/;

  function devicePixelScale() {
    return Math.min(3, Math.max(1, Math.round(window.devicePixelRatio || 1)));
  }

  /** 一覧のサムネイル（64px 角）用。画面の画素密度に合わせた正方形に切り抜いて取る */
  function thumbUrl(url) {
    if (!DRIVE_PHOTO_RE.test(url)) return url;
    var px = 64 * devicePixelScale();
    return url + '=w' + px + '-h' + px + '-c';
  }

  /** 詳細（画面幅いっぱい）用。画面の幅に合わせて取る（100px 刻み、元の大きさ 1280px まで） */
  function detailPhotoUrl(url) {
    if (!DRIVE_PHOTO_RE.test(url)) return url;
    var w = Math.min(1280, Math.ceil(window.innerWidth * devicePixelScale() / 100) * 100);
    return url + '=w' + w;
  }

  function renderList() {
    var box = $('#item-list');
    hide($('#btn-photo-reload-list')); // 描き直すと写真は取り直される
    $('#list-count').textContent = (state.filters.restock ? '要補充 ' : '') + state.items.length + ' 件';

    if (!state.items.length) {
      // 取得できなかったのに「該当なし」と見せない（PLAN-2 項目 3）
      var f = state.fresh.list;
      var failed = (f.status === 'offline' || f.status === 'error') && f.listKey !== JSON.stringify(state.filters);
      $('#list-count').textContent = failed ? '' : (state.filters.restock ? '要補充 ' : '') + '0 件';
      box.innerHTML = failed
        ? '<div id="list-failed" class="text-center py-16 text-rose-600">' +
          '  <div class="text-5xl mb-3">📡</div>' +
          '  <p class="text-sm">' + (f.status === 'offline' ? '通信できないため、' : '') + '一覧を取得できませんでした</p>' +
          '  <p class="text-xs text-slate-500 mt-1">通信できる場所で「再試行」を押してください</p>' +
          '</div>'
        : '<div id="list-empty" class="text-center py-16 text-slate-400">' +
          '  <div class="text-5xl mb-3">' + (state.filters.restock && filtersOnlyRestock() ? '✅' : '🔍') + '</div>' +
          '  <p class="text-sm">' + (state.filters.restock && filtersOnlyRestock() ? '補充が必要な備品はありません' : '該当する備品がありません') + '</p>' +
          '</div>';
      return;
    }

    box.innerHTML = state.items.map(function (it) {
      var thumb = it.photo_url
        ? '<img src="' + esc(thumbUrl(it.photo_url)) + '" alt="" loading="lazy" decoding="async" width="64" height="64" data-thumb="1"' + PHOTO_REFERRER + ' ' +
          'class="w-16 h-16 rounded-xl object-cover bg-slate-200 shrink-0">'
        : '<div class="w-16 h-16 rounded-xl bg-slate-200 shrink-0 flex items-center justify-center text-2xl">📦</div>';

      var qty = (it.quantity === null || it.quantity === '') ? '' :
        '<span class="text-xs text-slate-500">残 ' + esc(it.quantity) + '</span>';

      return '' +
        '<button class="w-full text-left bg-white rounded-2xl p-3 shadow-sm active:bg-slate-50 flex gap-3 items-center" ' +
        '        data-item-id="' + esc(it.item_id) + '">' +
        thumb +
        '  <div class="flex-1 min-w-0">' +
        '    <div class="flex items-center gap-2">' +
        '      <span class="badge ' + statusClass(it.stock_status) + '">' + esc(it.stock_status || '未設定') + '</span>' +
             qty +
        '    </div>' +
        '    <p class="mt-1 font-semibold text-[15px] truncate">' + esc(it.name) + '</p>' +
        '    <p class="text-xs text-slate-500 truncate">' + esc(it.item_id) +
             (it.location ? ' ・ ' + esc(it.location) : '') + '</p>' +
        '  </div>' +
        '  <svg class="w-5 h-5 text-slate-300 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">' +
        '    <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>' +
        '</button>';
    }).join('');
  }

  /** 「要補充」で出す在庫ステータス（PLAN-2 項目 5。GAS の CONST.RESTOCK_STATUSES と同じ） */
  var RESTOCK_STATUSES = ['残りわずか', '在庫なし'];

  /** 要補充で絞り込んでいれば、その在庫ステータスだけにする（要補充に対応していない古い GAS の応答にも備える） */
  function applyRestockFilter(items) {
    if (!state.filters.restock) return items;
    return items.filter(function (it) { return RESTOCK_STATUSES.indexOf(it.stock_status) !== -1; });
  }

  function rebuildFilterOptions() {
    $('#btn-restock').classList.toggle('active', !!state.filters.restock);
    $('#btn-restock').setAttribute('aria-pressed', state.filters.restock ? 'true' : 'false');
    fillSelect($('#filter-status'), '在庫: すべて', state.meta.stockStatuses, state.filters.stock_status);
    fillSelect($('#filter-category'), 'カテゴリ: すべて', state.meta.categories, state.filters.category);
    fillSelect($('#filter-location'), '場所: すべて', state.meta.locations, state.filters.location);
  }

  function fillSelect(sel, placeholder, values, current) {
    sel.innerHTML = '<option value="">' + esc(placeholder) + '</option>' +
      (values || []).map(function (v) {
        return '<option value="' + esc(v) + '"' + (v === current ? ' selected' : '') + '>' + esc(v) + '</option>';
      }).join('');
    sel.classList.toggle('active', !!current);
  }

  /* ================================================================
   * 詳細
   * ==============================================================*/

  /** 詳細画面の表示で終わる計測（開始は各操作の側で行う） */
  var DETAIL_SCENES = ['B 一覧→詳細', 'B QR→詳細', 'B ID入力→詳細', 'C 登録', 'C 編集'];

  /**
   * 詳細を開く。手元（キャッシュ・一覧）に備品があれば API を待たずに表示し、裏で最新を取って差し替える。
   */
  function openDetail(itemId) {
    var hit = findLocalItem(itemId);
    if (hit) {
      DETAIL_SCENES.forEach(function (k) { PERF.mark(k, 'cache'); });
      state.fresh.detail = { itemId: itemId, status: 'checking', confirmedAt: hit.confirmedAt || null };
      showDetail(hit.item, hit.logs);
      goto('detail');
      whenIdle(function () {
        DETAIL_SCENES.forEach(function (k) { PERF.end(k); });
        PERF.watchImages('D 詳細写真', $('#view-detail'));
      });
      refreshDetail(itemId);
      return Promise.resolve();
    }

    loading(true, '読み込み中…');
    return api('getItem', { item_id: itemId, withLogs: true })
      .then(function (data) {
        DETAIL_SCENES.forEach(function (k) { PERF.mark(k, 'getItem'); });
        state.fresh.detail = { itemId: data.item.item_id, status: 'fresh', confirmedAt: Date.now() };
        showDetail(data.item, data.logs || []);
        rememberDetail(data.item, data.logs || []);
        return goto('detail');
      })
      .then(function () {
        whenIdle(function () {
          DETAIL_SCENES.forEach(function (k) { PERF.end(k); });
          PERF.watchImages('D 詳細写真', $('#view-detail'));
        });
      })
      .catch(function (err) {
        if (err.code === 'ITEM_NOT_FOUND') {
          toast('備品 ' + itemId + ' は未登録です', 'error');
          if (confirmRegister(itemId)) return;
        } else {
          toast(err.message || '取得に失敗しました', 'error');
        }
      })
      .then(function () { loading(false); }, function () { loading(false); });
  }

  /** 手元にある備品（と履歴）。キャッシュ → 表示中の一覧の順に探す */
  function findLocalItem(itemId) {
    var hit = ItemCache.findItem(CFG.GAS_API_URL, cacheOwner(), itemId);
    if (hit) return hit;
    var it = state.items.filter(function (x) { return x.item_id === itemId; })[0];
    return it ? { item: it, logs: null, confirmedAt: state.fresh.list.confirmedAt } : null;
  }

  /** 表示中の詳細を裏で最新に差し替える。別の画面・別の備品に移っていたら画面は触らない */
  /**
   * 詳細を描き、表示中の備品として覚える。詳細の描画はすべてここを通す。
   * @param {{pending: boolean}=} opts pending なら保存中の表示にし、操作ボタンを押せなくする
   * @return {number} この描画の番号（stillShowing に渡す）
   */
  function showDetail(item, logs, opts) {
    state.detailRev++;
    state.currentItem = item;
    state.currentLogs = logs;
    renderDetail(item, logs, opts);
    renderSync();
    return state.detailRev;
  }

  /** rev の描画のあと、別の描画や別の画面に移っていないか */
  function stillShowing(rev) {
    return state.view === 'detail' && state.detailRev === rev;
  }

  /** 表示中の詳細を裏で最新に差し替える。別の画面・別の描画に移っていたら画面は触らない */
  function refreshDetail(itemId) {
    var rev = state.detailRev;
    var itemRev = state.itemRev[itemId];
    setDetailFresh(itemId, { status: 'checking' });
    api('getItem', { item_id: itemId, withLogs: true })
      .then(function (data) {
        // 取得の間にこの備品を手元で更新していたら、この応答は更新前の内容なので画面にもキャッシュにも使わない
        if (state.itemRev[itemId] !== itemRev) {
          if (state.fresh.detail.itemId === itemId && state.fresh.detail.status === 'checking') setDetailFresh(itemId, { status: 'none' });
          return;
        }
        rememberDetail(data.item, data.logs || []);
        setDetailFresh(itemId, { status: 'fresh', confirmedAt: Date.now() });
        if (!stillShowing(rev)) return;
        // 手元の表示と同じなら描き直さない（写真の読み込みをやり直させないため）
        if (JSON.stringify([data.item, data.logs || []]) === JSON.stringify([state.currentItem, state.currentLogs])) return;
        showDetail(data.item, data.logs || []);
      })
      .catch(function (err) {
        if (err.code === 'ITEM_NOT_FOUND') {
          ItemCache.remove(CFG.GAS_API_URL, cacheOwner(), itemId);
          state.items = state.items.filter(function (x) { return x.item_id !== itemId; });
          renderList();
          if (stillShowing(rev)) {
            toast('備品 ' + itemId + ' は削除されたか、未登録です', 'error');
            goto('list', { replace: true });
          }
        } else {
          setDetailFresh(itemId, { status: failureStatus(err) });
          if (stillShowing(rev)) toast(err.message || '最新のデータを取得できませんでした', 'error');
        }
      });
  }

  function confirmRegister(itemId) {
    if (window.confirm('この ID は未登録です。\n新しい備品として登録しますか？\n\nID: ' + itemId)) {
      openForm(null, itemId);
      return true;
    }
    return false;
  }

  function renderDetail(item, logs, opts) {
    var pending = !!(opts && opts.pending);
    var dis = pending ? ' disabled' : '';
    var photo = item.photo_url
      ? '<img src="' + esc(detailPhotoUrl(item.photo_url)) + '" alt="' + esc(item.name) + '" decoding="async"' + PHOTO_REFERRER + ' ' +
        'class="w-full aspect-[4/3] object-cover bg-slate-200">'
      : '<div class="w-full aspect-[4/3] bg-slate-200 flex items-center justify-center text-6xl">📦</div>';

    var statusButtons = state.meta.stockStatuses.map(function (s) {
      var sel = (s === item.stock_status) ? statusSelectedClass(s) : '';
      return '<button class="status-btn ' + sel + '" data-set-status="' + esc(s) + '"' + dis + '>' + esc(s) + '</button>';
    }).join('');

    var rows = [
      ['備品ID', item.item_id],
      ['カテゴリ', item.category || '—'],
      ['保管場所', item.location || '—'],
      ['個数', (item.quantity === null || item.quantity === '') ? '—' : item.quantity],
      ['備考', item.note || '—'],
      ['最終更新', item.updated_at || '—'],
      ['更新者', item.updated_by || '—']
    ].map(function (r) {
      return '<div class="flex gap-3 py-2.5 border-b border-slate-100 last:border-0">' +
             '  <dt class="w-24 shrink-0 text-xs font-semibold text-slate-500 pt-0.5">' + esc(r[0]) + '</dt>' +
             '  <dd class="flex-1 text-sm break-words whitespace-pre-wrap">' + esc(r[1]) + '</dd>' +
             '</div>';
    }).join('');

    var logHtml = !logs
      ? '<li class="py-4 text-sm text-slate-400 text-center">履歴を読み込み中…</li>'
      : logs.length
      ? logs.slice(0, 10).map(function (l) {
          return '<li class="py-2.5 border-b border-slate-100 last:border-0">' +
                 '  <div class="flex items-baseline justify-between gap-2">' +
                 '    <span class="text-xs font-semibold text-slate-700">' + esc(actionLabel(l.action_type)) + '</span>' +
                 '    <span class="text-[11px] text-slate-400 shrink-0">' + esc(l.timestamp) + '</span>' +
                 '  </div>' +
                 '  <p class="text-xs text-slate-500 mt-0.5 break-all">' + esc(summarizeLog(l)) + '</p>' +
                 '  <p class="text-[11px] text-slate-400 break-all">' + esc(l.user_email) + '</p>' +
                 '</li>';
        }).join('')
      : '<li class="py-4 text-sm text-slate-400 text-center">履歴はまだありません</li>';

    $('#view-detail').innerHTML = '' +
      '<div id="sync-detail" class="flex items-center gap-2 px-4 py-2 text-xs bg-slate-100 border-b border-slate-200 empty:hidden"></div>' +
      '<div class="bg-white">' + photo + '</div>' +
      '<div class="p-4 space-y-4">' +
      '  <div>' +
      '    <span class="badge ' + statusClass(item.stock_status) + '">' + esc(item.stock_status || '未設定') + '</span>' +
           (pending ? '<span id="saving-indicator" class="ml-2 text-xs text-slate-500">保存中…</span>' : '') +
      '    <h2 class="mt-2 text-xl font-bold leading-snug">' + esc(item.name) + '</h2>' +
      '  </div>' +
           photoRetryPanel(item, dis) +

      '  <div class="bg-white rounded-2xl p-4 shadow-sm">' +
      '    <p class="text-xs font-semibold text-slate-500 mb-2.5">在庫ステータスを変更</p>' +
      '    <div class="grid grid-cols-3 gap-2">' + statusButtons + '</div>' +
      '  </div>' +

      '  <div class="bg-white rounded-2xl p-4 shadow-sm">' +
      '    <dl>' + rows + '</dl>' +
      '  </div>' +

      '  <div class="bg-white rounded-2xl p-4 shadow-sm">' +
      '    <p class="text-xs font-semibold text-slate-500 mb-1">更新履歴</p>' +
      '    <ul>' + logHtml + '</ul>' +
      '  </div>' +

      '  <div class="grid grid-cols-2 gap-2">' +
      '    <button id="btn-edit" class="h-12 rounded-xl bg-slate-900 text-white font-semibold active:bg-slate-700 disabled:opacity-50"' + dis + '>編集</button>' +
      '    <button id="btn-delete" class="h-12 rounded-xl bg-white border border-rose-300 text-rose-600 font-semibold active:bg-rose-50 disabled:opacity-50"' + dis + '>削除</button>' +
      '  </div>' +
      '</div>';
  }

  /**
   * 登録で保存できなかった写真があれば、写真だけを送り直すボタンを出す（PLAN-2 項目 1）。
   * その後に写真が付いていたら（他の人が付けたなど）出さない（上書きしないため）
   */
  function photoRetryPanel(item, dis) {
    var pr = state.photoRetry;
    if (!pr || pr.itemId !== item.item_id || item.photo_url) return '';
    return '' +
      '  <div id="photo-retry" class="bg-amber-50 border border-amber-200 rounded-2xl p-4 space-y-3">' +
      '    <p class="text-sm text-amber-900">写真を保存できませんでした。選んだ写真はこの画面に残っています。</p>' +
      '    <button id="btn-photo-retry" class="w-full h-11 rounded-xl bg-amber-600 text-white font-semibold active:bg-amber-700 disabled:opacity-50"' + dis + '>写真だけ送り直す</button>' +
      '  </div>';
  }

  /**
   * 保存できなかった写真だけを送る（ほかの項目は送らないので、その間の他の人の変更を上書きしない）。
   * 結果を確認できなかったときは、次に押したときも同じ操作 ID で送る（写真を二重に保存しない）。
   */
  function retryPhoto() {
    var pr = state.photoRetry;
    var item = state.currentItem;
    var logs = state.currentLogs;
    if (!pr || !item || pr.itemId !== item.item_id || item.photo_url || state.saving) return;
    var op = pr.op || newOp();
    pr.op = null;
    state.saving = true;
    noteLocalWrite(item.item_id);
    var rev = showDetail(item, logs, { pending: true });
    sendOp('updateItem', {
      item_id: item.item_id,
      photo: { data: pr.photo.data, mimeType: pr.photo.mimeType, filename: pr.photo.filename },
      base_version: item.version
    }, op)
      .then(function (data) {
        state.saving = false;
        if (state.photoRetry === pr) state.photoRetry = null;
        applySaved(data.item, data.log, logs, rev);
        toast('写真を保存しました', 'success');
      })
      .catch(function (err) {
        state.saving = false;
        if (err.code === 'CONFLICT') return showLatestAfterConflict(err, rev, '写真');
        if (err.unknown) pr.op = op;
        if (stillShowing(rev)) showDetail(item, logs);
        toast((err.unknown ? '写真を保存できたか確認できませんでした' : '写真を保存できませんでした') +
          '（' + (err.message || '通信エラー') + '）。もう一度「写真だけ送り直す」を押してください', 'error');
      });
  }

  function actionLabel(type) {
    var map = {
      CREATE: '新規登録',
      UPDATE_STATUS: '在庫ステータス更新',
      UPDATE: '情報更新',
      DELETE: '削除'
    };
    return map[type] || type;
  }

  function summarizeLog(l) {
    var b = parseMaybeJson(l.before_state);
    var a = parseMaybeJson(l.after_state);
    if (l.action_type === 'UPDATE_STATUS' && b && a) {
      return (b.stock_status || '—') + ' → ' + (a.stock_status || '—');
    }
    if (l.action_type === 'CREATE' && a) {
      return (a.name || '') + (a.stock_status ? '（' + a.stock_status + '）' : '');
    }
    if (l.action_type === 'UPDATE' && a && typeof a === 'object') {
      return Object.keys(a).map(function (k) { return fieldLabel(k); }).join(' / ') + ' を変更';
    }
    return l.after_state || '';
  }

  function parseMaybeJson(v) {
    if (!v) return null;
    try { return JSON.parse(v); } catch (e) { return v; }
  }

  function fieldLabel(key) {
    var map = {
      name: '備品名', category: 'カテゴリ', location: '保管場所',
      stock_status: '在庫', quantity: '個数', note: '備考',
      photo_url: '写真', is_deleted: '削除フラグ'
    };
    return map[key] || key;
  }

  /* ---------- 更新の即時反映（楽観的更新。PERF.md 項目 6） ----------
   * 押した直後に画面を変え、API の応答は裏で待つ。成功したら応答の備品と履歴で描き直して
   * 一覧・キャッシュにも反映する。失敗したら元の表示に戻して知らせる。
   */

  /** 一覧（表示中の state.items）の同じ備品を置き換える。新しい備品は絞り込みがないときだけ先頭に足す */
  function upsertListItem(item) {
    var found = false;
    state.items = state.items.map(function (x) {
      if (x.item_id !== item.item_id) return x;
      found = true;
      return item;
    });
    if (!found && filtersEmpty()) state.items = [item].concat(state.items);
    renderList();
  }

  /**
   * 保存に成功した備品を反映する。履歴は、応答の 1 件を手元の履歴の先頭に足す（取り直さない）。
   * @param {number} rev 楽観的に描いたときの番号。まだその表示のままなら描き直す
   */
  /** 手元で備品を更新した（楽観的表示・保存の反映）。これより前に始めた裏の取得の応答は捨てられる */
  function noteLocalWrite(itemId) {
    state.writeSeq++;
    state.itemRev[itemId] = (state.itemRev[itemId] || 0) + 1;
  }

  function applySaved(item, log, baseLogs, rev) {
    noteLocalWrite(item.item_id);
    // 保存の応答はサーバーの内容なので、この備品は今確かめたことになる
    state.fresh.detail = { itemId: item.item_id, status: 'fresh', confirmedAt: Date.now() };
    var logs = baseLogs ? (log ? [log].concat(baseLogs) : baseLogs) : null;
    rememberDetail(item, logs);
    upsertListItem(item);
    if (stillShowing(rev)) {
      showDetail(item, logs);
      if (!logs) refreshDetail(item.item_id); // 履歴をまだ持っていなければ取りに行く
    }
  }

  /**
   * 保存が競合で止められた（PLAN-2 項目 2。他の人が先に更新していた）。サーバーが返した最新の備品を
   * 一覧・キャッシュ・表示中の詳細に反映して知らせる。何も保存されていない。
   */
  function showLatestAfterConflict(err, rev, what) {
    var latest = err.data && err.data.item;
    if (latest) {
      applySaved(latest, null, null, rev); // 表示中なら最新を出し、履歴を取り直す
    } else if (stillShowing(rev)) {
      refreshDetail(state.currentItem.item_id);
    }
    toast('他の人が先にこの備品を更新していたため、' + what + 'を保存しませんでした。最新の内容を表示したので、確かめてからもう一度操作してください', 'error');
  }

  function updateStatus(newStatus) {
    var prev = state.currentItem;
    var prevLogs = state.currentLogs;
    if (!prev || prev.stock_status === newStatus || state.saving) return;

    PERF.begin('C ステータス更新');
    PERF.begin('C ステータス確定');
    state.saving = true;
    noteLocalWrite(prev.item_id);
    var rev = showDetail(Object.assign({}, prev, { stock_status: newStatus }), prevLogs, { pending: true });
    whenIdle(function () { PERF.end('C ステータス更新'); });

    sendOp('updateStatus', { item_id: prev.item_id, stock_status: newStatus, base_version: prev.version }, newOp())
      .then(function (data) {
        state.saving = false;
        applySaved(data.item, data.log, prevLogs, rev);
        PERF.end('C ステータス確定');
        toast('「' + newStatus + '」に更新しました', 'success');
      })
      .catch(function (err) {
        state.saving = false;
        if (err.code === 'CONFLICT') return showLatestAfterConflict(err, rev, '在庫ステータス');
        if (stillShowing(rev)) showDetail(prev, prevLogs);
        if (err.unknown) {
          // 保存されたかもしれないので、元に戻したままにせずサーバーの状態を読み直す
          noteLocalWrite(prev.item_id);
          refreshDetail(prev.item_id);
          toast('更新できたか確認できませんでした（' + (err.message || '通信エラー') + '）。サーバーの状態を読み直します', 'error');
          return;
        }
        toast('更新できなかったため、元の表示に戻しました（' + (err.message || '通信エラー') + '）', 'error');
      });
  }

  function deleteItem() {
    var item = state.currentItem;
    if (!item) return;
    if (!window.confirm('「' + item.name + '」を削除します。\n（データは残り、一覧から非表示になります）')) return;

    loading(true, '削除中…');
    var rev = state.detailRev;
    sendOp('deleteItem', { item_id: item.item_id, base_version: item.version }, newOp())
      .then(function () {
        noteLocalWrite(item.item_id);
        ItemCache.remove(CFG.GAS_API_URL, cacheOwner(), item.item_id);
        state.items = state.items.filter(function (x) { return x.item_id !== item.item_id; });
        renderList();
        toast('削除しました', 'success');
        return goto('list', { replace: true });
      })
      .catch(function (err) {
        if (err.code === 'CONFLICT') return showLatestAfterConflict(err, rev, '削除');
        if (err.unknown) {
          toast('削除できたか確認できませんでした（' + (err.message || '通信エラー') + '）。もう一度「削除」を押すと確かめられます', 'error');
          return;
        }
        toast(err.message || '削除に失敗しました', 'error');
      })
      .then(function () { loading(false); }, function () { loading(false); });
  }

  /* ================================================================
   * 登録 / 編集フォーム
   * ==============================================================*/

  /**
   * @param {Object|null} item     編集対象。null なら新規
   * @param {string=} presetItemId 新規時に ID を固定したい場合（QR 先行発行など）
   */
  /**
   * @param {Object=} draft 保存に失敗したときに入力を戻すための値 { values: {...}, photo: photoDraft|null, op? }
   *   op があれば、次の保存はその操作の送り直しになる（結果を確認できなかった保存。二重に保存しない）
   * @param {{replace: boolean}=} nav replace なら画面の履歴を積まない
   */
  function openForm(item, presetItemId, draft, nav) {
    state.photoDraft = (draft && draft.photo) || null;
    state.formOp = (draft && draft.op) || null;
    state.formBase = item || null;
    var isEdit = !!item;
    var base = item || {
      item_id: presetItemId || '',
      name: '', category: '', location: '',
      stock_status: state.meta.stockStatuses[0],
      quantity: '', note: '', photo_url: ''
    };
    var v = draft ? Object.assign({}, base, draft.values) : base;
    var photoUrl = state.photoDraft ? state.photoDraft.previewUrl : v.photo_url;

    var statusOptions = state.meta.stockStatuses.map(function (s) {
      return '<option value="' + esc(s) + '"' + (s === v.stock_status ? ' selected' : '') + '>' + esc(s) + '</option>';
    }).join('');

    var datalist = function (id, values) {
      return '<datalist id="' + id + '">' +
        (values || []).map(function (x) { return '<option value="' + esc(x) + '"></option>'; }).join('') +
        '</datalist>';
    };

    var idField = isEdit
      ? '<div><span class="field-label">備品ID</span>' +
        '<p class="text-sm font-mono bg-slate-100 rounded-lg px-3 py-2.5">' + esc(v.item_id) + '</p></div>'
      : '<div><label class="field-label" for="f-item-id">備品ID（空欄なら自動採番）</label>' +
        '<input id="f-item-id" class="field-input" type="text" autocapitalize="characters" ' +
        'placeholder="ITEM-0001" value="' + esc(v.item_id) + '"></div>';

    var currentPhoto = photoUrl
      ? '<img id="photo-preview" src="' + esc(photoUrl) + '" alt=""' + PHOTO_REFERRER + ' class="w-full aspect-[4/3] object-cover rounded-xl bg-slate-200">'
      : '<div id="photo-preview-empty" class="w-full aspect-[4/3] rounded-xl bg-slate-100 border-2 border-dashed border-slate-300 flex flex-col items-center justify-center gap-1 text-slate-400">' +
        '<span class="text-4xl">📷</span><span class="text-xs">写真なし</span></div>';

    $('#view-form').innerHTML = '' +
      '<form id="item-form" class="space-y-4" novalidate>' +
           conflictNotice(draft && draft.conflict) +
      '  <div class="bg-white rounded-2xl p-4 shadow-sm space-y-3">' +
      '    <span class="field-label">写真</span>' +
      '    <div id="photo-slot">' + currentPhoto + '</div>' +
      '    <input id="f-photo" type="file" accept="image/*" capture="environment" class="hidden">' +
      '    <div class="grid grid-cols-2 gap-2">' +
      '      <button type="button" id="btn-photo-pick" class="h-11 rounded-xl bg-slate-100 font-semibold text-sm active:bg-slate-200">写真を選ぶ / 撮影</button>' +
      '      <button type="button" id="btn-photo-clear" class="h-11 rounded-xl bg-white border border-slate-300 text-slate-600 font-semibold text-sm active:bg-slate-50">選択を取消</button>' +
      '    </div>' +
      '  </div>' +

      '  <div class="bg-white rounded-2xl p-4 shadow-sm space-y-4">' +
           idField +
      '    <div><label class="field-label" for="f-name">備品名 <span class="text-rose-500">*</span></label>' +
      '      <input id="f-name" class="field-input" type="text" required value="' + esc(v.name) + '" placeholder="コピー用紙 A4"></div>' +
      '    <div><label class="field-label" for="f-category">カテゴリ</label>' +
      '      <input id="f-category" class="field-input" type="text" list="dl-category" value="' + esc(v.category) + '" placeholder="事務用品">' +
             datalist('dl-category', state.meta.categories) + '</div>' +
      '    <div><label class="field-label" for="f-location">保管場所</label>' +
      '      <input id="f-location" class="field-input" type="text" list="dl-location" value="' + esc(v.location) + '" placeholder="本館-3F-A棚-2段">' +
             datalist('dl-location', state.meta.locations) + '</div>' +
      '    <div class="grid grid-cols-2 gap-3">' +
      '      <div><label class="field-label" for="f-status">在庫ステータス</label>' +
      '        <select id="f-status" class="field-input">' + statusOptions + '</select></div>' +
      '      <div><label class="field-label" for="f-quantity">個数</label>' +
      '        <input id="f-quantity" class="field-input" type="number" inputmode="numeric" min="0" value="' + esc(v.quantity) + '"></div>' +
      '    </div>' +
      '    <div><label class="field-label" for="f-note">備考</label>' +
      '      <textarea id="f-note" class="field-input" rows="3" placeholder="発注先・型番など">' + esc(v.note) + '</textarea></div>' +
      '  </div>' +

      '  <button type="submit" class="w-full h-14 rounded-2xl bg-slate-900 text-white font-bold text-base active:bg-slate-700">' +
           (isEdit ? '保存する' : '登録する') +
      '  </button>' +
      '</form>';

    $('#item-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      submitForm(isEdit, v.item_id);
    });
    $('#btn-photo-pick').addEventListener('click', function () { $('#f-photo').click(); });
    $('#btn-photo-clear').addEventListener('click', clearPhotoDraft);
    $('#f-photo').addEventListener('change', onPhotoSelected);

    return goto('form', { title: isEdit ? '備品を編集' : '備品を登録', replace: !!(nav && nav.replace) });
  }

  /** 編集で送る項目（変えた項目だけを送る。PLAN-2 項目 2） */
  var EDIT_FIELDS = ['name', 'category', 'location', 'stock_status', 'quantity', 'note'];

  /** フォームと備品の値を比べられる形にそろえる（個数は空欄と null を同じに扱う） */
  function fieldText(key, v) {
    if (v === null || v === undefined) return '';
    return String(v);
  }

  /** 競合で戻ったフォームの上に、他の人が変えた項目を出す */
  function conflictNotice(conflict) {
    if (!conflict || !conflict.length) return '';
    return '' +
      '<div id="conflict-notice" class="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-sm text-amber-900 space-y-1">' +
      '  <p class="font-semibold">他の人が先にこの備品を更新していました（まだ保存していません）</p>' +
      conflict.map(function (c) {
        return '<p>' + esc(fieldLabel(c.key)) + '：「' + esc(c.theirs) + '」に変わっていました' +
          (c.mine !== undefined ? '（あなたの入力「' + esc(c.mine) + '」を残しています）' : '（最新の値にしました）') + '</p>';
      }).join('') +
      '  <p>内容を確かめて、もう一度「保存する」を押してください。</p>' +
      '</div>';
  }

  /**
   * 編集の保存が競合で止められた。入力を残してフォームに戻る。自分が変えていない項目は最新の値にし
   * （他の人の変更を古い値で戻さない）、自分が変えた項目は入力のまま残す。次の保存は最新の版を基にする。
   */
  function onEditConflict(err, base, draft, rev) {
    var latest = err.data && err.data.item;
    if (!latest) {
      // 備品が見つからなかった（行が消えたなど）。最新を出せないので、入力と写真を残したフォームに戻る
      if (stillShowing(rev)) {
        showDetail(base, null);
        openForm(base, null, { values: draft.values, photo: draft.photo });
        refreshDetail(base.item_id); // 裏で取り直して一覧・キャッシュを最新にする（フォームはそのまま。消えていれば一覧から除く）
      }
      toast('この備品の最新の内容を確かめられなかったため、保存しませんでした。入力を残してフォームに戻りました', 'error');
      return;
    }
    var values = {};
    var conflict = [];
    EDIT_FIELDS.forEach(function (k) {
      var mine = fieldText(k, draft.values[k]);
      var changedByMe = mine !== fieldText(k, base[k]);
      var changedByOthers = fieldText(k, latest[k]) !== fieldText(k, base[k]);
      values[k] = changedByMe ? draft.values[k] : fieldText(k, latest[k]);
      if (changedByOthers) conflict.push({ key: k, theirs: fieldText(k, latest[k]), mine: changedByMe ? mine : undefined });
    });
    rememberDetail(latest, null);
    upsertListItem(latest);
    if (stillShowing(rev)) {
      showDetail(latest, null);
      openForm(latest, null, { values: values, photo: draft.photo, conflict: conflict });
    }
    toast('他の人が先にこの備品を更新していたため、保存しませんでした。入力を残してフォームに戻りました', 'error');
  }

  function submitForm(isEdit, itemId) {
    var name = $('#f-name').value.trim();
    if (!name) {
      toast('備品名を入力してください', 'error');
      $('#f-name').focus();
      return;
    }

    var payload = {
      name: name,
      category: $('#f-category').value.trim(),
      location: $('#f-location').value.trim(),
      stock_status: $('#f-status').value,
      quantity: $('#f-quantity').value === '' ? null : Number($('#f-quantity').value),
      note: $('#f-note').value.trim()
    };
    if (state.photoDraft) {
      payload.photo = {
        data: state.photoDraft.data,
        mimeType: state.photoDraft.mimeType,
        filename: state.photoDraft.filename
      };
    }

    var action;
    var base = isEdit ? state.formBase : null;
    var send = payload;
    if (isEdit) {
      action = 'updateItem';
      // 変えた項目と写真だけを、開いたときの版を添えて送る（他の人が変えた項目を古い値で戻さない）
      send = { item_id: itemId, base_version: base && base.version };
      EDIT_FIELDS.forEach(function (k) {
        if (!base || fieldText(k, payload[k]) !== fieldText(k, base[k])) send[k] = payload[k];
      });
      if (payload.photo) send.photo = payload.photo;
      if (Object.keys(send).length === 2) {
        toast('変更はありません', 'info');
        return;
      }
    } else {
      action = 'createItem';
      var manualId = $('#f-item-id') ? $('#f-item-id').value.trim() : '';
      if (manualId) payload.item_id = manualId;
    }

    // 保存に失敗したらフォームに戻すための入力（写真は選び直さなくて済むよう下書きごと持つ）
    var draft = {
      values: {
        name: payload.name, category: payload.category, location: payload.location,
        stock_status: payload.stock_status, quantity: $('#f-quantity').value, note: payload.note,
        item_id: isEdit ? itemId : (payload.item_id || '')
      },
      photo: state.photoDraft
    };
    state.photoDraft = null;
    var op = state.formOp || newOp();
    state.formOp = null;

    var perfKey = isEdit ? 'C 編集' : 'C 登録';
    PERF.begin(perfKey);
    PERF.begin(perfKey + '確定');

    // 保存を待たずに、入力どおりの詳細を出す（楽観的更新。PERF.md 項目 6）
    var prev = isEdit ? state.currentItem : null;
    var prevLogs = isEdit ? state.currentLogs : [];
    if (isEdit) noteLocalWrite(itemId);
    var optimistic = Object.assign({}, prev || { item_id: payload.item_id || '（採番中）', is_deleted: false }, {
      name: payload.name, category: payload.category, location: payload.location,
      stock_status: payload.stock_status, quantity: payload.quantity, note: payload.note,
      photo_url: draft.photo ? draft.photo.previewUrl : (prev ? prev.photo_url : ''),
      updated_at: '（保存中）', updated_by: state.user ? state.user.email : ''
    });
    state.saving = true;
    // 戻るでフォームに戻らないよう、フォームの 1 つ前が詳細ならその履歴も外して詳細へ移る
    if (state.stack[state.stack.length - 1] === 'detail') state.stack.pop();
    var rev = showDetail(optimistic, prevLogs, { pending: true });
    goto('detail', { replace: true });
    whenIdle(function () { PERF.end(perfKey); });

    sendOp(action, send, op)
      .then(function (data) {
        state.saving = false;
        var showing = stillShowing(rev); // applySaved が描き直す前に確かめる
        applySaved(data.item, data.log, prevLogs, rev);
        mergeMeta(payload.category, payload.location); // 新しいカテゴリ・場所を候補に反映
        PERF.end(perfKey + '確定');
        if (data.photoError) {
          onPhotoNotSaved(data.item, draft.photo, showing);
          return;
        }
        toast(isEdit ? '保存しました' : '登録しました（' + data.item.item_id + '）', 'success');
      })
      .catch(function (err) {
        state.saving = false;
        var msg = err.message || '通信エラー';
        if (err.code === 'OP_MISMATCH') return onOpMismatch(err, isEdit, draft, rev, prev, prevLogs);
        if (err.code === 'CONFLICT' && isEdit) return onEditConflict(err, base, draft, rev);
        // 結果を確認できなかったときは、次の保存を同じ操作の送り直しにする（二重に登録しない）
        if (err.unknown) draft.op = op;
        if (!stillShowing(rev)) {
          toast('「' + payload.name + '」を' + (err.unknown ? '保存できたか確認できませんでした' : '保存できませんでした') +
            '（' + msg + '）', 'error');
          return;
        }
        if (isEdit) {
          showDetail(prev, prevLogs);
          openForm(prev, null, draft);
        } else {
          openForm(null, null, draft, { replace: true });
        }
        toast(err.unknown
          ? '保存できたか確認できませんでした（' + msg + '）。もう一度「' + (isEdit ? '保存する' : '登録する') + '」を押すと、二重に保存せずに確かめます'
          : '保存できませんでした（' + msg + '）。入力内容を残してフォームに戻りました', 'error');
      });
  }

  /**
   * 備品は登録できたが写真を保存できなかった（PLAN-2 項目 1）。選んだ写真を手元に残し、詳細の
   * 「写真だけ送り直す」で写真だけを送れるようにする（備品は増えず、ほかの項目も送らない）。
   */
  function onPhotoNotSaved(item, photo, showing) {
    if (!photo) return;
    state.photoRetry = { itemId: item.item_id, photo: photo, op: null };
    if (showing && state.currentItem && state.currentItem.item_id === item.item_id) {
      showDetail(state.currentItem, state.currentLogs);
    }
    toast('「' + item.name + '」を登録しました（' + item.item_id + '）が、写真は保存できませんでした。' +
      '詳細の「写真だけ送り直す」で写真を送れます', 'error');
  }

  /**
   * 結果を確認できなかった保存を、内容を変えて送り直した。最初の保存はすでに済んでいた（サーバーは何もしていない）。
   * 登録なら、済んでいた備品を表示する（入力し直した内容で登録し直すと重複するため）。
   * 編集なら、フォームに戻る。次の保存は新しい操作として、いま入力している内容を保存する。
   */
  function onOpMismatch(err, isEdit, draft, rev, prev, prevLogs) {
    var saved = err.data && err.data.item;
    if (!isEdit && saved) {
      applySaved(saved, null, null, rev); // 表示中なら詳細をその備品にして、履歴を取りに行く
      toast('前回の登録は完了していました（' + saved.item_id + '）。入力し直した内容は反映していないので、必要なら編集してください', 'error');
      return;
    }
    draft.op = null;
    if (stillShowing(rev)) {
      if (isEdit) {
        showDetail(saved || prev, prevLogs);
        openForm(saved || prev, null, draft);
      } else {
        openForm(null, null, draft, { replace: true });
      }
    }
    toast('前回の保存は完了していました。いま入力している内容を保存するには、もう一度押してください', 'error');
  }

  function mergeMeta(category, location) {
    if (category && state.meta.categories.indexOf(category) === -1) {
      state.meta.categories.push(category);
      state.meta.categories.sort();
    }
    if (location && state.meta.locations.indexOf(location) === -1) {
      state.meta.locations.push(location);
      state.meta.locations.sort();
    }
    rebuildFilterOptions();
  }

  /* ---------- 写真 ---------- */

  function onPhotoSelected(ev) {
    var file = ev.target.files && ev.target.files[0];
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      toast('画像ファイルを選んでください', 'error');
      return;
    }
    loading(true, '画像を処理中…');
    compressImage(file, CFG.PHOTO_MAX_EDGE || 1280, CFG.PHOTO_QUALITY || 0.82)
      .then(function (result) {
        state.photoDraft = result;
        var slot = $('#photo-slot');
        slot.innerHTML = '<img src="' + result.previewUrl + '" alt="" class="w-full aspect-[4/3] object-cover rounded-xl bg-slate-200">';
        toast('写真を選択しました（保存時にアップロード）', 'info');
      })
      .catch(function () { toast('画像の読み込みに失敗しました', 'error'); })
      .then(function () { loading(false); }, function () { loading(false); });
  }

  function clearPhotoDraft() {
    state.photoDraft = null;
    $('#f-photo').value = '';
    $('#photo-slot').innerHTML =
      '<div class="w-full aspect-[4/3] rounded-xl bg-slate-100 border-2 border-dashed border-slate-300 ' +
      'flex flex-col items-center justify-center gap-1 text-slate-400">' +
      '<span class="text-4xl">📷</span><span class="text-xs">写真なし</span></div>';
  }

  /**
   * canvas で長辺 maxEdge に縮小し JPEG 化する。
   * スマホの原寸写真（3〜8MB）をそのまま送ると GAS 側で詰まるため必須。
   */
  function compressImage(file, maxEdge, quality) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        var scale = Math.min(1, maxEdge / Math.max(w, h));
        var cw = Math.round(w * scale), ch = Math.round(h * scale);

        var canvas = document.createElement('canvas');
        canvas.width = cw; canvas.height = ch;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, cw, ch);
        URL.revokeObjectURL(url);

        var dataUrl = canvas.toDataURL('image/jpeg', quality);
        resolve({
          data: dataUrl.split(',')[1],
          mimeType: 'image/jpeg',
          filename: (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg',
          previewUrl: dataUrl
        });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('image load error')); };
      img.src = url;
    });
  }

  /* ================================================================
   * QR スキャン
   * ==============================================================*/

  var SCANNER_LIB_URL = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
  var scannerLibPromise = null;

  /**
   * html5-qrcode をスキャン画面を開いたときに初めて読み込む（起動時の読み込みを減らすため。PERF.md 3.3 #6）。
   * 成否を真偽値で返す。失敗したら次に開いたときに再試行する。
   */
  function loadScannerLib() {
    if (window.Html5Qrcode) return Promise.resolve(true);
    if (!scannerLibPromise) {
      scannerLibPromise = new Promise(function (resolve) {
        var s = document.createElement('script');
        s.src = SCANNER_LIB_URL;
        // 読み込めなかった・中身が使えなかったときは、次に開いたときに読み込み直す
        var fail = function () { s.remove(); scannerLibPromise = null; resolve(false); };
        s.onload = function () { if (window.Html5Qrcode) resolve(true); else fail(); };
        s.onerror = fail;
        document.head.appendChild(s);
      });
    }
    return scannerLibPromise;
  }

  function startScanner() {
    if (state.scanning) return Promise.resolve();
    if (!window.Html5Qrcode) $('#scan-hint').textContent = 'スキャナを読み込んでいます…';
    return loadScannerLib().then(function (ok) {
      // 読み込みの間に画面を離れた・別の呼び出しで起動済みなら何もしない
      if (state.view !== 'scan' || state.scanning) return;
      if (!ok) {
        $('#scan-hint').textContent = 'スキャナの読み込みに失敗しました。下の入力欄から備品IDを直接開いてください。';
        return;
      }
      return startScannerNow();
    });
  }

  function startScannerNow() {
    if (!state.scanner) state.scanner = new Html5Qrcode('qr-reader', { verbose: false });
    state.scanning = true;
    $('#scan-hint').textContent = 'カメラを起動しています…';

    return state.scanner.start(
      { facingMode: 'environment' },
      {
        fps: 10,
        qrbox: function (vw, vh) {
          var edge = Math.floor(Math.min(vw, vh) * 0.72);
          return { width: edge, height: edge };
        },
        aspectRatio: 1.0
      },
      onScanSuccess,
      function () { /* フレームごとの読み取り失敗は無視 */ }
    ).then(function () {
      $('#scan-hint').textContent = '備品ラベルの QR コードを枠内に写してください。';
    }).catch(function (err) {
      state.scanning = false;
      $('#scan-hint').textContent =
        'カメラを起動できませんでした（' + (err && err.message ? err.message : err) + '）。' +
        'ブラウザのカメラ権限を許可するか、下の入力欄から備品IDを直接開いてください。';
    });
  }

  function stopScanner() {
    if (state.scanner && state.scanning) {
      state.scanning = false;
      try {
        state.scanner.stop().then(function () {
          try { state.scanner.clear(); } catch (e) {}
        }).catch(function () {});
      } catch (e) {}
    }
  }

  var lastScanAt = 0;
  function onScanSuccess(decodedText) {
    var now = Date.now();
    if (now - lastScanAt < 1500) return; // 連続読み取りの抑制
    lastScanAt = now;

    var itemId = extractItemId(decodedText);
    if (!itemId) {
      toast('備品IDを読み取れませんでした', 'error');
      return;
    }
    if (navigator.vibrate) navigator.vibrate(40);
    stopScanner();
    PERF.begin('B QR→詳細');
    openDetail(itemId);
  }

  /**
   * QR の内容から備品IDを取り出す。
   * 素の "ITEM-0001" でも、"https://.../?item=ITEM-0001" 形式でも通す。
   */
  function extractItemId(text) {
    var s = String(text || '').trim();
    if (!s) return '';
    var m = /[?&]item=([^&#\s]+)/i.exec(s);
    if (m) return decodeURIComponent(m[1]).trim();
    m = /\bITEM-\d+\b/i.exec(s);
    if (m) return m[0].toUpperCase();
    if (/^https?:\/\//i.test(s)) {
      var seg = s.split(/[?#]/)[0].split('/').filter(Boolean).pop();
      return seg ? decodeURIComponent(seg) : '';
    }
    return s;
  }

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
      box.id = 'photo-failed';
      box.className = 'w-full aspect-[4/3] bg-rose-50 flex flex-col items-center justify-center gap-2 text-rose-600';
      box.innerHTML = '<span class="text-4xl">⚠</span><p class="text-sm">写真を読み込めませんでした</p>' +
        '<button id="btn-photo-reload" class="h-10 px-4 rounded-xl bg-white border border-rose-300 text-sm font-semibold active:bg-rose-50">再読み込み</button>';
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
      if (ev.target.closest('#btn-photo-reload') && state.currentItem) {
        return showDetail(state.currentItem, state.currentLogs); // 描き直して写真を取り直す
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

  function boot() {
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
})();
