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
      put: (k, v) => { cacheStore[k] = v; }
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
    newBlob: (bytes, mime, name) => ({ bytes, mime, name })
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

t('未知の action は 400', () => {
  const r = post('dropTable', {}, 'T1');
  assert(!r.ok && r.error.code === 'UNKNOWN_ACTION', JSON.stringify(r));
});

t('壊れた JSON でも 500 にならず整形されたエラーを返す', () => {
  const out = ctx.doPost({ postData: { contents: '{broken' } });
  const r = JSON.parse(out.getContent());
  assert(!r.ok && r.error.code === 'BAD_REQUEST', JSON.stringify(r));
});

t('doGet が疎通確認 JSON を返す', () => {
  const r = JSON.parse(ctx.doGet({}).getContent());
  assert(r.ok && r.data.status === 'running', JSON.stringify(r));
});

console.log('\n===== ' + pass + ' passed / ' + fail + ' failed =====\n');
process.exit(fail ? 1 : 0);
