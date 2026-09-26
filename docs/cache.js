/**
 * cache.js — 一覧・詳細データの端末内キャッシュ
 * ------------------------------------------------------------------
 * 前回取得したデータを localStorage に保存し、起動時や画面遷移時に API を待たずに
 * 表示するために使う（表示後に裏で最新を取得して差し替える。PERF.md 項目 4）。
 *
 * - 保存するのは備品データと候補（カテゴリ・場所）だけ。ID トークンは保存しない。
 * - 持ち主（ログインしたメールアドレス）と GAS の URL を一緒に保存し、
 *   別のユーザー・別の環境のデータは返さない。
 * - ログアウト時・認証エラー時・別ユーザーでのログイン時に app.js が clear() を呼ぶ。
 * ------------------------------------------------------------------
 */
(function () {
  'use strict';

  var KEY = 'parts-cache:v1';
  /** 詳細（履歴つき）を保存しておく件数の上限。古いものから捨てる */
  var MAX_DETAILS = 50;

  function read() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
  }

  function write(data) {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch (e) {
      // 容量超過などで保存できなくても動作は続ける（次回は API を待つだけ）
      try { localStorage.removeItem(KEY); } catch (e2) {}
    }
  }

  function clear() {
    try { localStorage.removeItem(KEY); } catch (e) {}
  }

  /**
   * 持ち主と環境が一致するキャッシュを返す。一致しなければ null。
   * @param {string} apiUrl GAS の URL
   * @param {string|null} email 照合するメールアドレス。null なら照合しない（計測用の認証省略のときだけ）
   */
  function load(apiUrl, email) {
    var c = read();
    if (!c || c.apiUrl !== apiUrl) return null;
    if (email !== null && c.email !== String(email || '').toLowerCase()) return null;
    return c;
  }

  /**
   * 保存済みのキャッシュが別のユーザー・別の環境のものなら消す（別ユーザーでログインした時点で呼ぶ）。
   * email が null（計測用の認証省略）なら照合できないので何もしない。
   */
  function discardIfNotOwner(apiUrl, email) {
    if (email === null) return;
    var c = read();
    if (c && (c.apiUrl !== apiUrl || c.email !== String(email || '').toLowerCase())) clear();
  }

  /** 一覧（絞り込みなし）と候補を保存する。持ち主が変わっていれば詳細も捨てる */
  function saveList(apiUrl, email, items, meta) {
    var owner = String(email || '').toLowerCase();
    var c = read();
    var keepDetails = c && c.apiUrl === apiUrl && c.email === owner;
    write({
      apiUrl: apiUrl,
      email: owner,
      savedAt: Date.now(),
      meta: meta || (keepDetails ? c.meta : null),
      items: items,
      details: keepDetails ? (c.details || {}) : {}
    });
  }

  /** 詳細（備品と履歴）を保存し、一覧の同じ備品も最新に置き換える */
  function saveDetail(apiUrl, email, item, logs) {
    var c = load(apiUrl, email);
    if (!c) return;
    c.details = c.details || {};
    c.details[item.item_id] = { item: item, logs: logs, savedAt: Date.now() };
    var ids = Object.keys(c.details);
    if (ids.length > MAX_DETAILS) {
      ids.sort(function (a, b) { return c.details[a].savedAt - c.details[b].savedAt; });
      ids.slice(0, ids.length - MAX_DETAILS).forEach(function (id) { delete c.details[id]; });
    }
    c.items = upsert(c.items || [], item);
    write(c);
  }

  /** 備品を一覧と詳細から取り除く（削除済み・見つからなかったとき） */
  function remove(apiUrl, email, itemId) {
    var c = load(apiUrl, email);
    if (!c) return;
    c.items = (c.items || []).filter(function (it) { return it.item_id !== itemId; });
    if (c.details) delete c.details[itemId];
    write(c);
  }

  /** 手元にある備品と履歴を返す。履歴を持っていなければ logs は null */
  function findItem(apiUrl, email, itemId) {
    var c = load(apiUrl, email);
    if (!c) return null;
    var d = c.details && c.details[itemId];
    if (d) return { item: d.item, logs: d.logs };
    var it = (c.items || []).filter(function (x) { return x.item_id === itemId; })[0];
    return it ? { item: it, logs: null } : null;
  }

  function upsert(items, item) {
    var found = false;
    var out = items.map(function (it) {
      if (it.item_id !== item.item_id) return it;
      found = true;
      return item;
    });
    return found ? out : [item].concat(out);
  }

  window.ItemCache = {
    load: load,
    discardIfNotOwner: discardIfNotOwner,
    saveList: saveList,
    saveDetail: saveDetail,
    remove: remove,
    findItem: findItem,
    clear: clear
  };
})();
