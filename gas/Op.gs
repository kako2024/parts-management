/**
 * Op.gs
 * ------------------------------------------------------------------
 * 更新操作の操作 ID。送り直された保存を二重に実行しないために使う（PLAN-2 項目 1）。
 *
 * 画面は保存のたびに一意な op_id を作る。送り直すときも同じ op_id を使い、何回目の送信か
 * （op_attempt）を添える。サーバーは操作の記録を「op_id:要約値」の形で次の 2 か所に残す。
 * 要約値は、利用者・action・内容から作る。同じ op_id を別の内容・別の利用者で使い回した送信を見分けるため。
 *   - logs シートの op_id 列：その操作で追記した履歴の行。履歴は消さないので、古い操作も見つかる
 *   - items シートの op_ids 列：その備品の行に書き込んだ操作（空白区切り）。行と同じ 1 回の書き込みで書く
 *     ので、行が書かれていれば記録もある。履歴に残ったことを確かめた記録だけを古い順に消す（nextOpIds_）。
 *     行は書いたが履歴を追記する前に止まった操作の記録は、後から何度更新されても消えない
 * 記録はシートに残すので、CacheService が消えても判定できる。
 *
 * 送信のたびに、先に次のことを調べる（findDoneOp_）。
 *   - 備品の op_ids に記録がある：その行に書いた操作。履歴にもあれば済んでいる（今の備品とその履歴を返し、
 *     二重に実行しない）。履歴に無ければ、行は書いたが履歴を追記する前に止まった（履歴を追記して終える。
 *     行はもう一度書かないので、その後に他の操作が書いた値を戻さない）
 *   - 備品に無く、履歴に記録がある：済んでいる（op_ids の古い記録は、履歴に残ったものから片付けるため）
 *   - どちらにも無い：まだ実行されていない。普通に実行する
 * 1 回目の送信（op_attempt が 1）も調べる。応答なしで切れた POST は、ブラウザ自身が同じ内容のまま送り直す
 * ことがあり（_test/ui.js で確認）、いつ届くかの保証も無い。op_ids の古い記録は片付けるので、備品に無くても
 * 履歴は毎回探す。履歴の検索は op_id の列全体への TextFinder 1 回で済ませる（行数を数える呼び出しもしない）。
 * ------------------------------------------------------------------
 */

var OP_ID_RE_ = /^[A-Za-z0-9-]{8,64}$/;
/** op_ids に残す記録の数の目安。これより多くなったら、履歴に残ったことを確かめた古い記録を消す */
var OP_IDS_KEEP_ = 20;
/** 古い記録の片付けは、目安をこの数だけ超えたときにまとめて行う（毎回は調べない） */
var OP_IDS_SLACK_ = 10;

/** 実行中の操作の記録（op_id:要約値）。操作 ID の無い送信（古い画面・Setup.gs）では空 */
var CURRENT_OP_MARK_ = '';

function currentOpMark_() {
  return CURRENT_OP_MARK_;
}

/**
 * 更新操作を操作 ID つきで実行する。withLock_ の中で呼ぶ。
 * @param {string} action
 * @param {Object} payload
 * @param {Object} user
 * @param {function(Object, Object): Object} fn 操作の本体（actCreateItem_ など）
 */
function runOp_(action, payload, user, fn) {
  var op = parseOp_(action, payload, user);
  if (op) {
    var done = findDoneOp_(op);
    lap_('findOp');
    if (done) return finishDoneOp_(op, done, payload, user);
  }
  CURRENT_OP_MARK_ = op ? op.mark : '';
  try {
    return fn(payload, user);
  } finally {
    CURRENT_OP_MARK_ = '';
  }
}

/** payload から操作を取り出す。op_id が無ければ null（操作 ID を送らない古い画面も受け付ける） */
function parseOp_(action, payload, user) {
  var id = toStr_(payload.op_id);
  if (!id) return null;
  if (!OP_ID_RE_.test(id)) throw new ApiError_('BAD_REQUEST', 'op_id の形式が不正です。', 400);
  var attempt = Math.max(1, Math.floor(Number(payload.op_attempt) || 1));
  var digest = opDigest_(action, payload, user.email);
  return { id: id, attempt: attempt, action: action, digest: digest, mark: id + ':' + digest };
}

/** 操作の要約値（利用者・action と、op_id・op_attempt を除いた payload から作る） */
function opDigest_(action, payload, email) {
  var body = {};
  Object.keys(payload).forEach(function (k) {
    if (k !== 'op_id' && k !== 'op_attempt') body[k] = payload[k];
  });
  var text = String(email).toLowerCase() + '\n' + action + '\n' + canonicalJson_(body);
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text);
  return Utilities.base64EncodeWebSafe(bytes).slice(0, 16);
}

/** キーの順序によらない JSON（要約値が送信ごとに変わらないように） */
function canonicalJson_(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson_).join(',') + ']';
  return '{' + Object.keys(v).sort().map(function (k) {
    return JSON.stringify(k) + ':' + canonicalJson_(v[k]);
  }).join(',') + '}';
}

function splitMark_(mark) {
  var s = toStr_(mark);
  var i = s.indexOf(':');
  return i === -1 ? { id: s, digest: '' } : { id: s.slice(0, i), digest: s.slice(i + 1) };
}

function splitOpIds_(opIds) {
  return toStr_(opIds).split(/\s+/).filter(function (m) { return !!m; });
}

/**
 * 送られた操作が済んでいるかを調べる。履歴の検索は、どの場合も 1 回だけ行う。
 * @return {null|{itemId: string, log: Object|null, mark: string}} 済んでいなければ null
 */
function findDoneOp_(op) {
  // 備品の op_ids（読み込みは後の処理と共用。ITEMS_MEMO_）
  var rows = readItems_().rows;
  for (var i = 0; i < rows.length; i++) {
    var mark = splitOpIds_(rows[i]._op_ids).filter(function (m) { return splitMark_(m).id === op.id; })[0];
    if (mark) {
      var hit = findLogByOp_(op.id); // 履歴があれば済んでいる。無ければ途中で止まっていた
      return { itemId: rows[i].item_id, log: hit ? hit.log : null, mark: mark };
    }
  }
  var log = findLogByOp_(op.id);
  return log ? { itemId: log.item_id, log: log.log, mark: log.mark } : null;
}

/** 履歴の op_id 列の 2 行目以降（行数を数えずに列全体を指す。例: H2:H） */
function logOpColumnRange_(sh) {
  var col = String.fromCharCode(64 + LOG_OP_COL_);
  return sh.getRange(col + '2:' + col);
}

/**
 * 履歴の op_id 列の全体から、操作 ID が一致する行を探す。シートの検索（TextFinder）を使うので、
 * 行数が増えても呼び出しは 1 回で済む（見つかったときだけ、その行をもう 1 回読む）。
 */
function findLogByOp_(opId) {
  var sh = sheet_(CONST.SHEET_LOGS);
  var cells = logOpColumnRange_(sh).createTextFinder(opId).matchCase(true).findAll();
  for (var c = cells.length - 1; c >= 0; c--) {
    if (splitMark_(cells[c].getValue()).id !== opId) continue; // 部分一致を除く
    var row = sh.getRange(cells[c].getRow(), 1, 1, LOG_OP_COL_).getValues()[0];
    return {
      item_id: toStr_(row[2]),
      mark: toStr_(row[LOG_OP_COL_ - 1]),
      log: {
        log_id: toStr_(row[0]), timestamp: toStr_(row[1]), item_id: toStr_(row[2]), user_email: toStr_(row[3]),
        action_type: toStr_(row[4]), before_state: toStr_(row[5]), after_state: toStr_(row[6])
      }
    };
  }
  return null;
}

/**
 * 行に書く op_ids。今の記録に mark を足す。記録が OP_IDS_KEEP_ + OP_IDS_SLACK_ を超えたら、古いものの
 * うち履歴に残ったこと（logs の op_id 列にあること）を確かめたものだけを消す。履歴の無い記録は残す。
 */
function nextOpIds_(current, mark) {
  var list = splitOpIds_(current);
  if (mark && list.indexOf(mark) === -1) list.push(mark);
  if (list.length <= OP_IDS_KEEP_ + OP_IDS_SLACK_) return list.join(' ');
  var old = list.slice(0, list.length - OP_IDS_KEEP_);
  var logged = loggedOpIds_(old.map(function (m) { return splitMark_(m).id; }));
  return list.filter(function (m) { return !logged[splitMark_(m).id]; }).join(' ');
}

/** ids のうち、履歴（logs の op_id 列）にあるものを返す。検索は 1 回（正規表現の TextFinder） */
function loggedOpIds_(ids) {
  var found = {};
  if (!ids.length) return found;
  var sh = sheet_(CONST.SHEET_LOGS);
  var want = {};
  ids.forEach(function (id) { want[id] = true; });
  // op_id は英数字とハイフンだけ（OP_ID_RE_）なので、そのまま正規表現に並べられる
  var cells = logOpColumnRange_(sh)
    .createTextFinder('^(' + ids.join('|') + '):').useRegularExpression(true).matchCase(true).findAll();
  cells.forEach(function (cell) {
    var id = splitMark_(cell.getValue()).id;
    if (want[id]) found[id] = true;
  });
  lap_('opIdsTrim');
  return found;
}

/**
 * 済んでいた操作の結果を返す。途中で止まっていれば続き（履歴の追記、登録の写真）を行う。
 * 同じ操作 ID を別の内容・別の利用者で送ってきたら（要約値が違う）、何もせずに OP_MISMATCH で断る。
 */
function finishDoneOp_(op, done, payload, user) {
  var found = findItem_(done.itemId);
  var item = found.item ? stripInternal_(found.item) : null;
  if (splitMark_(done.mark).digest !== op.digest) {
    throw new ApiError_('OP_MISMATCH',
      'この操作はすでに保存されています（送り直した内容が最初の内容と違うため、送り直した内容は保存していません）。',
      409, { item: item && !item.is_deleted ? item : null });
  }
  if (!found.item) {
    throw new ApiError_('ITEM_NOT_FOUND', '備品 "' + done.itemId + '" は登録されていません。', 404);
  }

  CURRENT_OP_MARK_ = op.mark;
  try {
    var photoState = null;
    if (payload.photos !== undefined) {
      try { photoState = JSON.parse(found.item._photo_ops || '{}')[op.id]; } catch (e) {}
    }
    var log = done.log || appendLog_(done.itemId, user.email, resumeActionType_(op.action),
      photoState ? photoState.before : '', photoState ? photoState.after : resumeAfterState_(op.action, payload));
    var res = { item: item, log: log, replayed: true };
    if (payload.photos !== undefined) {
      var recorded = {};
      try { recorded = JSON.parse(log.after_state); } catch (e) {}
      photoResponse_(res, photoState ? photoState.errors : recorded._photo_errors);
    }
    // 登録で写真だけ保存できていなかったら、写真の保存をもう一度試す
    if (op.action === 'createItem' && payload.photo && payload.photo.data && !item.photo_url) {
      attachPhoto_(res, preparePhoto_(payload.photo), user);
    }
    return res;
  } finally {
    CURRENT_OP_MARK_ = '';
  }
}

function resumeActionType_(action) {
  return {
    createItem: CONST.ACTION_CREATE,
    updateStatus: CONST.ACTION_UPDATE_STATUS,
    updateItem: CONST.ACTION_UPDATE,
    deleteItem: CONST.ACTION_DELETE
  }[action];
}

/**
 * 途中で止まった操作の履歴に書く「後」の値。その操作で送られた内容から作る（今の備品の値には、
 * その後の他の操作の変更が入っていることがあるため）。「前」の値は失われているので空にする。
 */
function resumeAfterState_(action, payload) {
  var pick = function (keys) {
    var o = {};
    keys.forEach(function (k) {
      if (payload[k] !== undefined) o[k] = k === 'quantity' ? toNumOrNull_(payload[k]) : sanitizeText_(payload[k], 1000);
    });
    return o;
  };
  if (action === 'deleteItem') return { is_deleted: true };
  if (action === 'updateStatus') return pick(['stock_status', 'quantity', 'note']);
  if (action === 'updateItem') {
    var patch = pick(['name', 'category', 'location', 'stock_status', 'quantity', 'note']);
    if (payload.photo && payload.photo.data) patch.photo = '（写真を保存）';
    return patch;
  }
  var created = pick(['name', 'category', 'location', 'stock_status', 'quantity']);
  if (!created.stock_status) created.stock_status = CONST.STOCK_STATUSES[0];
  return created;
}
