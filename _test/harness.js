/**
 * GAS コードの結合テスト用ハーネス（リポジトリには含めなくてよい）
 * Apps Script のサービスをモックし、doPost を素の Node で走らせる。
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

/* ---------- スプレッドシートのモック ---------- */
function makeSheet(name, headers) {
  const data = [headers.slice()];
  const api = {
    _data: data,
    getName: () => name,
    getLastRow: () => data.length,
    getLastColumn: () => Math.max(...data.map(r => r.length)),
    getMaxRows: () => Math.max(data.length, 100),
    setFrozenRows: () => api,
    getDataRange: () => ({
      getValues: () => data.map(r => {
        const w = api.getLastColumn();
        const c = r.slice();
        while (c.length < w) c.push('');
        return c;
      })
    }),
    appendRow: (row) => { data.push(row.slice()); return api; },
    getRange: (r, c, nr, nc) => ({
      getValues: () => {
        const out = [];
        for (let i = 0; i < (nr || 1); i++) {
          const row = data[r - 1 + i] || [];
          const seg = [];
          for (let j = 0; j < (nc || 1); j++) seg.push(row[c - 1 + j] === undefined ? '' : row[c - 1 + j]);
          out.push(seg);
        }
        return out;
      },
      setValue: (v) => {
        while (data.length < r) data.push([]);
        data[r - 1][c - 1] = v;
      },
      setValues: (vals) => {
        vals.forEach((row, i) => {
          while (data.length < r + i) data.push([]);
          row.forEach((v, j) => { data[r - 1 + i][c - 1 + j] = v; });
        });
      },
      setFontWeight: function () { return this; },
      setBackground: function () { return this; },
      setDataValidation: function () { return this; }
    })
  };
  return api;
}

const BOOK = {
  sheets: {},
  getName: () => '備品管理DB(mock)',
  getSheetByName(n) { return this.sheets[n] || null; },
  insertSheet(n) { this.sheets[n] = makeSheet(n, []); return this.sheets[n]; }
};

/* ---------- 各種サービスのモック ---------- */
const propsStore = {
  SPREADSHEET_ID: 'sheet-mock',
  GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
  ALLOWED_GROUP_EMAIL: 'members@example.com',
  PHOTO_FOLDER_ID: 'folder-mock',
  EXTRA_ALLOWED_EMAILS: ''
};
const cacheStore = {};
const driveFiles = [];
let groupMembers = ['taro@example.com'];
let tokenInfoResponse = null;

const sandbox = {
  console,
  Date,
  Math,
  JSON,
  String, Number, Boolean, Object, Array, Error, RegExp, isNaN, parseInt, parseFloat,
  encodeURIComponent, decodeURIComponent,

  SpreadsheetApp: {
    openById: () => BOOK,
    flush: () => {},
    newDataValidation: () => ({
      requireValueInList: function () { return this; },
      setAllowInvalid: function () { return this; },
      build: () => ({})
    })
  },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: (k) => (propsStore[k] === undefined ? null : propsStore[k]),
      setProperties: (o) => Object.assign(propsStore, o)
    })
  },
  CacheService: {
    getScriptCache: () => ({
      get: (k) => (cacheStore[k] === undefined ? null : cacheStore[k]),
      put: (k, v) => {
        if (Buffer.byteLength(String(v)) > 100 * 1024) throw new Error('Argument too large: value'); // 本物の上限
        cacheStore[k] = String(v);
      },
      getAll: (keys) => { const o = {}; keys.forEach(k => { if (cacheStore[k] !== undefined) o[k] = cacheStore[k]; }); return o; },
      putAll: (o) => { Object.keys(o).forEach(k => {
        if (Buffer.byteLength(String(o[k])) > 100 * 1024) throw new Error('Argument too large: value');
        cacheStore[k] = String(o[k]);
      }); },
      remove: (k) => { delete cacheStore[k]; },
      removeAll: (keys) => { keys.forEach(k => { delete cacheStore[k]; }); }
    })
  },
  LockService: {
    getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} })
  },
  UrlFetchApp: {
    fetch: () => ({
      getResponseCode: () => (tokenInfoResponse ? 200 : 400),
      getContentText: () => JSON.stringify(tokenInfoResponse || {})
    })
  },
  DriveApp: {
    Access: { ANYONE_WITH_LINK: 'anyone' },
    Permission: { VIEW: 'view' },
    getRootFolder: () => ({ getName: () => 'マイドライブ(mock)' }),
    getFolderById: () => ({
      getName: () => '備品写真(mock)',
      createFile: (blob) => {
        const id = 'file' + (driveFiles.length + 1);
        driveFiles.push({ id, blob });
        return {
          getId: () => id,
          setDescription: function () { return this; },
          setSharing: function () { return this; }
        };
      }
    })
  },
  GroupsApp: {
    getGroupByEmail: (email) => ({
      getEmail: () => email,
      hasUser: (u) => groupMembers.indexOf(u) !== -1
    })
  },
  Session: { getEffectiveUser: () => ({ getEmail: () => 'taro@example.com' }) },
  ContentService: {
    MimeType: { JSON: 'application/json' },
    createTextOutput: (t) => ({ _t: t, setMimeType() { return this; }, getContent() { return this._t; } })
  },
  Utilities: {
    DigestAlgorithm: { SHA_256: 'sha256' },
    formatDate: (d, tz, fmt) => {
      const p = (n, l = 2) => String(n).padStart(l, '0');
      return fmt
        .replace('yyyy', d.getFullYear())
        .replace('MMdd', p(d.getMonth() + 1) + p(d.getDate()))
        .replace('MM', p(d.getMonth() + 1))
        .replace('dd', p(d.getDate()))
        .replace('HHmmss', p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()))
        .replace('HH', p(d.getHours()))
        .replace('mm', p(d.getMinutes()))
        .replace('ss', p(d.getSeconds()));
    },
    computeDigest: (alg, s) => require('crypto').createHash('sha256').update(s).digest(),
    base64Encode: (b) => Buffer.from(b).toString('base64'),
    base64EncodeWebSafe: (b) => Buffer.from(b).toString('base64url'),
    base64Decode: (s) => Array.from(Buffer.from(s, 'base64')),
    newBlob: (bytes, mime, name) => ({ bytes, mime, name }),
    getUuid: () => require('crypto').randomUUID()
  }
};
sandbox.globalThis = sandbox;

/* ---------- GAS ソースを読み込む ---------- */
const ctx = vm.createContext(sandbox);
const dir = path.join(__dirname, '..', 'gas');
['Config.gs', 'Util.gs', 'Auth.gs', 'Repository.gs', 'Photo.gs', 'Api.gs', 'Setup.gs'].forEach(f => {
  vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
});

/* ---------- テストランナー ---------- */
let pass = 0, fail = 0;
function t(label, fn) {
  try { fn(); console.log('  ok   ' + label); pass++; }
  catch (e) { console.log('  FAIL ' + label + '\n       ' + e.message); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error((msg || 'not equal') + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b));
  }
}

function post(action, payload, token) {
  const out = ctx.doPost({
    postData: { contents: JSON.stringify({ action, idToken: token === undefined ? 'TOKEN' : token, payload }) }
  });
  return JSON.parse(out.getContent());
}

function validToken(email) {
  return {
    aud: propsStore.GOOGLE_CLIENT_ID,
    iss: 'https://accounts.google.com',
    exp: Math.floor(Date.now() / 1000) + 3600,
    email,
    email_verified: 'true',
    name: 'テスト太郎',
    sub: '12345'
  };
}

/* ================= テスト本体 ================= */
console.log('\n[初期化]');
tokenInfoResponse = validToken('taro@example.com');
t('initSpreadsheet でシートが作られる', () => {
  ctx.initSpreadsheet();
  assert(BOOK.getSheetByName('items'), 'items なし');
  assert(BOOK.getSheetByName('logs'), 'logs なし');
  eq(BOOK.getSheetByName('items')._data[0], ctx.CONST.ITEM_HEADERS);
});

t('diagnose が全 OK', () => {
  const out = ctx.diagnose();
  assert(out.indexOf('[NG]') === -1, out);
});

console.log('\n[認証・認可]');
t('トークンなしは 401', () => {
  const r = post('getItems', {}, null);
  assert(!r.ok && r.error.status === 401, JSON.stringify(r));
});

t('aud 不一致は 401', () => {
  tokenInfoResponse = Object.assign(validToken('taro@example.com'), { aud: 'other.apps.googleusercontent.com' });
  const r = post('getItems', {}, 'T-aud');
  assert(!r.ok && r.error.code === 'AUTH_AUD_MISMATCH', JSON.stringify(r));
});

t('期限切れは 401', () => {
  tokenInfoResponse = Object.assign(validToken('taro@example.com'), { exp: Math.floor(Date.now() / 1000) - 10 });
  const r = post('getItems', {}, 'T-exp');
  assert(!r.ok && r.error.code === 'AUTH_TOKEN_EXPIRED', JSON.stringify(r));
});

t('グループ外は 403', () => {
  tokenInfoResponse = validToken('gaibu@example.com');
  const r = post('getItems', {}, 'T-out');
  assert(!r.ok && r.error.code === 'FORBIDDEN_NOT_MEMBER', JSON.stringify(r));
});

t('EXTRA_ALLOWED_EMAILS で個別許可できる', () => {
  propsStore.EXTRA_ALLOWED_EMAILS = 'gaibu@example.com';
  tokenInfoResponse = validToken('gaibu@example.com');
  const r = post('loginCheck', {}, 'T-extra');
  assert(r.ok, JSON.stringify(r));
  propsStore.EXTRA_ALLOWED_EMAILS = '';
});

console.log('\n[CRUD]');
tokenInfoResponse = validToken('taro@example.com');
let createdId = null;

t('createItem で ITEM-0001 が採番される', () => {
  const r = post('createItem', { name: 'コピー用紙 A4', category: '事務用品', location: '本館-3F-A棚-2段', stock_status: '余裕あり', quantity: 12 }, 'T1');
  assert(r.ok, JSON.stringify(r));
  createdId = r.data.item.item_id;
  eq(createdId, 'ITEM-0001');
  eq(r.data.item.updated_by, 'taro@example.com');
});

t('2 件目は ITEM-0002', () => {
  const r = post('createItem', { name: 'HDMIケーブル', category: 'IT機器', stock_status: '残りわずか' }, 'T1');
  eq(r.data.item.item_id, 'ITEM-0002');
});

t('備品名なしは VALIDATION_ERROR', () => {
  const r = post('createItem', { name: '   ' }, 'T1');
  assert(!r.ok && r.error.code === 'VALIDATION_ERROR', JSON.stringify(r));
});

t('不正な在庫ステータスは弾かれる', () => {
  const r = post('createItem', { name: 'テスト', stock_status: 'たくさん' }, 'T1');
  assert(!r.ok && r.error.code === 'VALIDATION_ERROR', JSON.stringify(r));
});

t('item_id 手入力の重複は 409', () => {
  const r = post('createItem', { name: '重複テスト', item_id: 'ITEM-0001' }, 'T1');
  assert(!r.ok && r.error.code === 'ITEM_ID_DUPLICATED', JSON.stringify(r));
});

t('写真つき登録で photo_url が入る', () => {
  const b64 = Buffer.from('dummy-jpeg-bytes').toString('base64');
  const r = post('createItem', { name: '写真つき備品', photo: { data: b64, mimeType: 'image/jpeg', filename: 'a.jpg' } }, 'T1');
  assert(r.ok, JSON.stringify(r));
  assert(/^https:\/\/lh3\.googleusercontent\.com\/d\//.test(r.data.item.photo_url), r.data.item.photo_url);
  const stored = post('getItem', { item_id: r.data.item.item_id }, 'T1');
  eq(stored.data.item.photo_url, r.data.item.photo_url, 'シートに書き戻されていない');
});

t('未対応形式の画像は弾かれる', () => {
  const r = post('createItem', { name: 'gif備品', photo: { data: 'AAAA', mimeType: 'image/gif' } }, 'T1');
  assert(!r.ok && r.error.code === 'PHOTO_TYPE_UNSUPPORTED', JSON.stringify(r));
});

t('getItems が一覧を返す', () => {
  const r = post('getItems', {}, 'T1');
  assert(r.ok && r.data.total >= 3, JSON.stringify(r.data.total));
});

t('キーワード検索が効く', () => {
  const r = post('getItems', { keyword: 'hdmi' }, 'T1');
  eq(r.data.items.length, 1);
  eq(r.data.items[0].name, 'HDMIケーブル');
});

t('カテゴリ絞り込みが効く', () => {
  const r = post('getItems', { category: 'IT機器' }, 'T1');
  eq(r.data.items.length, 1);
});

t('updateStatus で値と履歴が更新される', () => {
  const r = post('updateStatus', { item_id: createdId, stock_status: '在庫なし' }, 'T1');
  assert(r.ok, JSON.stringify(r));
  eq(r.data.item.stock_status, '在庫なし');
  const logs = post('getLogs', { item_id: createdId }, 'T1').data.logs;
  const last = logs[0];
  eq(last.action_type, 'UPDATE_STATUS');
  eq(JSON.parse(last.before_state).stock_status, '余裕あり');
  eq(JSON.parse(last.after_state).stock_status, '在庫なし');
});

t('updateItem で部分更新できる', () => {
  const r = post('updateItem', { item_id: createdId, location: '別館-1F-C棚', note: '発注先: ○○商会' }, 'T1');
  assert(r.ok, JSON.stringify(r));
  eq(r.data.item.location, '別館-1F-C棚');
  eq(r.data.item.name, 'コピー用紙 A4', '他の列が壊れている');
});

t('存在しない備品は 404', () => {
  const r = post('getItem', { item_id: 'ITEM-9999' }, 'T1');
  assert(!r.ok && r.error.code === 'ITEM_NOT_FOUND', JSON.stringify(r));
});

t('deleteItem は論理削除（一覧から消える／シートには残る）', () => {
  const before = post('getItems', {}, 'T1').data.total;
  const r = post('deleteItem', { item_id: 'ITEM-0002' }, 'T1');
  assert(r.ok && r.data.item.is_deleted === true, JSON.stringify(r));
  const after = post('getItems', {}, 'T1').data.total;
  eq(after, before - 1);
  const rows = BOOK.getSheetByName('items')._data.filter(r2 => r2[0] === 'ITEM-0002');
  eq(rows.length, 1, 'シートから行が消えている');
});

t('削除済みは getItem で 404', () => {
  const r = post('getItem', { item_id: 'ITEM-0002' }, 'T1');
  assert(!r.ok && r.error.code === 'ITEM_NOT_FOUND', JSON.stringify(r));
});

console.log('\n[ログ・その他]');
t('log_id が LOG-YYYYMMDD-nnn 形式で連番になる', () => {
  const logs = post('getLogs', {}, 'T1').data.logs;
  assert(logs.length >= 5, 'ログが少ない: ' + logs.length);
  logs.forEach(l => assert(/^LOG-\d{8}-\d{3}$/.test(l.log_id), '形式不正: ' + l.log_id));
  const ids = logs.map(l => l.log_id);
  eq(new Set(ids).size, ids.length, 'log_id が重複');
});

t('loginCheck がカテゴリ・場所の候補を返す', () => {
  const r = post('loginCheck', {}, 'T1');
  assert(r.ok, JSON.stringify(r));
  assert(r.data.categories.indexOf('事務用品') !== -1, JSON.stringify(r.data.categories));
  eq(r.data.stockStatuses, ['余裕あり', '残りわずか', '在庫なし']);
});

t('loginCheck は withItems のときだけ getItems と同じ一覧を返す', () => {
  const plain = post('loginCheck', {}, 'T1');
  assert(plain.ok && plain.data.items === undefined, '既定で一覧を返している');
  const both = post('loginCheck', { withItems: true, filters: {} }, 'T1');
  const list = post('getItems', {}, 'T1');
  assert(both.ok && list.ok, JSON.stringify(both));
  eq(both.data.items, list.data.items, '全件の一覧が getItems と違う');
  eq(both.data.total, list.data.total);
  const f = { stock_status: '在庫なし' };
  eq(post('loginCheck', { withItems: true, filters: f }, 'T1').data.items, post('getItems', f, 'T1').data.items, '絞り込みが getItems と違う');
});

t('未知の action は 400', () => {
  const r = post('dropTable', {}, 'T1');
  assert(!r.ok && r.error.code === 'UNKNOWN_ACTION', JSON.stringify(r));
});

t('壊れた JSON でも 500 にならず整形されたエラーを返す', () => {
  const out = ctx.doPost({ postData: { contents: '{broken' } });
  const r = JSON.parse(out.getContent());
  assert(!r.ok && r.error.code === 'BAD_REQUEST', JSON.stringify(r));
});

t('debugTiming 指定時だけ処理時間の内訳を返す', () => {
  const plain = post('getItems', {}, 'T1');
  assert(plain.ok && plain.timing === undefined, JSON.stringify(plain.timing));
  const out = ctx.doPost({
    postData: { contents: JSON.stringify({ action: 'getItems', idToken: 'T1', payload: {}, debugTiming: true }) }
  });
  const r = JSON.parse(out.getContent());
  assert(r.ok && typeof r.timing.total === 'number', JSON.stringify(r.timing));
  assert(/token\(cache\)=\d+/.test(r.timing.laps) && /(readItems\(\d+rows\)|items\(cache\))=\d+/.test(r.timing.laps), r.timing.laps);
});

t('計測用の認証省略は perfBypassUser_ があるときだけ働き、グループ判定は省かない', () => {
  tokenInfoResponse = null; // tokeninfo は常に失敗させる
  const before = post('getItems', {}, 'PERF-TOKEN-1');
  assert(!before.ok && before.error.status === 401, '定義前に通った: ' + JSON.stringify(before));

  ctx.perfBypassUser_ = (tok) => tok.startsWith('PERF-TOKEN') ? { email: tok === 'PERF-TOKEN-2' ? 'x@example.com' : 'taro@example.com', name: '計測用', picture: '', sub: 'perf' } : null;
  try {
    const ok = post('getItems', {}, 'PERF-TOKEN-3');
    assert(ok.ok, JSON.stringify(ok));
    const other = post('getItems', {}, 'PERF-TOKEN-2');
    assert(!other.ok && other.error.code === 'FORBIDDEN_NOT_MEMBER', 'グループ外が通った: ' + JSON.stringify(other));
    const wrong = post('getItems', {}, 'NOT-PERF');
    assert(!wrong.ok && wrong.error.status === 401, '一致しないトークンが通った: ' + JSON.stringify(wrong));
  } finally {
    delete ctx.perfBypassUser_;
  }
  // 撤去した直後から、一度通ったトークンも通らない（キャッシュに残さない）
  const after = post('getItems', {}, 'PERF-TOKEN-3');
  assert(!after.ok && after.error.status === 401, '撤去後に通った: ' + JSON.stringify(after));
  tokenInfoResponse = validToken('taro@example.com');
});

/* ---------- 読み取り用キャッシュ（PERF.md 項目 5） ---------- */
const itemsSheet = () => BOOK.getSheetByName('items');
const timed = (action, payload) => JSON.parse(ctx.doPost({
  postData: { contents: JSON.stringify({ action, idToken: 'T1', payload, debugTiming: true }) }
}).getContent());

t('一覧・単票の 2 回目はシートを読まずにキャッシュから返す', () => {
  post('getItems', {}, 'T1');
  const r = timed('getItems', {});
  assert(r.ok && /items\(cache\)/.test(r.timing.laps) && !/readItems/.test(r.timing.laps), r.timing.laps);
  const one = timed('getItem', { item_id: 'ITEM-0001', withLogs: true });
  assert(one.ok && /items\(cache\)/.test(one.timing.laps), one.timing.laps);
});

t('書き込みの直後は一覧・単票・履歴に最新が出る（キャッシュを捨てる）', () => {
  post('getItem', { item_id: 'ITEM-0001', withLogs: true }, 'T1');
  const before = post('getItem', { item_id: 'ITEM-0001', withLogs: true }, 'T1').data;
  const next = before.item.stock_status === '在庫なし' ? '余裕あり' : '在庫なし';
  assert(post('updateStatus', { item_id: 'ITEM-0001', stock_status: next }, 'T1').ok);
  const after = post('getItem', { item_id: 'ITEM-0001', withLogs: true }, 'T1').data;
  eq(after.item.stock_status, next, '単票が古い');
  eq(after.logs.length, Math.min(before.logs.length + 1, 30), '履歴が増えていない');
  eq(after.logs[0].action_type, 'UPDATE_STATUS');
  const listed = post('getItems', {}, 'T1').data.items.find(i => i.item_id === 'ITEM-0001');
  eq(listed.stock_status, next, '一覧が古い');
  const created = post('createItem', { name: 'キャッシュ確認用' }, 'T1').data.item;
  assert(post('getItems', {}, 'T1').data.items.some(i => i.item_id === created.item_id), '登録が一覧に出ない');
  assert(post('deleteItem', { item_id: created.item_id }, 'T1').ok);
  assert(!post('getItems', {}, 'T1').data.items.some(i => i.item_id === created.item_id), '削除が一覧に反映されない');
});

t('シートを直接編集した分は、キャッシュが切れるまで出ない（切れれば出る）', () => {
  post('getItems', {}, 'T1');
  const row = itemsSheet()._data.find(r2 => r2[0] === 'ITEM-0001');
  const col = ctx.CONST.ITEM_HEADERS.indexOf('note');
  const old = row[col];
  row[col] = '直接編集';
  try {
    assert(post('getItem', { item_id: 'ITEM-0001' }, 'T1').data.item.note !== '直接編集', 'キャッシュを使っていない');
    delete cacheStore['items:v2:ver'];        // 期限切れの代わり（版が切れれば写しは使われない）
    eq(post('getItem', { item_id: 'ITEM-0001' }, 'T1').data.item.note, '直接編集');
  } finally {
    row[col] = old;
    delete cacheStore['items:v2:ver'];
  }
});

t('キャッシュの上限（1 件 100KB）を超える一覧も分割して保存・復元できる', () => {
  const sheet = itemsSheet();
  const base = sheet._data.length;
  const H = ctx.CONST.ITEM_HEADERS;
  for (let i = 0; i < 400; i++) {
    const r2 = H.map(() => '');
    r2[H.indexOf('item_id')] = 'BULK-' + i;
    r2[H.indexOf('name')] = '全角の長い名前'.repeat(20) + i;   // 1 件あたり約 400 バイト
    r2[H.indexOf('is_deleted')] = false;
    sheet._data.push(r2);
  }
  delete cacheStore['items:v2:ver'];
  try {
    const first = post('getItems', { keyword: 'BULK' }, 'T1');
    eq(first.data.total, 400);
    const head = cacheStore['items:v2:' + cacheStore['items:v2:ver']];
    assert(Number(head) > 1, '分割されていない: ' + head);
    const second = timed('getItems', { keyword: 'BULK' });
    assert(/items\(cache\)/.test(second.timing.laps), second.timing.laps);
    eq(second.data.items, first.data.items, '復元した一覧が違う');
  } finally {
    sheet._data.splice(base);
    delete cacheStore['items:v2:ver'];
  }
});

/**
 * シートの全体読み込み（getDataRange().getValues()）の直後に、1 度だけ during() を割り込ませる。
 * 読み取りが古い内容を持ったまま、その間に書き込みが終わる状況を作る。
 */
function interleaveAfterRead(sheet, during) {
  const orig = sheet.getDataRange;
  sheet.getDataRange = () => ({
    getValues: () => {
      const values = orig().getValues();
      sheet.getDataRange = orig;               // 割り込ませるのは 1 度だけ（書き込み側の読み込みは素通し）
      during();
      return values;
    }
  });
  return () => { sheet.getDataRange = orig; };
}

t('一覧を読み直している途中に更新が入っても、古い一覧を写しとして使い続けない', () => {
  delete cacheStore['items:v2:ver'];          // 写しが無い状態から読み直させる
  const cur = post('getItem', { item_id: 'ITEM-0001' }, 'T1');   // この読み込みで写しができる
  delete cacheStore['items:v2:ver'];
  const next = cur.data.item.stock_status === '在庫なし' ? '余裕あり' : '在庫なし';
  const restore = interleaveAfterRead(itemsSheet(), () => {
    assert(post('updateStatus', { item_id: 'ITEM-0001', stock_status: next }, 'T1').ok, '割り込みの更新に失敗');
  });
  try {
    const during = post('getItems', {}, 'T1');   // 更新前の内容を読んだ読み取り
    assert(during.ok, JSON.stringify(during));
  } finally { restore(); }
  eq(post('getItem', { item_id: 'ITEM-0001' }, 'T1').data.item.stock_status, next, '単票が古いまま');
  eq(post('getItems', {}, 'T1').data.items.find(i => i.item_id === 'ITEM-0001').stock_status, next, '一覧が古いまま');
});

t('履歴を読み直している途中に追記されても、古い履歴を写しとして使い続けない', () => {
  const before = post('getItem', { item_id: 'ITEM-0001', withLogs: true }, 'T1').data;
  delete cacheStore['logs:v2:ITEM-0001:ver'];  // 履歴の写しが無い状態にする
  const next = before.item.stock_status === '在庫なし' ? '余裕あり' : '在庫なし';
  const restore = interleaveAfterRead(BOOK.getSheetByName('logs'), () => {
    assert(post('updateStatus', { item_id: 'ITEM-0001', stock_status: next }, 'T1').ok, '割り込みの更新に失敗');
  });
  try {
    assert(post('getItem', { item_id: 'ITEM-0001', withLogs: true }, 'T1').ok);
  } finally { restore(); }
  const after = post('getItem', { item_id: 'ITEM-0001', withLogs: true }, 'T1').data;
  eq(after.logs[0].action_type, 'UPDATE_STATUS');
  assert(after.logs[0].after_state.indexOf(next) !== -1, '最新の履歴が出ない: ' + after.logs[0].after_state);
});

t('更新系の API は追記した履歴を返し、それは次に取得する履歴の先頭と同じ', () => {
  const cur = post('getItem', { item_id: 'ITEM-0001' }, 'T1').data.item;
  const next = cur.stock_status === '在庫なし' ? '余裕あり' : '在庫なし';
  const st = post('updateStatus', { item_id: 'ITEM-0001', stock_status: next }, 'T1').data;
  eq(st.log, post('getItem', { item_id: 'ITEM-0001', withLogs: true }, 'T1').data.logs[0], 'updateStatus');
  const up = post('updateItem', { item_id: 'ITEM-0001', note: '履歴の確認' }, 'T1').data;
  eq(up.log, post('getItem', { item_id: 'ITEM-0001', withLogs: true }, 'T1').data.logs[0], 'updateItem');
  const cr = post('createItem', { name: '履歴の確認用' }, 'T1').data;
  eq(cr.log, post('getItem', { item_id: cr.item.item_id, withLogs: true }, 'T1').data.logs[0], 'createItem');
  const del = post('deleteItem', { item_id: cr.item.item_id }, 'T1').data;
  eq(del.log.action_type, 'DELETE');
});

t('履歴の採番は覚えた連番を使い、忘れてもシートから続きを取る', () => {
  const ids = [];
  for (let i = 0; i < 2; i++) {
    post('updateStatus', { item_id: 'ITEM-0001', stock_status: i % 2 ? '余裕あり' : '残りわずか' }, 'T1');
  }
  Object.keys(cacheStore).filter(k => k.startsWith('logseq:')).forEach(k => delete cacheStore[k]); // 忘れさせる
  post('updateStatus', { item_id: 'ITEM-0001', stock_status: '在庫なし' }, 'T1');
  const all = BOOK.getSheetByName('logs')._data.slice(1).map(r2 => r2[0]);
  eq(new Set(all).size, all.length, 'log_id が重複: ' + all.join(','));
  all.forEach(id => assert(/^LOG-\d{8}-\d{3}$/.test(id), '形式不正: ' + id));
});

t('doGet が疎通確認 JSON を返す', () => {
  const r = JSON.parse(ctx.doGet({}).getContent());
  assert(r.ok && r.data.status === 'running', JSON.stringify(r));
});

console.log('\n===== ' + pass + ' passed / ' + fail + ' failed =====\n');
process.exit(fail ? 1 : 0);
