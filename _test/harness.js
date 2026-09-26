/**
 * GAS コードの結合テスト用ハーネス（リポジトリには含めなくてよい）
 * Apps Script のサービスをモックし、doPost を素の Node で走らせる。
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

/* ---------- スプレッドシートのモック ---------- */
// 本物と同じく、「=」で始まる文字を書くと数式になり（getValues は計算結果、getFormulas は数式を返す）、
// 「'」で始まる文字を書くと、「'」を除いた文字のまま置かれる。数式のセルは { f: 数式, v: 計算結果 } で持つ。
// 数字だけの文字（「001」など）は、本物と同じく数値に変わる（自動変換）
function cellIn(v) {
  if (typeof v === 'string' && v.charAt(0) === '=') return { f: v, v: '(計算結果)' };
  if (typeof v === 'string' && v.charAt(0) === "'") return v.slice(1);
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}
function cellOut(v) { return (v && typeof v === 'object' && 'f' in v) ? v.v : v; }
function cellFormula(v) { return (v && typeof v === 'object' && 'f' in v) ? v.f : ''; }

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
        const c = r.map(cellOut);
        while (c.length < w) c.push('');
        return c;
      })
    }),
    appendRow: (row) => { data.push(row.map(cellIn)); return api; },
    getRange: (r, c, nr, nc) => {
      // A1 表記の列全体（例: H2:H）にも対応する
      if (typeof r === 'string') {
        const m = /^([A-Z])(\d+):([A-Z])$/.exec(r);
        if (!m) throw new Error('mock: unsupported A1 ' + r);
        const row = Number(m[2]);
        return api._range(row, m[1].charCodeAt(0) - 64, Math.max(data.length - row + 1, 1), m[3].charCodeAt(0) - m[1].charCodeAt(0) + 1);
      }
      return api._range(r, c, nr, nc);
    },
    _range: (r, c, nr, nc) => ({
      getValues: () => {
        const out = [];
        for (let i = 0; i < (nr || 1); i++) {
          const row = data[r - 1 + i] || [];
          const seg = [];
          for (let j = 0; j < (nc || 1); j++) seg.push(row[c - 1 + j] === undefined ? '' : cellOut(row[c - 1 + j]));
          out.push(seg);
        }
        return out;
      },
      getValue: () => { const row = data[r - 1] || []; return row[c - 1] === undefined ? '' : cellOut(row[c - 1]); },
      getFormulas: () => {
        const out = [];
        for (let i = 0; i < (nr || 1); i++) {
          const row = data[r - 1 + i] || [];
          const seg = [];
          for (let j = 0; j < (nc || 1); j++) seg.push(cellFormula(row[c - 1 + j]));
          out.push(seg);
        }
        return out;
      },
      // 本物の TextFinder と同じく、範囲の中で text を部分一致で探す（大文字小文字を区別。正規表現も可）
      createTextFinder: (text) => ({
        regex: false,
        matchCase() { return this; },
        useRegularExpression(on) { this.regex = on; return this; },
        findAll() {
          const out = [];
          const hit = this.regex ? (v) => new RegExp(text).test(v) : (v) => v.includes(text);
          for (let i = 0; i < (nr || 1); i++) {
            for (let j = 0; j < (nc || 1); j++) {
              const v = cellOut((data[r - 1 + i] || [])[c - 1 + j]);
              if (v !== undefined && hit(String(v))) {
                out.push({ getRow: () => r + i, getColumn: () => c + j, getValue: () => v });
              }
            }
          }
          return out;
        }
      }),
      setValue: (v) => {
        while (data.length < r) data.push([]);
        data[r - 1][c - 1] = cellIn(v);
      },
      setValues: (vals) => {
        vals.forEach((row, i) => {
          while (data.length < r + i) data.push([]);
          row.forEach((v, j) => { data[r - 1 + i][c - 1 + j] = cellIn(v); });
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
const triggers = [];
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
  ScriptApp: {
    getProjectTriggers: () => triggers.slice(),
    deleteTrigger: (tr) => { triggers.splice(triggers.indexOf(tr), 1); },
    newTrigger: (handler) => ({
      forSpreadsheet: (id) => ({
        onChange: () => ({
          create: () => {
            const tr = { handler, id, type: 'onChange', getHandlerFunction: () => handler };
            triggers.push(tr);
            return tr;
          }
        })
      })
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
['Config.gs', 'Util.gs', 'Auth.gs', 'Repository.gs', 'Op.gs', 'Photo.gs', 'Api.gs', 'Setup.gs'].forEach(f => {
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
  eq(BOOK.getSheetByName('items')._data[0], ctx.CONST.ITEM_HEADERS.concat(ctx.CONST.ITEM_EXTRA_HEADERS));
  eq(BOOK.getSheetByName('logs')._data[0], ctx.CONST.LOG_HEADERS.concat(ctx.CONST.LOG_EXTRA_HEADERS));
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

t('変更トリガーが呼ばれれば、シートを直接編集した備品と履歴がすぐ出る', () => {
  post('getItem', { item_id: 'ITEM-0001', withLogs: true }, 'T1');   // 写しを作る
  const row = itemsSheet()._data.find(r2 => r2[0] === 'ITEM-0001');
  const col = ctx.CONST.ITEM_HEADERS.indexOf('note');
  const old = row[col];
  const logs = BOOK.getSheetByName('logs')._data;
  const logRow = logs.map(r2 => r2[2]).lastIndexOf('ITEM-0001');
  assert(logRow > 0, '確認用の履歴が無い');
  const removed = logs.splice(logRow, 1)[0];                       // 最新の履歴の行を直接消す
  row[col] = '直接編集(トリガー)';
  try {
    const stale = post('getItem', { item_id: 'ITEM-0001', withLogs: true }, 'T1').data;
    assert(stale.item.note !== '直接編集(トリガー)', 'キャッシュを使っていない');
    eq(stale.logs[0].log_id, removed[0], '履歴もキャッシュのはず');
    ctx.onSheetChange({ changeType: 'EDIT' });
    const fresh = post('getItem', { item_id: 'ITEM-0001', withLogs: true }, 'T1').data;
    eq(fresh.item.note, '直接編集(トリガー)', '単票が古い');
    assert(fresh.logs.every(l => l.log_id !== removed[0]), '消した履歴が出る');
    eq(post('getItems', {}, 'T1').data.items.find(i => i.item_id === 'ITEM-0001').note, '直接編集(トリガー)', '一覧が古い');
  } finally {
    row[col] = old;
    logs.splice(logRow, 0, removed);
    ctx.onSheetChange({ changeType: 'EDIT' });
  }
});

t('installSheetTrigger は何度実行しても変更トリガーを 1 つだけ登録する', () => {
  triggers.push({ getHandlerFunction: () => 'otherJob' });         // 他のトリガーは消さない
  ctx.installSheetTrigger();
  ctx.installSheetTrigger();
  const mine = triggers.filter(tr => tr.getHandlerFunction() === 'onSheetChange');
  eq(mine.length, 1, '変更トリガーの数');
  eq([mine[0].id, mine[0].type], [propsStore.SPREADSHEET_ID, 'onChange']);
  assert(typeof ctx[mine[0].handler] === 'function', '呼び先の関数が無い');
  assert(triggers.some(tr => tr.getHandlerFunction() === 'otherJob'), '他のトリガーを消した');
  assert(/変更トリガー（任意） : 登録済み/.test(ctx.diagnose()), '診断に出ない');
  triggers.length = 0;
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

/* ---------- 保存の途中失敗と再送（PLAN-2 項目 1） ---------- */
console.log('\n[保存の途中失敗と再送]');

let opSeq = 0;
function newOpId() { return 'op-test-' + (++opSeq) + '-' + Date.now(); }
function postOp(action, payload, opId, attempt, token) {
  return post(action, Object.assign({}, payload, { op_id: opId, op_attempt: attempt }), token === undefined ? 'T1' : token);
}
function itemRows() { return itemsSheet()._data.slice(1).filter(r => r[0]); }
function logRows() { return BOOK.getSheetByName('logs')._data.slice(1); }
function logsOfOp(opId) { return logRows().filter(r => String(r[7] || '').split(':')[0] === opId); }
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
/** Drive への保存を 1 度だけ失敗させる */
function failDriveOnce() {
  const orig = ctx.DriveApp.getFolderById;
  ctx.DriveApp.getFolderById = () => { ctx.DriveApp.getFolderById = orig; throw new Error('Drive が一時的に使えません'); };
  return () => { ctx.DriveApp.getFolderById = orig; };
}
/** 履歴の追記を 1 度だけ失敗させる */
function failLogAppendOnce() {
  const sh = BOOK.getSheetByName('logs');
  const orig = sh.appendRow;
  sh.appendRow = () => { sh.appendRow = orig; throw new Error('Service Spreadsheets failed'); };
  return () => { sh.appendRow = orig; };
}

t('応答が失われて送り直した登録は、二重に登録せず最初の結果を返す', () => {
  const op = newOpId();
  const items0 = itemRows().length, logs0 = logRows().length;
  const first = postOp('createItem', { name: '再送確認A', location: '棚1' }, op, 1);
  assert(first.ok, JSON.stringify(first));
  const again = postOp('createItem', { name: '再送確認A', location: '棚1' }, op, 2);   // 応答が届かず送り直した
  assert(again.ok && again.data.replayed, JSON.stringify(again));
  eq(again.data.item.item_id, first.data.item.item_id, '別の備品になった');
  eq(again.data.log.log_id, first.data.log.log_id, '別の履歴になった');
  eq(itemRows().length, items0 + 1, '備品が重複した');
  eq(logRows().length, logs0 + 1, '履歴が重複した');
});

t('1 回目の送信が 2 度届いても（ブラウザ自身の送り直し）、二重に登録しない', () => {
  const op = newOpId();
  const items0 = itemRows().length;
  const a = postOp('createItem', { name: '二度届く登録' }, op, 1);
  const b = postOp('createItem', { name: '二度届く登録' }, op, 1);
  assert(a.ok && b.ok && b.data.replayed, JSON.stringify(b));
  eq(b.data.item.item_id, a.data.item.item_id);
  eq(itemRows().length, items0 + 1);
  eq(logsOfOp(op).length, 1);
});

t('完了済みの記録が備品から片付けられた後に 1 回目の送信が再び届いても、二重に実行しない。内容が違えば断る', () => {
  const op = newOpId();
  const payload = { name: '片付け後の再到着' };
  const first = postOp('createItem', payload, op, 1).data.item;
  for (let i = 0; i < 35; i++) assert(postOp('updateItem', { item_id: first.item_id, note: 'n' + i }, newOpId(), 1).ok);
  const opIdsCol = itemsSheet()._data[0].indexOf('op_ids');
  const marks = String(itemRows().find(r2 => r2[0] === first.item_id)[opIdsCol]).split(' ');
  assert(!marks.some(m => m.split(':')[0] === op), '前提: 最初の記録が片付けられていない');
  const items0 = itemRows().length, logs0 = logRows().length;
  const again = postOp('createItem', payload, op, 1);             // 同じ op_id・内容・op_attempt:1 が再び届く
  assert(again.ok && again.data.replayed, JSON.stringify(again));
  eq(again.data.item.item_id, first.item_id);
  const changed = postOp('createItem', { name: '別の内容' }, op, 1);
  assert(!changed.ok && changed.error.code === 'OP_MISMATCH', JSON.stringify(changed));
  eq(itemRows().length, items0, '備品が増えた');
  eq(logRows().length, logs0, '履歴が増えた');
});

t('操作の確認で履歴を探すのは、どの送信でも 1 回だけ（行数を数える呼び出しもしない）', () => {
  const logs = BOOK.getSheetByName('logs');
  const orig = logs.getRange, origLast = logs.getLastRow;
  let finds = 0, lastRows = 0;
  logs.getRange = (...a) => { const rg = orig(...a); const tf = rg.createTextFinder;
    if (tf) rg.createTextFinder = (x) => { finds++; return tf(x); }; return rg; };
  logs.getLastRow = () => { lastRows++; return origLast(); };
  try {
    const first = postOp('createItem', { name: '検索の回数' }, newOpId(), 1);
    assert(first.ok, JSON.stringify(first));
    eq(finds, 1, '新しい操作の検索回数');
    finds = 0;
    const op = newOpId();
    assert(postOp('updateItem', { item_id: first.data.item.item_id, note: 'x' }, op, 1).ok);
    finds = 0;
    assert(postOp('updateItem', { item_id: first.data.item.item_id, note: 'x' }, op, 2).data.replayed);
    eq(finds, 1, '済んだ操作の送り直しの検索回数');
  } finally { logs.getRange = orig; logs.getLastRow = origLast; }
});

t('届かなかった送信を送り直すと、1 回だけ実行する', () => {
  const op = newOpId();
  const items0 = itemRows().length;
  const r = postOp('createItem', { name: '再送確認B' }, op, 2);   // 1 回目はサーバーに届かなかった
  assert(r.ok && !r.data.replayed, JSON.stringify(r));
  eq(itemRows().length, items0 + 1);
  eq(logsOfOp(op).length, 1);
});

t('同じ操作 ID を別の内容・別の利用者で送ると OP_MISMATCH で断り、何も保存しない', () => {
  const op = newOpId();
  const first = postOp('createItem', { name: '再送確認C' }, op, 1).data.item;
  const items0 = itemRows().length, logs0 = logRows().length;
  const changed = postOp('createItem', { name: '再送確認C（直した）' }, op, 2);
  assert(!changed.ok && changed.error.code === 'OP_MISMATCH' && changed.error.status === 409, JSON.stringify(changed));
  eq(changed.error.data.item.item_id, first.item_id, '済んでいた備品を返していない');
  assert(!changed.error.maybeSaved, '何も書いていないのに maybeSaved');
  groupMembers.push('hanako@example.com');
  tokenInfoResponse = validToken('hanako@example.com');
  const other = postOp('createItem', { name: '再送確認C' }, op, 2, 'T-hanako');
  tokenInfoResponse = validToken('taro@example.com');
  assert(!other.ok && other.error.code === 'OP_MISMATCH', '別の利用者の送り直しを受け付けた: ' + JSON.stringify(other));
  eq(itemRows().length, items0);
  eq(logRows().length, logs0);
});

t('写真の形式が不正な登録は、備品を作らずに失敗する（保存前の失敗）', () => {
  const items0 = itemRows().length;
  const r = postOp('createItem', { name: '写真不正', photo: { data: 'AAAA', mimeType: 'image/gif' } }, newOpId(), 1);
  assert(!r.ok && r.error.code === 'PHOTO_TYPE_UNSUPPORTED', JSON.stringify(r));
  assert(!r.error.maybeSaved, '保存前の失敗なのに maybeSaved');
  eq(itemRows().length, items0);
});

t('登録で写真だけ保存できなかったら、備品は登録して photoError を返し、送り直しで写真だけ保存する', () => {
  const op = newOpId();
  const payload = { name: '写真失敗', photo: { data: PNG, mimeType: 'image/png', filename: 'a.png' } };
  const items0 = itemRows().length;
  const restore = failDriveOnce();
  let first;
  try { first = postOp('createItem', payload, op, 1); } finally { restore(); }
  assert(first.ok && first.data.photoError, JSON.stringify(first));
  eq(first.data.item.photo_url, '', '写真の URL が入っている');
  eq(itemRows().length, items0 + 1);
  const again = postOp('createItem', payload, op, 2);
  assert(again.ok && again.data.replayed && !again.data.photoError, JSON.stringify(again));
  eq(again.data.item.item_id, first.data.item.item_id);
  assert(/^https:\/\/lh3\.googleusercontent\.com\/d\//.test(again.data.item.photo_url), '写真が保存されない: ' + again.data.item.photo_url);
  eq(itemRows().length, items0 + 1, '写真の送り直しで備品が増えた');
  eq(logsOfOp(op).length, 1, '履歴が重複した');
  // 写真だけを別の操作（編集）で送り直しても、備品は増えない
  const up = postOp('updateItem', { item_id: first.data.item.item_id, photo: payload.photo }, newOpId(), 1);
  assert(up.ok, JSON.stringify(up));
  eq(itemRows().length, items0 + 1);
});

t('登録で履歴の追記に失敗したら maybeSaved を返し、送り直しで履歴だけ追記する', () => {
  const op = newOpId();
  const items0 = itemRows().length;
  const restore = failLogAppendOnce();
  let first;
  try { first = postOp('createItem', { name: '履歴失敗' }, op, 1); } finally { restore(); }
  assert(!first.ok && first.error.maybeSaved, JSON.stringify(first));
  eq(itemRows().length, items0 + 1, '備品の行は書かれているはず');
  eq(logsOfOp(op).length, 0);
  const again = postOp('createItem', { name: '履歴失敗' }, op, 2);
  assert(again.ok && again.data.replayed, JSON.stringify(again));
  eq(again.data.item.name, '履歴失敗');
  eq(again.data.log.action_type, 'CREATE');
  eq(itemRows().length, items0 + 1, '送り直しで備品が増えた');
  eq(logsOfOp(op).length, 1, '履歴が 1 件になっていない');
  const third = postOp('createItem', { name: '履歴失敗' }, op, 3);
  eq(third.data.log.log_id, again.data.log.log_id, '3 回目で履歴が増えた');
  eq(logsOfOp(op).length, 1);
});

t('ステータス更新・編集・削除も、送り直しで二重に実行しない', () => {
  const id = postOp('createItem', { name: '更新の再送' }, newOpId(), 1).data.item.item_id;
  const logsOf = () => logRows().filter(r => r[2] === id).length;
  const base = logsOf();

  const op1 = newOpId();
  assert(postOp('updateStatus', { item_id: id, stock_status: '在庫なし' }, op1, 1).ok);
  const st = postOp('updateStatus', { item_id: id, stock_status: '在庫なし' }, op1, 2);
  assert(st.ok && st.data.replayed, JSON.stringify(st));

  const op2 = newOpId();
  const restore = failLogAppendOnce();
  let upd;
  try { upd = postOp('updateItem', { item_id: id, note: '途中で失敗' }, op2, 1); } finally { restore(); }
  assert(!upd.ok && upd.error.maybeSaved, JSON.stringify(upd));
  const upd2 = postOp('updateItem', { item_id: id, note: '途中で失敗' }, op2, 2);
  assert(upd2.ok && upd2.data.replayed && upd2.data.item.note === '途中で失敗', JSON.stringify(upd2));

  const op3 = newOpId();
  assert(postOp('deleteItem', { item_id: id }, op3, 1).ok);
  const del = postOp('deleteItem', { item_id: id }, op3, 2);
  assert(del.ok && del.data.replayed, JSON.stringify(del));

  eq(logsOf(), base + 3, '履歴の件数（ステータス・編集・削除の 1 件ずつ）');
});

t('履歴が 500 件を超え、同じ備品に後から更新が入った後の送り直しでも、二重に実行しない', () => {
  const opCreate = newOpId();
  const created = postOp('createItem', { name: '古い操作の再送' }, opCreate, 1).data.item;
  const opStatus = newOpId();
  assert(postOp('updateStatus', { item_id: created.item_id, stock_status: '残りわずか' }, opStatus, 1).ok);
  assert(postOp('updateItem', { item_id: created.item_id, note: '後からの更新' }, newOpId(), 1).ok); // 同じ備品に後から書き込む
  const logs = BOOK.getSheetByName('logs');
  const filler = [];
  for (let i = 0; i < 501; i++) filler.push(['LOG-FILL-' + i, '2026-09-26 00:00:00', 'ITEM-9999', 'x@example.com', 'UPDATE', '', '', 'fill-' + i + ':x']);
  logs._data.push(...filler);                                   // 別の備品の履歴が 501 件増えた
  const items0 = itemRows().length, logs0 = logRows().length;
  try {
    const c = postOp('createItem', { name: '古い操作の再送' }, opCreate, 2);
    assert(c.ok && c.data.replayed, '登録の再送: ' + JSON.stringify(c));
    eq(c.data.item.item_id, created.item_id);
    const s = postOp('updateStatus', { item_id: created.item_id, stock_status: '残りわずか' }, opStatus, 2);
    assert(s.ok && s.data.replayed, 'ステータス更新の再送: ' + JSON.stringify(s));
    eq(itemRows().length, items0, '備品が増えた');
    eq(logRows().length, logs0, '履歴が増えた');
    eq(s.data.item.note, '後からの更新', '後からの更新を戻した');
  } finally {
    logs._data.splice(logs._data.length - filler.length - (logRows().length - logs0), filler.length);
  }
});

/** 別の利用者（hanako）として送る */
function asHanako(fn) {
  if (groupMembers.indexOf('hanako@example.com') === -1) groupMembers.push('hanako@example.com');
  tokenInfoResponse = validToken('hanako@example.com');
  try { return fn('T-hanako'); } finally { tokenInfoResponse = validToken('taro@example.com'); }
}

t('登録の履歴の追記に失敗し、別の利用者が同じ備品を更新した後でも、登録した人の送り直しで履歴だけを補う', () => {
  const op = newOpId();
  const items0 = itemRows().length;
  const restore = failLogAppendOnce();
  let first;
  try { first = postOp('createItem', { name: '途中で止まった登録' }, op, 1); } finally { restore(); }
  assert(!first.ok && first.error.maybeSaved, JSON.stringify(first));
  const row = itemRows().find(r2 => r2[1] === '途中で止まった登録');
  assert(row, '備品の行が無い');
  const other = asHanako(tok => postOp('updateItem', { item_id: row[0], note: '別の人の更新' }, newOpId(), 1, tok));
  assert(other.ok && other.data.item.updated_by === 'hanako@example.com', JSON.stringify(other));
  const stolen = asHanako(tok => postOp('createItem', { name: '途中で止まった登録' }, op, 2, tok));
  assert(!stolen.ok && stolen.error.code === 'OP_MISMATCH', '別の人の送り直しを受け付けた: ' + JSON.stringify(stolen));
  const again = postOp('createItem', { name: '途中で止まった登録' }, op, 2);
  assert(again.ok && again.data.replayed, JSON.stringify(again));
  eq(again.data.item.item_id, row[0]);
  eq(again.data.item.note, '別の人の更新', '後からの更新を戻した');
  eq(again.data.log.user_email, 'taro@example.com', '補った履歴の利用者');
  eq(JSON.parse(again.data.log.after_state).name, '途中で止まった登録');
  eq(itemRows().length, items0 + 1, '備品が増えた');
  eq(logsOfOp(op).length, 1, '登録の履歴が 1 件になっていない');
});

t('更新の履歴の追記に失敗し、別の利用者が同じ備品を更新した後の送り直しは、再実行せず後の値を保つ', () => {
  const id = postOp('createItem', { name: '途中で止まった更新', stock_status: '余裕あり' }, newOpId(), 1).data.item.item_id;
  [['updateStatus', { item_id: id, stock_status: '在庫なし' }, 'stock_status', '残りわずか'],
   ['updateItem', { item_id: id, note: '最初の人の備考' }, 'note', '後の人の備考']].forEach(([action, payload, key, laterValue]) => {
    const op = newOpId();
    const restore = failLogAppendOnce();
    let first;
    try { first = postOp(action, payload, op, 1); } finally { restore(); }
    assert(!first.ok && first.error.maybeSaved, action + ': ' + JSON.stringify(first));
    const later = asHanako(tok => postOp('updateItem', { item_id: id, [key]: laterValue }, newOpId(), 1, tok));
    assert(later.ok, JSON.stringify(later));
    const logs0 = logRows().length;
    const again = postOp(action, payload, op, 2);
    assert(again.ok && again.data.replayed, action + ' の送り直し: ' + JSON.stringify(again));
    eq(again.data.item[key], laterValue, action + ': 後の人の値を戻した');
    eq(itemRows().find(r2 => r2[0] === id)[ctx.CONST.ITEM_HEADERS.indexOf(key)], laterValue, action + ': シートの値');
    eq(logRows().length, logs0 + 1, action + ': 補う履歴は 1 件');
    eq(logsOfOp(op).length, 1, action + ': 操作の履歴が 1 件になっていない');
    eq(JSON.parse(again.data.log.after_state)[key], payload[key], action + ': 補った履歴は送った内容');
    const third = postOp(action, payload, op, 3);
    eq(third.data.log.log_id, again.data.log.log_id, action + ': 3 回目で履歴が増えた');
  });
});

t('履歴の無い操作の記録は、同じ備品が何度更新されても消えない。履歴のある古い記録は片付ける', () => {
  const id = postOp('createItem', { name: '記録の片付け' }, newOpId(), 1).data.item.item_id;
  const op = newOpId();
  const restore = failLogAppendOnce();
  try { postOp('updateItem', { item_id: id, note: '履歴の無い更新' }, op, 1); } finally { restore(); }
  for (let i = 0; i < 45; i++) assert(postOp('updateItem', { item_id: id, note: 'n' + i }, newOpId(), 1).ok);
  const opIdsCol = itemsSheet()._data[0].indexOf('op_ids');
  const marks = String(itemRows().find(r2 => r2[0] === id)[opIdsCol]).split(' ');
  assert(marks.length <= 31, '記録が片付いていない: ' + marks.length);
  assert(marks.some(m => m.split(':')[0] === op), '履歴の無い記録が消えた');
  const again = postOp('updateItem', { item_id: id, note: '履歴の無い更新' }, op, 2);
  assert(again.ok && again.data.replayed, JSON.stringify(again));
  eq(again.data.item.note, 'n44', '後の値を戻した');
});

t('行は 1 回の書き込みで書き、アプリが知らない列の値も保つ', () => {
  const sh = itemsSheet();
  const id = postOp('createItem', { name: '1 回で書く' }, newOpId(), 1).data.item.item_id;
  const extraCol = sh._data[0].length;
  sh._data[0][extraCol] = '手で足した列';
  sh._data.find(r2 => r2[0] === id)[extraCol] = '手で書いた値';
  delete cacheStore['items:v2:ver'];
  const orig = sh.getRange;
  let writes = 0;
  sh.getRange = (...a) => { const rg = orig(...a); const sv = rg.setValues, s1 = rg.setValue;
    rg.setValues = (v) => { writes++; return sv(v); }; rg.setValue = (v) => { writes++; return s1(v); }; return rg; };
  try {
    assert(postOp('updateItem', { item_id: id, note: 'x', location: 'y' }, newOpId(), 1).ok);
  } finally { sh.getRange = orig; }
  eq(writes, 1, '行の書き込み回数');
  eq(sh._data.find(r2 => r2[0] === id)[extraCol], '手で書いた値', '知らない列の値が消えた');
  sh._data.forEach(r2 => { r2.length = Math.min(r2.length, extraCol); });
  delete cacheStore['items:v2:ver'];
});

t('備品を更新しても、アプリが書き換えない列の数式と「=」で始まる文字を保つ。入力の「=」は数式にしない', () => {
  const sh = itemsSheet();
  const id = postOp('createItem', { name: '数式を保つ', note: '=1+1' }, newOpId(), 1).data.item.item_id;
  const row = () => sh._data.find(r2 => r2[0] === id);
  const noteCol = ctx.CONST.ITEM_HEADERS.indexOf('note');
  eq(row()[noteCol], '=1+1', '入力の「=」が数式になった');
  const extraCol = sh._data[0].length;
  sh._data[0][extraCol] = '手で足した列';
  sh._data[0][extraCol + 1] = 'メモ';
  row()[extraCol] = { f: '=LEN(B2)', v: 5 };        // 手で入れた数式
  row()[extraCol + 1] = '=数式ではない文字';          // 「'」を付けて手で入れた文字
  delete cacheStore['items:v2:ver'];
  try {
    assert(postOp('updateItem', { item_id: id, location: '棚2', note: '=SUM(1,2)' }, newOpId(), 1).ok);
    eq(cellFormula(row()[extraCol]), '=LEN(B2)', '数式が値に置き換わった');
    eq(row()[extraCol + 1], '=数式ではない文字', '文字が数式になった');
    eq(row()[noteCol], '=SUM(1,2)', '入力の「=」が数式になった（更新）');
    eq(post('getItem', { item_id: id }, 'T1').data.item.note, '=SUM(1,2)');
  } finally {
    sh._data.forEach(r2 => { r2.length = Math.min(r2.length, extraCol); });
    delete cacheStore['items:v2:ver'];
  }
});

t('追加の列が無い既存のシートでも、書き込みのときに列を足して動く', () => {
  const items = itemsSheet();
  const logs = BOOK.getSheetByName('logs');
  const saved = { items: items._data.map(r => r.slice()), logs: logs._data.map(r => r.slice()) };
  const cut = (data, n) => data.forEach((r, i) => { data[i] = r.slice(0, n); });
  cut(items._data, ctx.CONST.ITEM_HEADERS.length);
  cut(logs._data, ctx.CONST.LOG_HEADERS.length);
  delete cacheStore['schema:logs:op_id'];
  delete cacheStore['items:v2:ver'];
  try {
    const op = newOpId();
    const r = postOp('createItem', { name: '旧シート' }, op, 1);
    assert(r.ok, JSON.stringify(r));
    eq(items._data[0].slice(-1), ['op_ids'], 'items に列が足されていない');
    eq(logs._data[0][7], 'op_id', 'logs の 8 列目に op_id がない');
    assert(postOp('createItem', { name: '旧シート' }, op, 2).data.replayed, '足した列で送り直しを判定できない');
    assert(post('getItems', {}, 'T1').data.items.some(i => i.name === '旧シート'), '一覧に出ない');
  } finally {
    items._data.splice(0, items._data.length, ...saved.items);
    logs._data.splice(0, logs._data.length, ...saved.logs);
    delete cacheStore['items:v2:ver'];
  }
});

t('操作 ID の形式が不正なら断る。操作 ID の無い送信（古い画面）はそのまま受け付ける', () => {
  const bad = post('createItem', { name: 'x', op_id: 'bad id!' }, 'T1');
  assert(!bad.ok && bad.error.code === 'BAD_REQUEST', JSON.stringify(bad));
  const legacy = post('createItem', { name: '操作 ID なし' }, 'T1');
  assert(legacy.ok, JSON.stringify(legacy));
});

/* ---------- 同時編集の競合検出（PLAN-2 項目 2） ---------- */
console.log('\n[同時編集の競合検出]');

function getItemOf(id) { return post('getItem', { item_id: id, withLogs: true }, 'T1').data; }

t('一覧・単票・更新の応答に版（version）が付き、読み直した版と一致する（数字だけ・記号の文字も）', () => {
  const r = postOp('createItem', { name: '001', location: '3-2', note: '=x', quantity: 4 }, newOpId(), 1);
  assert(r.ok && /^[0-9a-f]{16}$/.test(r.data.item.version), JSON.stringify(r.data.item));
  const got = getItemOf(r.data.item.item_id).item;
  eq(got.name, '001', '数字だけの文字が数値に変わった');
  eq(got.version, r.data.item.version, '登録の応答の版と読み直した版');
  const up = postOp('updateItem', { item_id: got.item_id, note: '007', base_version: got.version }, newOpId(), 1);
  assert(up.ok, JSON.stringify(up));
  eq(getItemOf(got.item_id).item.version, up.data.item.version, '更新の応答の版と読み直した版');
  assert(post('getItems', {}, 'T1').data.items.every(i => /^[0-9a-f]{16}$/.test(i.version)), '一覧に版が無い');
});

t('古い版で保存すると、何も書かずに CONFLICT で最新の備品を返す。最新の版で送り直せば保存できる', () => {
  const base = getItemOf(postOp('createItem', { name: '競合A', quantity: 3, note: '最初' }, newOpId(), 1).data.item.item_id).item;
  // A（taro）が数量を変える
  const a = postOp('updateItem', { item_id: base.item_id, quantity: 5, base_version: base.version }, newOpId(), 1);
  assert(a.ok, JSON.stringify(a));
  // 古い画面の B（hanako）が備考だけを保存する
  const sheetBefore = JSON.stringify(itemsSheet()._data), logs0 = logRows().length;
  const b = asHanako(tok => postOp('updateItem', { item_id: base.item_id, note: 'B の備考', base_version: base.version }, newOpId(), 1, tok));
  assert(!b.ok && b.error.code === 'CONFLICT' && b.error.status === 409, JSON.stringify(b));
  assert(!b.error.maybeSaved, '何も書いていないのに maybeSaved');
  eq(b.error.data.item.quantity, 5, '最新の備品を返していない');
  eq(JSON.stringify(itemsSheet()._data), sheetBefore, 'シートが変わった');
  eq(logRows().length, logs0, '履歴が増えた');
  // B が最新を確かめて送り直す
  const b2 = asHanako(tok => postOp('updateItem', { item_id: base.item_id, note: 'B の備考', base_version: b.error.data.item.version }, newOpId(), 1, tok));
  assert(b2.ok, JSON.stringify(b2));
  const now = getItemOf(base.item_id).item;
  eq([now.quantity, now.note], [5, 'B の備考'], 'A の数量が消えた');
});

t('ステータス更新・削除も、古い版なら CONFLICT で止める', () => {
  const it = getItemOf(postOp('createItem', { name: '競合B' }, newOpId(), 1).data.item.item_id).item;
  assert(postOp('updateStatus', { item_id: it.item_id, stock_status: '在庫なし', base_version: it.version }, newOpId(), 1).ok);
  const st = postOp('updateStatus', { item_id: it.item_id, stock_status: '残りわずか', base_version: it.version }, newOpId(), 1);
  assert(!st.ok && st.error.code === 'CONFLICT', JSON.stringify(st));
  eq(getItemOf(it.item_id).item.stock_status, '在庫なし');
  const del = postOp('deleteItem', { item_id: it.item_id, base_version: it.version }, newOpId(), 1);
  assert(!del.ok && del.error.code === 'CONFLICT', JSON.stringify(del));
  assert(!getItemOf(it.item_id).item.is_deleted, '削除された');
});

t('シートを直接編集した後に古い版で保存すると CONFLICT で止める', () => {
  const it = getItemOf(postOp('createItem', { name: '直接編集と競合' }, newOpId(), 1).data.item.item_id).item;
  const row = itemsSheet()._data.find(r2 => r2[0] === it.item_id);
  row[ctx.CONST.ITEM_HEADERS.indexOf('location')] = '手で直した場所';
  ctx.onSheetChange({ changeType: 'EDIT' });
  const r = postOp('updateItem', { item_id: it.item_id, note: 'アプリの備考', base_version: it.version }, newOpId(), 1);
  assert(!r.ok && r.error.code === 'CONFLICT', JSON.stringify(r));
  eq(r.error.data.item.location, '手で直した場所');
  eq(row[ctx.CONST.ITEM_HEADERS.indexOf('note')], '', 'アプリの備考が書かれた');
});

t('保存の処理が行を読んだ後、書く前にシートが直接編集されても、上書きせずに CONFLICT で止める', () => {
  const it = getItemOf(postOp('createItem', { name: '読んだ後の直接編集' }, newOpId(), 1).data.item.item_id).item;
  const locCol = ctx.CONST.ITEM_HEADERS.indexOf('location');
  const restore = interleaveAfterRead(itemsSheet(), () => {
    itemsSheet()._data.find(r2 => r2[0] === it.item_id)[locCol] = '読んだ後に手で直した';
  });
  let r;
  try {
    r = postOp('updateItem', { item_id: it.item_id, location: 'アプリの場所', base_version: it.version }, newOpId(), 1);
  } finally { restore(); }
  assert(!r.ok && r.error.code === 'CONFLICT' && !r.error.maybeSaved, JSON.stringify(r));
  eq(itemsSheet()._data.find(r2 => r2[0] === it.item_id)[locCol], '読んだ後に手で直した', '直接編集を上書きした');
});

t('読んだ後に行が挿入されてずれても、内容が同じなら正しい行に書く。内容が違えば最新を、消えていれば null を CONFLICT で返す', () => {
  const H = ctx.CONST.ITEM_HEADERS;
  const sh = itemsSheet();
  const blank = () => { const r2 = H.map(() => ''); r2[H.indexOf('item_id')] = 'INSERTED-' + Math.random(); r2[H.indexOf('name')] = '挿入された行'; return r2; };
  // 1) 上に行が挿入されただけ（内容は同じ）
  const a = getItemOf(postOp('createItem', { name: '行ずれA' }, newOpId(), 1).data.item.item_id).item;
  let restore = interleaveAfterRead(sh, () => { sh._data.splice(1, 0, blank()); });
  let r;
  try { r = postOp('updateItem', { item_id: a.item_id, note: 'ずれた先に書く', base_version: a.version }, newOpId(), 1); } finally { restore(); }
  assert(r.ok, JSON.stringify(r));
  eq(sh._data.find(r2 => r2[0] === a.item_id)[H.indexOf('note')], 'ずれた先に書く', '正しい行に書いていない');
  eq(sh._data[1][H.indexOf('note')], '', '挿入された行に書いた');
  // 2) 行がずれ、内容も直接編集された
  const b = getItemOf(postOp('createItem', { name: '行ずれB' }, newOpId(), 1).data.item.item_id).item;
  restore = interleaveAfterRead(sh, () => {
    sh._data.splice(1, 0, blank());
    sh._data.find(r2 => r2[0] === b.item_id)[H.indexOf('location')] = '手で直した';
  });
  try { r = postOp('updateItem', { item_id: b.item_id, note: 'x', base_version: b.version }, newOpId(), 1); } finally { restore(); }
  assert(!r.ok && r.error.code === 'CONFLICT' && !r.error.maybeSaved, JSON.stringify(r));
  eq(r.error.data.item.location, '手で直した', '最新を返していない');
  eq(sh._data.find(r2 => r2[0] === b.item_id)[H.indexOf('note')], '', '書いた');
  // 3) 対象の行が消された
  const c = getItemOf(postOp('createItem', { name: '行ずれC' }, newOpId(), 1).data.item.item_id).item;
  const before = JSON.stringify(sh._data.filter(r2 => r2[0] !== c.item_id));
  restore = interleaveAfterRead(sh, () => { sh._data.splice(sh._data.findIndex(r2 => r2[0] === c.item_id), 1); });
  try { r = postOp('updateItem', { item_id: c.item_id, note: 'x', base_version: c.version }, newOpId(), 1); } finally { restore(); }
  assert(!r.ok && r.error.code === 'CONFLICT' && r.error.data.item === null, JSON.stringify(r));
  eq(JSON.stringify(sh._data), before, 'シートが変わった');
  sh._data.splice(1, sh._data.length, ...sh._data.slice(1).filter(r2 => !String(r2[0]).startsWith('INSERTED-')));
  delete cacheStore['items:v2:ver'];
});

t('済んだ操作・途中で止まった操作の送り直しは、版が古くても競合にしない（項目 1 との組み合わせ）', () => {
  const it = getItemOf(postOp('createItem', { name: '再送と競合' }, newOpId(), 1).data.item.item_id).item;
  const op1 = newOpId();
  const p1 = { item_id: it.item_id, note: '一度目', base_version: it.version };
  assert(postOp('updateItem', p1, op1, 1).ok);
  const again = postOp('updateItem', p1, op1, 2);          // 版はもう古いが、済んだ操作の送り直し
  assert(again.ok && again.data.replayed, JSON.stringify(again));

  const cur = getItemOf(it.item_id).item;
  const op2 = newOpId();
  const p2 = { item_id: it.item_id, stock_status: '在庫なし', base_version: cur.version };
  const restore = failLogAppendOnce();
  try { assert(!postOp('updateStatus', p2, op2, 1).ok); } finally { restore(); }
  const mid = getItemOf(it.item_id).item;
  assert(asHanako(tok => postOp('updateItem', { item_id: it.item_id, note: 'hanako', base_version: mid.version }, newOpId(), 1, tok)).ok);
  const resend = postOp('updateStatus', p2, op2, 2);        // 途中で止まった操作の送り直し
  assert(resend.ok && resend.data.replayed, JSON.stringify(resend));
  eq(getItemOf(it.item_id).item.note, 'hanako');
});

t('版を送らない古い画面の保存は、確かめずに受け付ける', () => {
  const it = getItemOf(postOp('createItem', { name: '古い画面' }, newOpId(), 1).data.item.item_id).item;
  assert(postOp('updateItem', { item_id: it.item_id, note: 'x' }, newOpId(), 1).ok);
  assert(post('updateItem', { item_id: it.item_id, note: 'y' }, 'T1').ok);
});

/* ---------- 要補充の入口（PLAN-2 項目 5） ---------- */
console.log('\n[要補充]');

t('restock を付けた一覧は「残りわずか」「在庫なし」だけを返し、ほかの絞り込みと併用できる', () => {
  const mk = (name, st, cat) => postOp('createItem', { name, stock_status: st, category: cat }, newOpId(), 1).data.item;
  const a = mk('補充A', '在庫なし', '補充テスト');
  const b = mk('補充B', '残りわずか', '補充テスト');
  const c = mk('補充C', '余裕あり', '補充テスト');
  const d = mk('補充D', '在庫なし', '別カテゴリ');
  const all = post('getItems', { restock: true }, 'T1').data.items;
  assert(all.length > 0 && all.every(i => ['残りわずか', '在庫なし'].includes(i.stock_status)), '要補充以外が出た');
  assert(!all.some(i => i.item_id === c.item_id), '余裕ありが出た');
  const withCat = post('getItems', { restock: true, category: '補充テスト' }, 'T1').data;
  eq(withCat.items.map(i => i.item_id).sort(), [a.item_id, b.item_id].sort(), 'カテゴリとの併用');
  eq(withCat.total, 2, '件数');
  assert(post('getItems', { restock: true, keyword: '補充D' }, 'T1').data.items.some(i => i.item_id === d.item_id), '検索との併用');
  const login = post('loginCheck', { withItems: true, filters: { restock: true, category: '補充テスト' } }, 'T1').data;
  eq(login.total, 2, 'ログイン確認の一覧でも同じ絞り込み');
  eq(post('getItems', { category: '補充テスト' }, 'T1').data.total, 3, 'restock なしは今までどおり');
});

t('doGet が疎通確認 JSON を返す', () => {
  const r = JSON.parse(ctx.doGet({}).getContent());
  assert(r.ok && r.data.status === 'running', JSON.stringify(r));
});

console.log('\n===== ' + pass + ' passed / ' + fail + ' failed =====\n');
process.exit(fail ? 1 : 0);
