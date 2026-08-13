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

  /* ================================================================
   * 状態
   * ==============================================================*/
  var state = {
    idToken: null,        // メモリ内のみに保持する（localStorage には置かない）
    tokenExpMs: 0,
    user: null,
    meta: { categories: [], locations: [], stockStatuses: ['余裕あり', '残りわずか', '在庫なし'] },
    items: [],
    filters: { keyword: '', category: '', location: '', stock_status: '' },
    view: 'list',
    stack: [],            // 戻るボタン用の履歴
    currentItem: null,
    scanner: null,
    scanning: false,
    pendingItemId: null,  // ログイン前に ?item= で指定された備品
    photoDraft: null      // { data, mimeType, filename, previewUrl }
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
    var body = JSON.stringify({
      action: action,
      idToken: state.idToken,
      payload: payload || {}
    });

    return fetch(CFG.GAS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: body,
      redirect: 'follow'
    }).then(function (res) {
      return res.text().then(function (text) {
        var json;
        try {
          json = JSON.parse(text);
        } catch (e) {
          throw {
            code: 'BAD_RESPONSE',
            message: 'サーバーの応答を解析できませんでした。GAS のデプロイ設定（アクセスできるユーザー = 全員）を確認してください。'
          };
        }
        if (!json.ok) {
          var err = json.error || { code: 'UNKNOWN', message: '不明なエラー' };
          if (err.status === 401) handleAuthExpired(err.message);
          throw err;
        }
        return json.data;
      });
    }, function () {
      throw {
        code: 'NETWORK_ERROR',
        message: 'サーバーに接続できませんでした。通信環境と GAS_API_URL の設定を確認してください。'
      };
    });
  }

  function handleAuthExpired(message) {
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
    state.idToken = response.credential;
    state.tokenExpMs = decodeJwtExp(response.credential);
    afterLogin();
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

  function afterLogin() {
    loading(true, 'サインイン中…');
    api('loginCheck')
      .then(function (data) {
        state.user = data.user;
        state.meta.categories = data.categories || [];
        state.meta.locations = data.locations || [];
        state.meta.stockStatuses = data.stockStatuses || state.meta.stockStatuses;
        renderUserChip();
        hide($('#view-login'));
        show($('#app'));
        rebuildFilterOptions();

        if (state.pendingItemId) {
          var id = state.pendingItemId;
          state.pendingItemId = null;
          return openDetail(id);
        }
        return goto('list');
      })
      .catch(function (err) {
        if (err.status === 403) {
          showLogin(err.message + '\n管理者にグループへの追加を依頼してください。');
        } else if (err.status !== 401) {
          showLogin(err.message || 'ログイン処理に失敗しました。');
        }
      })
      .then(function () { loading(false); }, function () { loading(false); });
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
    try { google.accounts.id.disableAutoSelect(); } catch (e) {}
    state.idToken = null;
    state.user = null;
    state.items = [];
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

    if (view === 'list') return loadItems();
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

  function loadItems() {
    loading(true, '備品を読み込み中…');
    return api('getItems', state.filters)
      .then(function (data) {
        state.items = data.items || [];
        renderList();
      })
      .catch(function (err) { toast(err.message || '取得に失敗しました', 'error'); })
      .then(function () { loading(false); }, function () { loading(false); });
  }

  function renderList() {
    var box = $('#item-list');
    $('#list-count').textContent = state.items.length + ' 件';

    if (!state.items.length) {
      box.innerHTML =
        '<div class="text-center py-16 text-slate-400">' +
        '  <div class="text-5xl mb-3">🔍</div>' +
        '  <p class="text-sm">該当する備品がありません</p>' +
        '</div>';
      return;
    }

    box.innerHTML = state.items.map(function (it) {
      var thumb = it.photo_url
        ? '<img src="' + esc(it.photo_url) + '" alt="" loading="lazy" ' +
          'class="w-16 h-16 rounded-xl object-cover bg-slate-200 shrink-0" ' +
          'onerror="this.replaceWith(Object.assign(document.createElement(\'div\'),{className:\'w-16 h-16 rounded-xl bg-slate-200 shrink-0\'}))">'
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

  function rebuildFilterOptions() {
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

  function openDetail(itemId) {
    loading(true, '読み込み中…');
    return api('getItem', { item_id: itemId, withLogs: true })
      .then(function (data) {
        state.currentItem = data.item;
        renderDetail(data.item, data.logs || []);
        return goto('detail');
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

  function confirmRegister(itemId) {
    if (window.confirm('この ID は未登録です。\n新しい備品として登録しますか？\n\nID: ' + itemId)) {
      openForm(null, itemId);
      return true;
    }
    return false;
  }

  function renderDetail(item, logs) {
    var photo = item.photo_url
      ? '<img src="' + esc(item.photo_url) + '" alt="' + esc(item.name) + '" ' +
        'class="w-full aspect-[4/3] object-cover bg-slate-200">'
      : '<div class="w-full aspect-[4/3] bg-slate-200 flex items-center justify-center text-6xl">📦</div>';

    var statusButtons = state.meta.stockStatuses.map(function (s) {
      var sel = (s === item.stock_status) ? statusSelectedClass(s) : '';
      return '<button class="status-btn ' + sel + '" data-set-status="' + esc(s) + '">' + esc(s) + '</button>';
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

    var logHtml = logs.length
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
      '<div class="bg-white">' + photo + '</div>' +
      '<div class="p-4 space-y-4">' +
      '  <div>' +
      '    <span class="badge ' + statusClass(item.stock_status) + '">' + esc(item.stock_status || '未設定') + '</span>' +
      '    <h2 class="mt-2 text-xl font-bold leading-snug">' + esc(item.name) + '</h2>' +
      '  </div>' +

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
      '    <button id="btn-edit" class="h-12 rounded-xl bg-slate-900 text-white font-semibold active:bg-slate-700">編集</button>' +
      '    <button id="btn-delete" class="h-12 rounded-xl bg-white border border-rose-300 text-rose-600 font-semibold active:bg-rose-50">削除</button>' +
      '  </div>' +
      '</div>';
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

  function updateStatus(newStatus) {
    var item = state.currentItem;
    if (!item || item.stock_status === newStatus) return;

    loading(true, '更新中…');
    api('updateStatus', { item_id: item.item_id, stock_status: newStatus })
      .then(function (data) {
        state.currentItem = data.item;
        toast('「' + newStatus + '」に更新しました', 'success');
        return api('getItem', { item_id: item.item_id, withLogs: true });
      })
      .then(function (data) {
        if (data) renderDetail(data.item, data.logs || []);
      })
      .catch(function (err) { toast(err.message || '更新に失敗しました', 'error'); })
      .then(function () { loading(false); }, function () { loading(false); });
  }

  function deleteItem() {
    var item = state.currentItem;
    if (!item) return;
    if (!window.confirm('「' + item.name + '」を削除します。\n（データは残り、一覧から非表示になります）')) return;

    loading(true, '削除中…');
    api('deleteItem', { item_id: item.item_id })
      .then(function () {
        toast('削除しました', 'success');
        return goto('list', { replace: true });
      })
      .catch(function (err) { toast(err.message || '削除に失敗しました', 'error'); })
      .then(function () { loading(false); }, function () { loading(false); });
  }

  /* ================================================================
   * 登録 / 編集フォーム
   * ==============================================================*/

  /**
   * @param {Object|null} item     編集対象。null なら新規
   * @param {string=} presetItemId 新規時に ID を固定したい場合（QR 先行発行など）
   */
  function openForm(item, presetItemId) {
    state.photoDraft = null;
    var isEdit = !!item;
    var v = item || {
      item_id: presetItemId || '',
      name: '', category: '', location: '',
      stock_status: state.meta.stockStatuses[0],
      quantity: '', note: '', photo_url: ''
    };

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

    var currentPhoto = v.photo_url
      ? '<img id="photo-preview" src="' + esc(v.photo_url) + '" alt="" class="w-full aspect-[4/3] object-cover rounded-xl bg-slate-200">'
      : '<div id="photo-preview-empty" class="w-full aspect-[4/3] rounded-xl bg-slate-100 border-2 border-dashed border-slate-300 flex flex-col items-center justify-center gap-1 text-slate-400">' +
        '<span class="text-4xl">📷</span><span class="text-xs">写真なし</span></div>';

    $('#view-form').innerHTML = '' +
      '<form id="item-form" class="space-y-4" novalidate>' +
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

    return goto('form', { title: isEdit ? '備品を編集' : '備品を登録' });
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
    if (isEdit) {
      action = 'updateItem';
      payload.item_id = itemId;
    } else {
      action = 'createItem';
      var manualId = $('#f-item-id') ? $('#f-item-id').value.trim() : '';
      if (manualId) payload.item_id = manualId;
    }

    loading(true, state.photoDraft ? '写真をアップロード中…' : '保存中…');
    api(action, payload)
      .then(function (data) {
        state.photoDraft = null;
        toast(isEdit ? '保存しました' : '登録しました（' + data.item.item_id + '）', 'success');
        // 新しいカテゴリ・場所を候補に反映
        mergeMeta(payload.category, payload.location);
        return openDetail(data.item.item_id);
      })
      .catch(function (err) { toast(err.message || '保存に失敗しました', 'error'); })
      .then(function () { loading(false); }, function () { loading(false); });
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

  function startScanner() {
    if (state.scanning) return Promise.resolve();
    if (!window.Html5Qrcode) {
      $('#scan-hint').textContent = 'スキャナの読み込みに失敗しました。下の入力欄から備品IDを直接開いてください。';
      return Promise.resolve();
    }

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

  function bindEvents() {
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
      if (card) openDetail(card.getAttribute('data-item-id'));
    });

    // 詳細のボタン（イベント委譲）
    $('#view-detail').addEventListener('click', function (ev) {
      var statusBtn = ev.target.closest('[data-set-status]');
      if (statusBtn) return updateStatus(statusBtn.getAttribute('data-set-status'));
      if (ev.target.closest('#btn-edit')) return openForm(state.currentItem);
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
          loadItems();
        });
      });

    $('#btn-clear-filter').addEventListener('click', function () {
      state.filters = { keyword: '', category: '', location: '', stock_status: '' };
      $('#search-input').value = '';
      rebuildFilterOptions();
      loadItems();
    });

    $('#btn-manual-go').addEventListener('click', function () {
      var id = $('#manual-id').value.trim();
      if (!id) return;
      $('#manual-id').value = '';
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
    initGoogleSignIn();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
