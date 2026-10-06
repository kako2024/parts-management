/**
 * Api.gs
 * ------------------------------------------------------------------
 * Web API のエントリポイント。
 *
 * 全ての通信は POST。リクエストボディは JSON:
 *   { "action": "...", "idToken": "...", "payload": { ... } }
 *
 * レスポンス:
 *   成功 { "ok": true,  "data": { ... } }
 *   失敗 { "ok": false, "error": { "code": "...", "message": "...", "status": 401 } }
 *
 * CORS について:
 *   GAS の Web App は独自レスポンスヘッダを設定できないが、/exec は
 *   Access-Control-Allow-Origin: * を返す。ただしプリフライト(OPTIONS)には
 *   応答しないため、フロント側は Content-Type: text/plain を使い
 *   「単純リクエスト」に収めること（docs/app.js の api() 参照）。
 * ------------------------------------------------------------------
 */

/** ブラウザで /exec を直接開いたときの疎通確認用 */
function doGet(e) {
  return okRes_({
    service: 'PartsManagement API',
    status: 'running',
    time: nowString_(),
    hint: 'この API は POST のみを受け付けます。'
  });
}

function doPost(e) {
  var startedAt = Date.now(); // 計測（debugTiming）の起点。解析前から計る
  WRITE_STARTED_ = false;
  PHOTO_CANDIDATES_ = null;
  forgetItemsMemo_();
  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new ApiError_('BAD_REQUEST', 'リクエストボディが空です。', 400);
    }

    var req;
    try {
      req = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      throw new ApiError_('BAD_REQUEST', 'リクエストの JSON を解析できませんでした。', 400);
    }

    timingStart_(req.debugTiming === true, startedAt);
    lap_('parse');

    var action = req.action;
    var payload = req.payload || {};
    if (!action) throw new ApiError_('BAD_REQUEST', 'action が指定されていません。', 400);

    // 全 action で認証・認可を通す
    var user = authenticate_(req.idToken);

    switch (action) {
      case 'loginCheck':   return okRes_(actLoginCheck_(user, payload));
      case 'getItems':     return okRes_(actGetItems_(payload));
      case 'getItem':      return okRes_(actGetItem_(payload));
      case 'createItem':   return okRes_(withLock_(function () { return runOp_(action, payload, user, actCreateItem_); }));
      case 'updateStatus': return okRes_(withLock_(function () { return runOp_(action, payload, user, actUpdateStatus_); }));
      case 'updateItem':   return okRes_(withLock_(function () { return runOp_(action, payload, user, actUpdateItem_); }));
      case 'deleteItem':   return okRes_(withLock_(function () { return runOp_(action, payload, user, actDeleteItem_); }));
      case 'getLogs':      return okRes_(actGetLogs_(payload));
      default:
        throw new ApiError_('UNKNOWN_ACTION', '未知の action です: ' + action, 400);
    }
  } catch (err) {
    return errRes_(err);
  }
}

/** 書き込み系を直列化する（同時更新による行ズレ・採番衝突の防止） */
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CONST.LOCK_WAIT_MS)) {
    throw new ApiError_('BUSY', '他の更新処理と競合しました。少し待って再試行してください。', 503);
  }
  lap_('lock');
  PHOTO_CANDIDATES_ = [];
  try {
    return fn();
  } finally {
    try {
      commitCacheVersions_(); // 書き込みを確定させてから読み取り用キャッシュの版を変える
    } finally {
      try { cleanupPhotos_(); } finally { lock.releaseLock(); }
    }
  }
}

/* =========================================================
 * 各アクション
 * =======================================================*/

/**
 * ログイン可否とユーザー情報、およびフォーム用のマスタ候補を返す。
 * payload.withItems が真なら、getItems と同じ絞り込み（payload.filters）をかけた一覧も返す。
 * 起動時に loginCheck → getItems と直列に 2 回呼ぶ待ちと、シートの二重読み込みをなくすため。
 */
function actLoginCheck_(user, payload) {
  payload = payload || {};
  var items = listItems_(false);
  lap_('listItems');
  var categories = uniqueSorted_(items.map(function (i) { return i.category; }));
  var locations = uniqueSorted_(items.map(function (i) { return i.location; }));
  var res = {
    user: { email: user.email, name: user.name, picture: user.picture },
    stockStatuses: CONST.STOCK_STATUSES,
    categories: categories,
    locations: locations,
    itemCount: items.length,
    serverTime: nowString_()
  };
  if (payload.withItems) {
    var list = filterAndSortItems_(items, payload.filters || {});
    res.items = list.items;
    res.total = list.total;
  }
  return res;
}

function uniqueSorted_(arr) {
  var seen = {};
  var out = [];
  arr.forEach(function (v) {
    var s = toStr_(v).trim();
    if (!s || seen[s]) return;
    seen[s] = true;
    out.push(s);
  });
  return out.sort();
}

/**
 * 一覧取得。
 * payload: { keyword?, category?, location?, stock_status?, restock?, includeDeleted? }
 */
function actGetItems_(payload) {
  return filterAndSortItems_(listItems_(!!payload.includeDeleted), payload);
}

/** 一覧の絞り込み（keyword / category / location / stock_status / restock）と更新日時の降順並べ替え */
function filterAndSortItems_(items, payload) {
  var kw = sanitizeText_(payload.keyword, 100).toLowerCase();
  var cat = sanitizeText_(payload.category, 60);
  var loc = sanitizeText_(payload.location, 120);
  var st = sanitizeText_(payload.stock_status, 20);
  var restock = payload.restock === true; // 要補充（残りわずか・在庫なし）だけ

  var filtered = items.filter(function (it) {
    if (cat && it.category !== cat) return false;
    if (loc && it.location !== loc) return false;
    if (st && it.stock_status !== st) return false;
    if (restock && CONST.RESTOCK_STATUSES.indexOf(it.stock_status) === -1) return false;
    if (kw) {
      var hay = (it.item_id + ' ' + it.name + ' ' + it.category + ' ' +
                 it.location + ' ' + it.note).toLowerCase();
      if (hay.indexOf(kw) === -1) return false;
    }
    return true;
  });

  filtered.sort(function (a, b) {
    return toStr_(b.updated_at).localeCompare(toStr_(a.updated_at));
  });

  return { items: filtered, total: filtered.length };
}

/** 単票取得。payload: { item_id, withLogs? } */
function actGetItem_(payload) {
  var itemId = sanitizeText_(payload.item_id, 64);
  if (!itemId) throw new ApiError_('BAD_REQUEST', 'item_id は必須です。', 400);

  var item = findItemForRead_(itemId);
  if (!item || item.is_deleted) {
    throw new ApiError_('ITEM_NOT_FOUND', '備品 "' + itemId + '" は登録されていません。', 404);
  }
  var res = { item: item };
  if (payload.withLogs) res.logs = readItemLogs_(itemId, 30);
  return res;
}

/**
 * 新規登録。
 * payload: { name, category, location, stock_status, quantity?, note?, item_id?, photo?, op_id?, op_attempt? }
 * photo: { data(base64), mimeType, filename }
 *
 * 備品の行 → 履歴 → 写真 の順に保存する。写真の形式・大きさは行を書く前に確かめる（誤りなら何も保存しない）。
 * 写真を Drive に保存できなかったときは、備品は登録済みのまま成功を返し、photoError で知らせる
 * （画面は写真だけを送り直せる。同じ操作 ID で送り直せば、写真の保存だけをもう一度試す。Op.gs）。
 */
function actCreateItem_(payload, user) {
  var name = sanitizeText_(payload.name, 120);
  if (!name) throw new ApiError_('VALIDATION_ERROR', '備品名は必須です。', 400);

  var status = sanitizeText_(payload.stock_status, 20) || CONST.STOCK_STATUSES[0];
  assertStockStatus_(status);

  var selection = preparePhotos_(payload, null);
  if (selection) return createWithPhotos_(payload, user, name, status, selection);
  var photo = (payload.photo && payload.photo.data) ? preparePhoto_(payload.photo) : null;

  var input = {
    item_id: payload.item_id,
    name: name,
    category: payload.category,
    location: payload.location,
    stock_status: status,
    quantity: payload.quantity,
    note: payload.note,
    photo_url: ''
  };

  var created = insertItem_(input, user.email);

  var log = appendLog_(created.item_id, user.email, CONST.ACTION_CREATE, '', {
    name: created.name,
    category: created.category,
    location: created.location,
    stock_status: created.stock_status,
    quantity: created.quantity
  });

  var res = { item: created, log: log };
  if (photo) attachPhoto_(res, photo, user);
  return res;
}

/** PHOTO.md 項目4: 写真結果と操作結果を備品の行と一緒に確定する。 */
function createWithPhotos_(payload, user, name, status, selection) {
  var rows = readItems_().rows;
  var id = sanitizeText_(payload.item_id, 64) || nextItemId_(rows);
  if (rows.some(function (r) { return r.item_id === id; })) throw new ApiError_('ITEM_ID_DUPLICATED', '備品IDは既に使われています。', 409);
  var saved = storePhotos_(selection, id, user.email);
  var after = { name: name, category: sanitizeText_(payload.category, 60), location: sanitizeText_(payload.location, 120),
    stock_status: status, quantity: toNumOrNull_(payload.quantity), photos: saved.photos, photo_url: saved.photo_url, _photo_errors: saved.errors };
  var input = Object.assign({}, payload, { item_id: id, name: name, stock_status: status, photos: saved.photos,
    photo_url: saved.photo_url, photo_ops: photoOpState_(null, '', after, saved.errors) });
  var created = insertItem_(input, user.email);
  var log = appendLog_(id, user.email, CONST.ACTION_CREATE, '', after);
  return photoResponse_({ item: created, log: log }, saved.errors);
}

/**
 * 登録済みの備品に写真を保存して URL を書き戻し、res.item を差し替える。
 * 失敗しても例外にせず、res.photoError に理由を入れる（備品の登録は取り消さない）。
 */
function attachPhoto_(res, photo, user) {
  var itemId = res.item.item_id;
  try {
    var url = storePhoto_(photo, itemId, user.email);
    var again = findItem_(itemId);
    if (!again.item) throw new Error('備品 "' + itemId + '" が見つかりません。');
    res.item = updateItemRow_(again.item, { photo_url: url }, again.ctx, user.email);
  } catch (e) {
    console.error('photo save failed after create: ' + itemId + ' : ' + (e && e.message));
    res.photoError = '写真を保存できませんでした（' + ((e && e.message) || e) + '）。';
  }
}

/**
 * 在庫ステータスのみ更新（スマホでの主用途。QR を読んでボタン 1 タップ）。
 * payload: { item_id, stock_status, quantity?, note?, base_version? }
 */
function actUpdateStatus_(payload, user) {
  var itemId = sanitizeText_(payload.item_id, 64);
  if (!itemId) throw new ApiError_('BAD_REQUEST', 'item_id は必須です。', 400);

  var status = sanitizeText_(payload.stock_status, 20);
  assertStockStatus_(status);

  var found = findItem_(itemId);
  if (!found.item || found.item.is_deleted) {
    throw new ApiError_('ITEM_NOT_FOUND', '備品 "' + itemId + '" は登録されていません。', 404);
  }
  assertBaseVersion_(found.item, payload.base_version);

  var before = {
    stock_status: found.item.stock_status,
    quantity: found.item.quantity
  };

  var patch = { stock_status: status };
  if (payload.quantity !== undefined) patch.quantity = toNumOrNull_(payload.quantity);
  if (payload.note !== undefined) patch.note = sanitizeText_(payload.note, 1000);

  var updated = updateItemRow_(found.item, patch, found.ctx, user.email);

  var log = appendLog_(itemId, user.email, CONST.ACTION_UPDATE_STATUS, before, {
    stock_status: updated.stock_status,
    quantity: updated.quantity
  });

  return { item: updated, log: log };
}

/**
 * 備品情報の一般更新。
 * payload: { item_id, name?, category?, location?, stock_status?, quantity?, note?, photo?, base_version? }
 */
function actUpdateItem_(payload, user) {
  var itemId = sanitizeText_(payload.item_id, 64);
  if (!itemId) throw new ApiError_('BAD_REQUEST', 'item_id は必須です。', 400);

  var found = findItem_(itemId);
  if (!found.item || found.item.is_deleted) {
    throw new ApiError_('ITEM_NOT_FOUND', '備品 "' + itemId + '" は登録されていません。', 404);
  }
  assertBaseVersion_(found.item, payload.base_version); // 写真を Drive に保存する前に確かめる

  var before = stripInternal_(found.item);
  var patch = {};

  if (payload.name !== undefined) {
    var nm = sanitizeText_(payload.name, 120);
    if (!nm) throw new ApiError_('VALIDATION_ERROR', '備品名は空にできません。', 400);
    patch.name = nm;
  }
  if (payload.category !== undefined) patch.category = sanitizeText_(payload.category, 60);
  if (payload.location !== undefined) patch.location = sanitizeText_(payload.location, 120);
  if (payload.note !== undefined) patch.note = sanitizeText_(payload.note, 1000);
  if (payload.quantity !== undefined) patch.quantity = toNumOrNull_(payload.quantity);
  if (payload.stock_status !== undefined) {
    var st = sanitizeText_(payload.stock_status, 20);
    assertStockStatus_(st);
    patch.stock_status = st;
  }
  var selection = preparePhotos_(payload, found.item);
  var photoErrors = [];
  if (selection) {
    recordOldPhotos_(found.item);
    var saved = storePhotos_(selection, itemId, user.email);
    patch.photos = saved.photos;
    patch.photo_url = saved.photo_url;
    photoErrors = saved.errors;
  } else if (payload.photo && payload.photo.data) {
    recordOldPhotos_(found.item);
    patch.photo_url = savePhoto_(payload.photo, itemId, user.email);
    var list = found.item.photos.slice();
    var primaryIndex = list.findIndex(function (p) { return p.url === found.item.photo_url; });
    var replacement = { id: legacyPhotoId_(patch.photo_url), url: patch.photo_url };
    if (primaryIndex >= 0) list[primaryIndex] = replacement; else list.push(replacement);
    patch.photos = list;
  }

  if (!Object.keys(patch).length) {
    throw new ApiError_('VALIDATION_ERROR', '更新する項目がありません。', 400);
  }

  var beforeDiff = {};
  Object.keys(patch).forEach(function (k) { beforeDiff[k] = before[k]; });
  var after = Object.assign({}, patch);
  if (selection) {
    after._photo_errors = photoErrors;
    patch.photo_ops = photoOpState_(found.item, beforeDiff, after, photoErrors);
  }
  var updated = updateItemRow_(found.item, patch, found.ctx, user.email);
  var log = appendLog_(itemId, user.email, CONST.ACTION_UPDATE, beforeDiff, after);
  return photoResponse_({ item: updated, log: log }, photoErrors);
}

/** 論理削除。payload: { item_id, base_version? } */
function actDeleteItem_(payload, user) {
  var itemId = sanitizeText_(payload.item_id, 64);
  if (!itemId) throw new ApiError_('BAD_REQUEST', 'item_id は必須です。', 400);

  var found = findItem_(itemId);
  if (!found.item) {
    throw new ApiError_('ITEM_NOT_FOUND', '備品 "' + itemId + '" は登録されていません。', 404);
  }
  if (found.item.is_deleted) {
    return { item: stripInternal_(found.item), alreadyDeleted: true };
  }
  assertBaseVersion_(found.item, payload.base_version);

  var updated = updateItemRow_(found.item, { is_deleted: true }, found.ctx, user.email);
  var log = appendLog_(itemId, user.email, CONST.ACTION_DELETE, { is_deleted: false }, { is_deleted: true });

  return { item: updated, log: log };
}

/** 履歴取得。payload: { item_id?, limit? } */
function actGetLogs_(payload) {
  var itemId = sanitizeText_(payload.item_id, 64);
  var limit = Math.min(Number(payload.limit) || 50, 300);
  return { logs: readLogs_(itemId || null, limit) };
}

function assertStockStatus_(status) {
  if (CONST.STOCK_STATUSES.indexOf(status) === -1) {
    throw new ApiError_(
      'VALIDATION_ERROR',
      '在庫ステータスは ' + CONST.STOCK_STATUSES.join(' / ') + ' のいずれかを指定してください。',
      400
    );
  }
}
