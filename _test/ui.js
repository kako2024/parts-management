/**
 * フロントエンドのスモークテスト（リポジトリには含めなくてよい）
 * GAS API と Google Identity Services をモックして、実ブラウザで画面を動かす。
 */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const DOCS = path.join(__dirname, '..', 'docs');
const PORT = 8123;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

/* ---------- 疑似 GAS: メモリ上のデータストア ---------- */
let items = [
  { item_id: 'ITEM-0001', name: 'コピー用紙 A4', category: '事務用品', location: '本館-3F-A棚-2段', stock_status: '余裕あり', quantity: 12, photo_url: '', note: '', updated_at: '2026-08-13 09:00:00', updated_by: 'taro@example.com', is_deleted: false },
  { item_id: 'ITEM-0002', name: 'HDMIケーブル 2m', category: 'IT機器', location: '本館-3F-B棚-1段', stock_status: '残りわずか', quantity: 2, photo_url: '', note: '長さ違いあり', updated_at: '2026-08-13 08:30:00', updated_by: 'hanako@example.com', is_deleted: false },
  { item_id: 'ITEM-0003', name: '乾電池 単3', category: '消耗品', location: '本館-1F-倉庫', stock_status: '在庫なし', quantity: 0, photo_url: '', note: '', updated_at: '2026-08-12 17:10:00', updated_by: 'taro@example.com', is_deleted: false }
];
let logs = [
  { log_id: 'LOG-20260813-001', timestamp: '2026-08-13 09:00:00', item_id: 'ITEM-0001', user_email: 'taro@example.com', action_type: 'CREATE', before_state: '', after_state: '{"name":"コピー用紙 A4","stock_status":"余裕あり"}' }
];

const apiCalls = []; // 呼ばれた action の順（起動時の呼び出し回数の検証用）
const apiDelay = {};  // action ごとの応答の遅れ(ms)。キャッシュで API を待たずに表示できるかの検証用
const apiDrop = {};
const apiLose = {};   // action ごとに、処理した後で応答だけを失わせる回数（送り直しの検証用。Infinity なら消すまで失わせる）
const opCalls = [];   // 操作 ID つきの送信 { action, op_id, op_attempt }
const opResults = {}; // 操作 ID ごとの最初の結果（本物の GAS と同じく、送り直しは二重に実行しない）
const lastPayload = {}; // action ごとに最後に受け取った payload（操作 ID を除く）
let photoFailAt = 0;
let photoWrites = 0;
let photoFail = false; // 登録で写真の保存だけを失敗させる
const conflictNoItem = {}; // action ごとに、最新の備品なしの CONFLICT を返す（行が消えたときの GAS と同じ）
let forbidden = false;     // 真なら、ログイン確認を 403（グループのメンバーではない）で断る
const photoRequests = []; // /mockphoto/ への要求
let photoDelay = 0;       // /mockphoto/ の応答の遅れ(ms)   // action ごとに接続を切って通信エラーにする（失敗時の後始末の検証用）
/** 疑似 ID トークンの email（無ければ taro） */
function tokenEmail(idToken) {
  try { return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64').toString()).email || 'taro@example.com'; }
  catch (e) { return 'taro@example.com'; }
}
/** 履歴を追記して返す（本物の GAS と同じく、更新系の応答に含める） */
function addLog(itemId, type, before, after) {
  const log = {
    log_id: 'LOG-20260813-' + String(logs.length + 1).padStart(3, '0'), timestamp: '2026-08-13 10:05:00',
    item_id: itemId, user_email: 'taro@example.com', action_type: type,
    before_state: typeof before === 'string' ? before : JSON.stringify(before),
    after_state: JSON.stringify(after)
  };
  logs.push(log);
  return log;
}
/** 備品の版（本物は gas/Repository.gs の itemVersion_）。検証が items を直接書き換えても変わる */
const ITEM_FIELDS = ['item_id', 'name', 'category', 'location', 'stock_status', 'quantity', 'photo_url', 'note', 'updated_at', 'updated_by', 'is_deleted'];
function versionOf(it) {
  return require('crypto').createHash('sha1').update(JSON.stringify(ITEM_FIELDS.map(k => it[k] === undefined ? null : it[k]).concat([mockPhotos(it)]))).digest('hex').slice(0, 16);
}
function mockPhotos(it) {
  if (Array.isArray(it.photos)) return it.photos;
  if (!it.photo_url) return [];
  const m = it.photo_url.match(/\/d\/([^/?#]+)/) || it.photo_url.match(/[?&]id=([^&#]+)/);
  let hash = 2166136261;
  for (const c of it.photo_url) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619) >>> 0;
  return [{ id: 'legacy-' + (m ? m[1] : hash.toString(16)), url: it.photo_url }];
}
function withVersion(it) { return it ? Object.assign({}, it, { photos: mockPhotos(it), version: versionOf(it) }) : it; }
function saveMockPhotos(payload, it) {
  if (payload.photos === undefined) return {};
  const old = mockPhotos(it), errors = []; let nth = 0;
  if (payload.photos.length > 4) throw new Error('模擬API: 上限超過');
  const photos = payload.photos.map(p => {
    if (!p.photo) {
      if (!old.some(x => x.id === p.id && x.url === p.url)) throw new Error('模擬API: 不正な既存参照');
      return { id: p.id, url: p.url };
    }
    if (old.some(x => x.id === p.id)) throw new Error('模擬API: 保存済みIDへ画像の再送');
    nth++;
    if (photoFail || nth === photoFailAt) { errors.push({ id: p.id, message: '写真を保存できませんでした（模擬）' }); return null; }
    photoWrites++;
    return { id: p.id, url: 'https://lh3.googleusercontent.com/d/mock-' + photoWrites };
  }).filter(Boolean);
  it.photos = photos;
  it.photo_url = (photos.find(p => p.id === payload.primary_photo_id) || photos[0] || {}).url || '';
  return errors.length ? { photoErrors: errors, photoError: errors.length + '枚失敗' } : {};
}
/** 応答の備品に版を付ける */
function addVersions(res) {
  const d = res.ok ? res.data : res.error && res.error.data;
  if (d && d.item) d.item = withVersion(d.item);
  if (d && d.items) d.items = d.items.map(withVersion);
  return res;
}
/** 画面が読んだときの版と違えば、何もせずに CONFLICT（本物は assertBaseVersion_） */
function conflictOf(it, payload) {
  if (!payload.base_version || payload.base_version === versionOf(it)) return null;
  return { ok: false, error: { code: 'CONFLICT', message: '他の人が先に更新していました', status: 409, data: { item: Object.assign({}, it) } } };
}

/** 操作 ID の扱い（gas/Op.gs と同じ振る舞いの簡易版）。済んだ操作の送り直しは最初の結果を返す */
function handleApi(body) {
  return addVersions(handleApiInner(body));
}
function handleApiInner(body) {
  const req = JSON.parse(body);
  const payload = Object.assign({}, req.payload || {});
  const opId = payload.op_id;
  if (!opId) return handleAction(req.action, payload, req.idToken);
  opCalls.push({ action: req.action, op_id: opId, op_attempt: payload.op_attempt, payload: JSON.parse(JSON.stringify(payload)) });
  delete payload.op_id;
  delete payload.op_attempt;
  const key = req.action + JSON.stringify(payload);
  const done = opResults[opId];
  if (done) {
    apiCalls.push(req.action);
    if (done.key !== key) {
      return { ok: false, error: { code: 'OP_MISMATCH', message: 'この操作はすでに保存されています', status: 409, data: { item: done.result.data.item } } };
    }
    const data = Object.assign({}, done.result.data, { item: items.find(i => i.item_id === done.result.data.item.item_id), replayed: true });
    if (req.action === 'createItem' && payload.photo && !data.item.photo_url && !photoFail) {
      data.item.photo_url = 'https://lh3.googleusercontent.com/d/mock';
      delete data.photoError;
    }
    return { ok: true, data };
  }
  const result = handleAction(req.action, payload, req.idToken);
  if (result.ok) opResults[opId] = { key, result };
  return result;
}

function handleAction(action, payload, idToken) {
  apiCalls.push(action);
  lastPayload[action] = payload;
  const live = () => items.filter(i => !i.is_deleted);
  switch (action) {
    case 'loginCheck':
      if (forbidden) return { ok: false, error: { code: 'FORBIDDEN_NOT_MEMBER', message: 'このアプリを利用する権限がありません', status: 403 } };
      return { ok: true, data: {
        user: { email: tokenEmail(idToken), name: 'テスト太郎', picture: '' },
        stockStatuses: ['余裕あり', '残りわずか', '在庫なし'],
        categories: ['IT機器', '事務用品', '消耗品'],
        locations: ['本館-1F-倉庫', '本館-3F-A棚-2段', '本館-3F-B棚-1段'],
        itemCount: live().length, serverTime: '2026-08-13 10:00:00',
        // withItems のときは一覧も返す（本物の GAS と同じ。絞り込みは起動時は空）
        ...(payload.withItems ? { items: live(), total: live().length } : {})
      } };
    case 'getItems': {
      let r = live();
      if (payload.keyword) {
        const k = payload.keyword.toLowerCase();
        r = r.filter(i => (i.item_id + i.name + i.category + i.location + i.note).toLowerCase().includes(k));
      }
      if (payload.stock_status) r = r.filter(i => i.stock_status === payload.stock_status);
      if (payload.restock === true) r = r.filter(i => ['残りわずか', '在庫なし'].includes(i.stock_status));
      if (payload.category) r = r.filter(i => i.category === payload.category);
      return { ok: true, data: { items: r, total: r.length } };
    }
    case 'getItem': {
      const it = live().find(i => i.item_id === payload.item_id);
      if (!it) return { ok: false, error: { code: 'ITEM_NOT_FOUND', message: '未登録です', status: 404 } };
      return { ok: true, data: { item: it, logs: logs.filter(l => l.item_id === it.item_id).reverse() } };
    }
    case 'updateStatus': {
      const it = items.find(i => i.item_id === payload.item_id);
      const conflict = conflictOf(it, payload);
      if (conflict) return conflict;
      const before = it.stock_status;
      it.stock_status = payload.stock_status;
      it.updated_at = '2026-08-13 10:05:00';
      const log = addLog(it.item_id, 'UPDATE_STATUS', { stock_status: before }, { stock_status: it.stock_status });
      return { ok: true, data: { item: it, log } };
    }
    case 'createItem': {
      const id = 'ITEM-000' + (items.length + 1);
      const it = Object.assign({ item_id: id, photo_url: payload.photo && !photoFail ? 'https://lh3.googleusercontent.com/d/mock' : '', is_deleted: false, updated_at: '2026-08-13 10:10:00', updated_by: 'taro@example.com' }, payload);
      delete it.photo; delete it.photos;
      const photoResult = saveMockPhotos(payload, it);
      delete it.primary_photo_id;
      items.push(it);
      const log = addLog(it.item_id, 'CREATE', '', { name: it.name, stock_status: it.stock_status });
      const data = Object.assign({ item: it, log }, photoResult);
      if (payload.photo && photoFail) data.photoError = '写真を保存できませんでした（模擬）。';
      return { ok: true, data };
    }
    case 'updateItem': {
      if (conflictNoItem.updateItem) {
        return { ok: false, error: { code: 'CONFLICT', message: '他の人が先に更新していました', status: 409, data: { item: null } } };
      }
      const it = items.find(i => i.item_id === payload.item_id);
      const conflict = conflictOf(it, payload);
      if (conflict) return conflict;
      const patch = Object.assign({}, payload);
      delete patch.item_id;
      delete patch.base_version;
      if (patch.photo) { patch.photo_url = 'https://lh3.googleusercontent.com/d/mock-edit'; delete patch.photo; }
      const before = { photos: mockPhotos(it) };
      const photoResult = saveMockPhotos(payload, it);
      delete patch.photos; delete patch.primary_photo_id;
      Object.assign(it, patch);
      const log = addLog(it.item_id, 'UPDATE', before, Object.assign({}, patch, payload.photos ? { photos: it.photos } : {}));
      return { ok: true, data: Object.assign({ item: it, log }, photoResult) };
    }
    case 'deleteItem': {
      const it = items.find(i => i.item_id === payload.item_id);
      const conflict = conflictOf(it, payload);
      if (conflict) return conflict;
      it.is_deleted = true;
      const log = addLog(it.item_id, 'DELETE', { is_deleted: false }, { is_deleted: true });
      return { ok: true, data: { item: it, log } };
    }
    default:
      return { ok: false, error: { code: 'UNKNOWN_ACTION', message: 'unknown', status: 400 } };
  }
}

/* ---------- 静的配信 + API ---------- */
const server = http.createServer((req, res) => {
  // 疑似の写真（1x1 の PNG）。要求を数え、遅らせられる（一覧の写真が表示を妨げないかの検証用）
  if (req.url.startsWith('/mockphoto/')) {
    photoRequests.push(req.url);
    // flaky は 1 回目だけ、broken は毎回失敗させる（読み直しの検証用）
    const n = photoRequests.filter(u => u === req.url).length;
    // fail2 は 2 回目まで失敗する（自動の読み直しでも失敗し、手で読み直すと出る）
    if (req.url.includes('broken') || (req.url.includes('flaky') && n === 1) || (req.url.includes('fail2') && n <= 2)) {
      res.writeHead(500, { 'Cache-Control': 'no-store' });
      return res.end('');
    }
    return setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'));
    }, photoDelay);
  }
  if (req.url.startsWith('/api')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const action = JSON.parse(body).action;
      if (apiDrop[action]) return setTimeout(() => req.socket.destroy(), apiDelay[action] || 0);
      const out = JSON.stringify(handleApi(body));
      if (apiLose[action] > 0) {   // 処理は済んだが、応答が届かない
        apiLose[action]--;
        return setTimeout(() => req.socket.destroy(), apiDelay[action] || 0);
      }
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(out);
      }, apiDelay[JSON.parse(body).action] || 0);
    });
    return;
  }
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  const file = path.join(DOCS, p);
  if (p === '/config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end(`window.APP_CONFIG={GAS_API_URL:'http://localhost:${PORT}/api',GOOGLE_CLIENT_ID:'test.apps.googleusercontent.com',APP_NAME:'備品管理',PHOTO_MAX_EDGE:1280,PHOTO_QUALITY:0.82,OP_RETRY_DELAYS_MS:[100,200]};`);
  }
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain' });
  res.end(fs.readFileSync(file));
});

(async () => {
  await new Promise(r => server.listen(PORT, r));
  // ブラウザは `npx playwright install chromium` で入れたものを使う。別の実行ファイルを使うときは CHROMIUM_PATH で指定する
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  });

  // 外部スクリプトのモック（GIS）と、サンドボックスから届かない CDN のローカル差し替え
  await ctx.route('**/gsi/client*', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));

  // ネットワークが CDN に届かない環境向け。ローカルビルドがあるときだけ差し替える。
  //   npx tailwindcss -i tw-in.css -o /tmp/tw.css --content "./docs/**/*.{html,js}" --minify
  //   npx esbuild --bundle --global-name=QRCode node_modules/qrcode/lib/browser.js --outfile=/tmp/qrcode.min.js
  // 同じCDNスクリプトを一時保存して指定できる。外部通信の不安定さを検証から除く。
  const tailwindScript = process.env.TAILWIND_SCRIPT || '/tmp/parts-tailwindcdn.js';
  if (fs.existsSync(tailwindScript)) {
    const body = fs.readFileSync(tailwindScript, 'utf8');
    await ctx.route('https://cdn.tailwindcss.com', r => r.fulfill({ status: 200, contentType: 'text/javascript', body }));
    await ctx.route('https://cdn.tailwindcss.com/**', r => r.fulfill({ status: 200, contentType: 'text/javascript', body }));
  }
  if (fs.existsSync('/tmp/tw.css')) {
    const TW = fs.readFileSync('/tmp/tw.css', 'utf8');
    const body = 'document.head.insertAdjacentHTML("beforeend","<style>"+' + JSON.stringify(TW) + '+"</style>");';
    await ctx.route('https://cdn.tailwindcss.com', r => r.fulfill({ status: 200, contentType: 'text/javascript', body }));
    await ctx.route('https://cdn.tailwindcss.com/**', r => r.fulfill({ status: 200, contentType: 'text/javascript', body }));
  }
  if (fs.existsSync('/tmp/qrcode.min.js')) {
    await ctx.route('**/qrcode*.js', r => r.fulfill({
      status: 200, contentType: 'text/javascript', body: fs.readFileSync('/tmp/qrcode.min.js', 'utf8')
    }));
  }
  // カメラは使えないのでスキャナは読み込まない（手入力の導線を検証する）
  await ctx.route('**/html5-qrcode*', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
  // Drive の写真は外に取りに行かせず、要求された URL だけ記録する
  const driveRequests = [];
  const driveReferers = [];   // 写真の要求に付いた Referer（付いていないはずなので、あれば記録される）
  await ctx.route('https://lh3.googleusercontent.com/**', r => { driveRequests.push(r.request().url());
    const ref = r.request().headers()['referer'];
    if (ref) driveReferers.push(ref);
    r.fulfill({ status: 200, contentType: 'image/png',
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64') }); });
  await ctx.addInitScript(() => {
    window.google = { accounts: { id: {
      initialize(cfg) { window.__gsiCallback = cfg.callback; },
      renderButton(el) {
        const b = document.createElement('button');
        b.textContent = 'Google でログイン（モック）';
        b.id = 'mock-signin';
        b.className = 'h-11 px-6 rounded-full bg-blue-600 text-white font-semibold';
        b.onclick = () => window.__gsiCallback({ credential:
          'eyJhbGciOiJIUzI1NiJ9.' + btoa(JSON.stringify({
            exp: Math.floor(Date.now()/1000)+3600,
            email: localStorage.getItem('mock:email') || 'taro@example.com'
          })) + '.sig' });
        el.appendChild(b);
      },
      prompt() {}, disableAutoSelect() {}
    } } };
  });

  const page = await ctx.newPage();
  const errors = [];
  const scannerLibRequests = [];
  page.on('request', r => { if (/html5-qrcode/.test(r.url())) scannerLibRequests.push(r.url()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  const shots = [];
  const snap = async (name) => {
    const f = path.join(__dirname, 'shot-' + name + '.png');
    await page.screenshot({ path: f });
    shots.push(f);
  };

  let fail = 0;
  const onlyAt = process.argv.indexOf('--only');
  const only = onlyAt < 0 ? '' : process.argv[onlyAt + 1];
  const check = async (label, fn) => {
    if (only && !label.includes(only) && !/^ログイン画面|^ログイン後|^JS エラー/.test(label)) return;
    try { await fn(); console.log('  ok   ' + label); }
    catch (e) { console.log('  FAIL ' + label + '\n       ' + e.message); fail++; }
  };

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });

  await check('ログイン画面が表示される', async () => {
    await page.waitForSelector('#mock-signin', { timeout: 5000 });
  });
  await snap('1-login');

  await check('ログイン後に一覧が出て 3 件表示される', async () => {
    await page.click('#mock-signin');
    await page.waitForSelector('#item-list [data-item-id]', { timeout: 5000 });
    const n = await page.locator('#item-list [data-item-id]').count();
    if (n !== 3) throw new Error('件数が ' + n);
  });
  await snap('2-list');

  await check('起動時の API 呼び出しは loginCheck の 1 回だけ', async () => {
    if (apiCalls.join(',') !== 'loginCheck') throw new Error('呼び出し: ' + apiCalls.join(','));
  });

  await check('起動時に QR スキャナのライブラリを読み込まない', async () => {
    if (scannerLibRequests.length) throw new Error('読み込み: ' + scannerLibRequests.join(', '));
  });

  await check('検索で絞り込める', async () => {
    await page.fill('#search-input', 'HDMI');
    await page.waitForTimeout(700);
    const n = await page.locator('#item-list [data-item-id]').count();
    if (n !== 1) throw new Error('件数が ' + n);
    await page.fill('#search-input', '');
    await page.waitForTimeout(700);
  });

  await check('カードをタップすると詳細が開く', async () => {
    await page.click('[data-item-id="ITEM-0002"]');
    await page.waitForSelector('#view-detail h2', { timeout: 5000 });
    const t = await page.textContent('#view-detail h2');
    if (!t.includes('HDMI')) throw new Error('見出しが ' + t);
  });
  await snap('3-detail');

  await check('ステータスボタンで更新できる', async () => {
    await page.click('[data-set-status="在庫なし"]');
    await page.waitForTimeout(900);
    const badge = await page.textContent('#view-detail .badge');
    if (badge.trim() !== '在庫なし') throw new Error('バッジが ' + badge);
    const logText = await page.textContent('#view-detail ul');
    if (!logText.includes('残りわずか → 在庫なし')) throw new Error('履歴に反映なし');
  });
  await snap('4-updated');

  await check('戻るボタンで一覧へ戻る', async () => {
    await page.click('#btn-back');
    await page.waitForSelector('#item-list [data-item-id]', { timeout: 5000 });
  });

  await check('追加タブでフォームが開く', async () => {
    await page.click('[data-nav="new"]');
    await page.waitForSelector('#item-form', { timeout: 5000 });
  });
  await snap('5-form');

  await check('新規登録できる', async () => {
    await page.fill('#f-name', 'ホワイトボードマーカー');
    await page.fill('#f-category', '事務用品');
    await page.fill('#f-location', '本館-2F-会議室');
    await page.fill('#f-quantity', '5');
    await page.click('#item-form button[type=submit]');
    await page.waitForSelector('#view-detail h2', { timeout: 5000 });
    const t = await page.textContent('#view-detail h2');
    if (!t.includes('ホワイトボード')) throw new Error('遷移先が ' + t);
  });
  await snap('6-created');

  await check('スキャン画面で手入力から詳細を開ける', async () => {
    await page.click('[data-nav="scan"]');
    await page.waitForSelector('#manual-id', { timeout: 5000 });
    await page.waitForTimeout(300);
    if (!scannerLibRequests.length) throw new Error('スキャン画面で QR スキャナのライブラリを読み込んでいない');
    // モックは中身が空なので読み込みは失敗扱い。画面を出入りすると読み込み直すこと
    const first = scannerLibRequests.length;
    await page.click('[data-nav="list"]');
    await page.waitForSelector('#view-list:not(.hidden)');
    await page.click('[data-nav="scan"]');
    await page.waitForTimeout(300);
    if (scannerLibRequests.length <= first) throw new Error('読み込み失敗の後、スキャン画面に入り直しても再要求しない');
    await page.fill('#manual-id', 'ITEM-0001');
    await page.click('#btn-manual-go');
    await page.waitForSelector('#view-detail h2', { timeout: 5000 });
    const t = await page.textContent('#view-detail h2');
    if (!t.includes('コピー用紙')) throw new Error('見出しが ' + t);
  });
  await snap('7-scan-manual');

  /* ---------- 端末内キャッシュ（PERF.md 項目 4） ---------- */
  const CACHE_KEY = 'parts-cache:v1';
  const SLOW = 2000;   // 疑似 API の遅れ
  const FAST = 1000;   // これより早く出ればキャッシュから表示できている
  const listNames = () => page.$$eval('#item-list [data-item-id] p.font-semibold', els => els.map(e => e.textContent));

  await check('2 回目の起動では前回の一覧を API を待たずに出し、届いた最新に差し替える', async () => {
    const it = items.find(i => i.item_id === 'ITEM-0001');
    const oldName = it.name;
    it.name = oldName + '（改名）';              // サーバー側だけ変える
    apiDelay.loginCheck = SLOW;
    try {
      await page.reload({ waitUntil: 'networkidle' });
      await page.click('#mock-signin');
      await page.waitForSelector('#item-list [data-item-id]', { timeout: FAST });
      if (!(await listNames()).includes(oldName)) throw new Error('前回の一覧が出ていない: ' + await listNames());
      await page.waitForFunction(n => [...document.querySelectorAll('#item-list p.font-semibold')].some(e => e.textContent === n),
        it.name, { timeout: SLOW + 2000 });
    } finally {
      delete apiDelay.loginCheck;
      it.name = oldName;
    }
  });

  await check('一覧→詳細は API を待たずに出し、届いた最新に差し替える', async () => {
    await page.waitForFunction(() => document.getElementById('loading').classList.contains('hidden'));
    const it = items.find(i => i.item_id === 'ITEM-0002');
    const oldNote = it.note;
    it.note = '裏で取得した最新の備考';           // サーバー側だけ変える
    apiDelay.getItem = SLOW;
    try {
      await page.click('[data-item-id="ITEM-0002"]');
      await page.waitForSelector('#view-detail:not(.hidden) h2', { timeout: FAST });
      const t = await page.textContent('#view-detail h2');
      if (!t.includes('HDMI')) throw new Error('見出しが ' + t);
      if ((await page.textContent('#view-detail dl')).includes(it.note)) throw new Error('API を待って表示している');
      await page.waitForFunction(n => document.querySelector('#view-detail dl').textContent.includes(n), it.note, { timeout: SLOW + 2000 });
    } finally {
      delete apiDelay.getItem;
      it.note = oldNote;
    }
  });

  await check('ID 入力（QR 読み取り後と同じ処理）→詳細も API を待たずに出す', async () => {
    apiDelay.getItem = SLOW;
    try {
      await page.click('[data-nav="scan"]');
      await page.fill('#manual-id', 'ITEM-0003');
      await page.click('#btn-manual-go');
      await page.waitForSelector('#view-detail:not(.hidden) h2', { timeout: FAST });
      const t = await page.textContent('#view-detail h2');
      if (!t.includes('乾電池')) throw new Error('見出しが ' + t);
      await page.waitForTimeout(SLOW + 500);
    } finally { delete apiDelay.getItem; }
  });

  await check('ログアウトでキャッシュを消す', async () => {
    await page.click('[data-nav="list"]');
    if (!await page.evaluate(k => localStorage.getItem(k), CACHE_KEY)) throw new Error('ログアウト前にキャッシュがない');
    await page.click('#btn-user');
    await page.click('#btn-logout');
    const left = await page.evaluate(k => localStorage.getItem(k), CACHE_KEY);
    if (left) throw new Error('キャッシュが残っている');
  });

  await check('別ユーザーでログインしたら前のユーザーのキャッシュを出さずに捨てる', async () => {
    // taro でキャッシュを作る
    await page.click('#mock-signin');
    await page.waitForSelector('#item-list [data-item-id]');
    await page.waitForFunction(k => !!localStorage.getItem(k), CACHE_KEY);
    // ログアウトせずに hanako で入り直す
    await page.evaluate(() => localStorage.setItem('mock:email', 'hanako@example.com'));
    apiDelay.loginCheck = SLOW;
    try {
      await page.reload({ waitUntil: 'networkidle' });
      await page.click('#mock-signin');
      await page.waitForTimeout(FAST);
      if (await page.isVisible('#item-list [data-item-id]')) throw new Error('前のユーザーのキャッシュを表示した');
      await page.waitForSelector('#item-list [data-item-id]', { timeout: SLOW + 2000 });
      const owner = await page.evaluate(k => JSON.parse(localStorage.getItem(k)).email, CACHE_KEY);
      if (owner !== 'hanako@example.com') throw new Error('キャッシュの持ち主が ' + owner);
    } finally {
      delete apiDelay.loginCheck;
      await page.evaluate(() => localStorage.removeItem('mock:email'));
    }
  });

  /** mock:email のユーザーでログインし直し、一覧が出てキャッシュが保存されるまで待つ */
  const relogin = async (email) => {
    await page.evaluate(e => e ? localStorage.setItem('mock:email', e) : localStorage.removeItem('mock:email'), email);
    await page.reload({ waitUntil: 'networkidle' });
    await page.click('#mock-signin');
    await page.waitForSelector('#item-list [data-item-id]');
    await page.waitForFunction(k => !!localStorage.getItem(k), CACHE_KEY);
    await page.waitForFunction(() => document.getElementById('loading').classList.contains('hidden'));
  };
  const logout = async () => {
    await page.click('#btn-user');
    await page.click('#btn-logout');
  };

  await check('キャッシュ表示中にログアウトしたら、遅れて届いたログイン確認で画面を戻さない', async () => {
    await relogin(null);                       // taro のキャッシュを作る
    apiDelay.loginCheck = SLOW;
    try {
      await page.reload({ waitUntil: 'networkidle' });
      await page.click('#mock-signin');
      await page.waitForSelector('#item-list [data-item-id]', { timeout: FAST }); // キャッシュで表示
      await logout();                          // loginCheck の応答前にログアウト
      await page.waitForTimeout(SLOW + 800);   // 遅れた応答が届くのを待つ
      if (!await page.isVisible('#view-login')) throw new Error('ログイン画面が消えた');
      if (await page.isVisible('#app')) throw new Error('アプリの画面が戻った');
      if (await page.evaluate(k => localStorage.getItem(k), CACHE_KEY)) throw new Error('キャッシュが戻った');
    } finally { delete apiDelay.loginCheck; }
  });

  await check('前のユーザーの遅れた一覧・詳細の応答を、次のユーザーの画面とキャッシュに使わない', async () => {
    await relogin(null);                       // taro
    const it = items.find(i => i.item_id === 'ITEM-0001');
    const name = it.name;
    it.name = '古いセッションの応答';           // taro の遅れた応答だけに入る名前
    apiDelay.getItem = SLOW;
    apiDelay.getItems = SLOW;
    try {
      await page.click('[data-item-id="ITEM-0001"]');       // 詳細（裏で getItem）
      await page.waitForSelector('#view-detail:not(.hidden) h2');
      await page.click('[data-nav="list"]');                // 一覧（裏で getItems）
      await page.waitForTimeout(300);
    } finally {
      it.name = name;                          // ここから後の応答は元の名前
      delete apiDelay.getItem;
      delete apiDelay.getItems;
    }
    await logout();
    await page.evaluate(() => localStorage.setItem('mock:email', 'hanako@example.com'));
    await page.click('#mock-signin');
    await page.waitForSelector('#item-list [data-item-id]');
    await page.waitForTimeout(SLOW + 800);     // taro の遅れた応答が届くのを待つ
    const names = await listNames();
    if (names.includes('古いセッションの応答')) throw new Error('一覧に古い応答が出た: ' + names);
    const cache = await page.evaluate(k => localStorage.getItem(k), CACHE_KEY);
    if (!cache || JSON.parse(cache).email !== 'hanako@example.com') throw new Error('キャッシュの持ち主が違う');
    if (cache.includes('古いセッションの応答')) throw new Error('キャッシュに古い応答が入った');
    await page.evaluate(() => localStorage.removeItem('mock:email'));
  });

  await check('別ユーザーでログインしたら、ログイン確認が失敗しても前のユーザーのキャッシュを残さない', async () => {
    await relogin(null);                       // taro のキャッシュを作る
    apiDrop.loginCheck = true;
    try {
      await page.evaluate(() => localStorage.setItem('mock:email', 'hanako@example.com'));
      await page.reload({ waitUntil: 'networkidle' });
      await page.click('#mock-signin');
      await page.waitForSelector('#login-error:not(.hidden)', { timeout: 5000 }); // 通信エラーでログイン画面
      if (await page.evaluate(k => localStorage.getItem(k), CACHE_KEY)) throw new Error('前のユーザーのキャッシュが残っている');
    } finally {
      delete apiDrop.loginCheck;
      await page.evaluate(() => localStorage.removeItem('mock:email'));
    }
  });

  /* ---------- 更新の即時反映（PERF.md 項目 6） ---------- */
  const openDetailOf = async (id) => {
    await page.click('[data-nav="list"]');
    await page.waitForSelector('#view-list:not(.hidden) [data-item-id="' + id + '"]');
    await page.click('[data-item-id="' + id + '"]');
    await page.waitForSelector('#view-detail:not(.hidden) h2');
    await page.waitForFunction(() => document.getElementById('loading').classList.contains('hidden'));
    await page.waitForTimeout(300); // 裏の最新取得を終わらせる
  };
  const badge = async () => (await page.textContent('#view-detail .badge')).trim();
  const errorToast = () => page.waitForSelector('.toast-error', { timeout: 5000 });
  /** 文言が pattern に合う失敗の知らせが出るまで待つ（前の検証の知らせが残っていても取り違えない） */
  const errorToastMatching = (pattern) => page.waitForFunction(
    re => Array.prototype.some.call(document.querySelectorAll('.toast-error'), e => new RegExp(re).test(e.textContent)),
    pattern, { timeout: 5000 });

  await check('ステータスは押した直後に変わり、再取得せずに応答の履歴を足す。一覧とキャッシュにも反映する', async () => {
    await relogin(null);
    await openDetailOf('ITEM-0001');
    const next = (await badge()) === '在庫なし' ? '余裕あり' : '在庫なし';
    const callsBefore = apiCalls.length;
    apiDelay.updateStatus = SLOW;
    try {
      await page.click('[data-set-status="' + next + '"]');
      await page.waitForFunction(n => document.querySelector('#view-detail .badge').textContent.trim() === n, next, { timeout: FAST });
      if (!await page.isVisible('#saving-indicator')) throw new Error('保存中の表示がない');
      await page.waitForSelector('#saving-indicator', { state: 'detached', timeout: SLOW + 2000 });
    } finally { delete apiDelay.updateStatus; }
    const calls = apiCalls.slice(callsBefore);
    if (calls.join(',') !== 'updateStatus') throw new Error('呼び出し: ' + calls.join(','));
    if (!(await page.textContent('#view-detail ul')).includes('→ ' + next)) throw new Error('履歴に足されていない');
    const cached = await page.evaluate(k => JSON.parse(localStorage.getItem(k)), CACHE_KEY);
    if (cached.items.find(i => i.item_id === 'ITEM-0001').stock_status !== next) throw new Error('キャッシュの一覧が古い');
    if (cached.details['ITEM-0001'].item.stock_status !== next) throw new Error('キャッシュの詳細が古い');
    await page.click('[data-nav="list"]');
    const card = await page.textContent('[data-item-id="ITEM-0001"] .badge');
    if (card.trim() !== next) throw new Error('一覧が古い: ' + card);
  });

  await check('ステータス更新が失敗したら元の表示に戻して知らせる', async () => {
    await openDetailOf('ITEM-0001');
    const before = await badge();
    const next = before === '在庫なし' ? '余裕あり' : '在庫なし';
    apiDrop.updateStatus = true;
    try {
      await page.click('[data-set-status="' + next + '"]');
      await errorToast();
      if ((await badge()) !== before) throw new Error('表示が戻っていない: ' + await badge());
      if (await page.isVisible('#saving-indicator')) throw new Error('保存中のまま');
    } finally { delete apiDrop.updateStatus; }
    const cached = await page.evaluate(k => JSON.parse(localStorage.getItem(k)), CACHE_KEY);
    if (cached.details['ITEM-0001'].item.stock_status !== before) throw new Error('キャッシュに失敗した更新が入った');
  });

  await check('編集は保存を待たずに詳細へ反映し、失敗したら入力を残してフォームに戻す', async () => {
    await openDetailOf('ITEM-0002');
    const oldNote = await page.textContent('#view-detail dl');
    await page.click('#btn-edit');
    await page.fill('#f-note', '失敗させる編集');
    apiDrop.updateItem = true;
    apiDelay.updateItem = SLOW;
    try {
      await page.click('#item-form button[type=submit]');
      await page.waitForFunction(() => document.querySelector('#view-detail dl') &&
        document.querySelector('#view-detail dl').textContent.includes('失敗させる編集'), null, { timeout: FAST });
      await errorToast();
      await page.waitForSelector('#view-form:not(.hidden) #f-note');
      if ((await page.inputValue('#f-note')) !== '失敗させる編集') throw new Error('入力が消えた');
    } finally { delete apiDrop.updateItem; delete apiDelay.updateItem; }
    await page.click('#btn-back');
    await page.waitForSelector('#view-detail:not(.hidden) h2');
    if ((await page.textContent('#view-detail dl')) !== oldNote) throw new Error('詳細が元に戻っていない');
  });

  await check('登録は保存を待たずに詳細を出し、失敗したら入力を残してフォームに戻す', async () => {
    await page.click('[data-nav="new"]');
    await page.fill('#f-name', '失敗させる登録');
    apiDrop.createItem = true;
    try {
      await page.click('#item-form button[type=submit]');
      await errorToast();
      await page.waitForSelector('#view-form:not(.hidden) #f-name');
      if ((await page.inputValue('#f-name')) !== '失敗させる登録') throw new Error('入力が消えた');
    } finally { delete apiDrop.createItem; }
    if (items.some(i => i.name === '失敗させる登録')) throw new Error('サーバーに登録されている');
    apiDelay.createItem = SLOW;
    try {
      await page.click('#item-form button[type=submit]');
      await page.waitForFunction(() => { const h = document.querySelector('#view-detail:not(.hidden) h2'); return h && h.textContent.includes('失敗させる登録'); }, null, { timeout: FAST });
      await page.waitForSelector('#saving-indicator', { state: 'detached', timeout: SLOW + 2000 });
    } finally { delete apiDelay.createItem; }
    const id = (await page.textContent('#view-detail dd')).trim();
    if (!/^ITEM-/.test(id)) throw new Error('採番された ID に差し替わっていない: ' + id);
  });

  /* ---------- 保存の途中失敗と再送（PLAN-2 項目 1） ---------- */
  const countByName = (name) => items.filter(i => i.name === name).length;
  const opsOf = (action, from) => opCalls.slice(from).filter(c => c.action === action);

  await check('登録の応答が失われても、同じ操作 ID で自動で送り直し、二重に登録しない', async () => {
    await page.click('[data-nav="new"]');
    await page.fill('#f-name', '応答が消える登録');
    const from = opCalls.length;
    apiLose.createItem = 1;
    try {
      await page.click('#item-form button[type=submit]');
      await page.waitForSelector('#saving-indicator', { state: 'detached', timeout: 5000 });
    } finally { delete apiLose.createItem; }
    // 応答なしで切れた POST は、ブラウザ自身も同じ内容（op_attempt も同じ）で送り直すことがある。
    // どちらが送り直しても、操作 ID は 1 つで、登録は 1 件になる
    const sent = opsOf('createItem', from);
    if (sent.length < 2 || new Set(sent.map(c => c.op_id)).size !== 1) throw new Error('同じ操作 ID で送り直していない: ' + JSON.stringify(sent));
    if (countByName('応答が消える登録') !== 1) throw new Error('登録の件数: ' + countByName('応答が消える登録'));
    const id = (await page.textContent('#view-detail dd')).trim();
    if (!/^ITEM-/.test(id)) throw new Error('詳細が登録した備品になっていない: ' + id);
  });

  await check('保存できたか確認できないときはフォームに戻し、次の登録を同じ操作の送り直しにする', async () => {
    await page.click('[data-nav="new"]');
    await page.fill('#f-name', '確認できない登録');
    const from = opCalls.length;
    apiLose.createItem = Infinity;   // 自動の送り直し（2 回）を含めて、応答がすべて届かない
    try {
      await page.click('#item-form button[type=submit]');
      await errorToastMatching('確認できませんでした');
      await page.waitForSelector('#view-form:not(.hidden) #f-name');
      if ((await page.inputValue('#f-name')) !== '確認できない登録') throw new Error('入力が消えた');
    } finally { delete apiLose.createItem; }
    await page.click('#item-form button[type=submit]');
    await page.waitForSelector('#saving-indicator', { state: 'detached', timeout: 5000 });
    const sent = opsOf('createItem', from);
    if (new Set(sent.map(c => c.op_id)).size !== 1) throw new Error('操作 ID が変わった: ' + JSON.stringify(sent));
    // 自動の送り直し 2 回（2・3 回目）と、フォームからの送り直し（4 回目）
    if ([...new Set(sent.map(c => c.op_attempt))].join(',') !== '1,2,3,4') throw new Error('送信の回数: ' + JSON.stringify(sent));
    if (countByName('確認できない登録') !== 1) throw new Error('登録の件数: ' + countByName('確認できない登録'));
    const h = await page.textContent('#view-detail:not(.hidden) h2');
    if (!h.includes('確認できない登録')) throw new Error('詳細: ' + h);
  });

  await check('確認できなかった登録を、内容を変えて送り直したら、済んでいた備品を出して知らせる', async () => {
    await page.click('[data-nav="new"]');
    await page.fill('#f-name', '内容を変える登録');
    apiLose.createItem = Infinity;
    try {
      await page.click('#item-form button[type=submit]');
      await errorToast();
      await page.waitForSelector('#view-form:not(.hidden) #f-name');
    } finally { delete apiLose.createItem; }
    await page.fill('#f-name', '内容を変える登録（直した）');
    await page.click('#item-form button[type=submit]');
    await errorToastMatching('前回の登録は完了していました');
    await page.waitForFunction(() => { const h = document.querySelector('#view-detail:not(.hidden) h2'); return h && h.textContent.includes('内容を変える登録'); });
    if (countByName('内容を変える登録') !== 1 || countByName('内容を変える登録（直した）') !== 0) throw new Error('重複して登録した');
  });

  await check('登録で写真だけ保存できなかったら、詳細の「写真だけ送り直す」で写真だけを送る（ほかの項目を上書きしない）', async () => {
    await page.click('[data-nav="new"]');
    await page.fill('#f-name', '写真だけ失敗');
    await page.fill('#f-note', '登録したときの備考');
    await page.setInputFiles('#f-photo', { name: 'p.png', mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64') });
    await page.waitForSelector('#photo-slot img');
    photoFail = true;
    try {
      await page.click('#item-form button[type=submit]');
      await errorToastMatching('一部の写真を保存できませんでした');
      await page.waitForSelector('#view-detail:not(.hidden) #btn-photo-retry');
    } finally { photoFail = false; }
    const created = items.find(i => i.name === '写真だけ失敗');
    if (!created || created.photo_url) throw new Error('写真なしで登録されていない');
    created.note = '他の人が変えた備考';          // 送り直すまでの間に、他の人が備考を変えた
    await page.click('#btn-photo-retry');
    // 競合後は最新版と追加下書きを編集フォームで再確認する。
    await errorToastMatching('他の人が更新していました');
    await page.waitForSelector('#view-form:not(.hidden) #conflict-notice');
    if (await page.inputValue('#f-note') !== '他の人が変えた備考') throw new Error('最新の備考を保持していない');
    await page.click('#item-form button[type=submit]');
    await page.waitForSelector('#view-detail:not(.hidden)');
    await page.waitForSelector('#saving-indicator', { state: 'detached', timeout: 5000 });
    const keys = Object.keys(lastPayload.updateItem).sort().join(',');
    if (keys !== 'base_version,item_id,photos,primary_photo_id') throw new Error('写真以外も送った: ' + keys);
    if (created.note !== '他の人が変えた備考') throw new Error('他の人の変更を上書きした: ' + created.note);
    if (!created.photo_url) throw new Error('写真が保存されていない');
    if (countByName('写真だけ失敗') !== 1) throw new Error('写真の送り直しで備品が増えた');
  });

  /* ---------- 同時編集の競合検出（PLAN-2 項目 2） ---------- */
  await check('編集は変えた項目だけを、開いたときの版を添えて送る', async () => {
    await openDetailOf('ITEM-0002');
    await page.click('#btn-edit');
    await page.fill('#f-note', '変えたのは備考だけ');
    await page.click('#item-form button[type=submit]');
    await page.waitForSelector('#saving-indicator', { state: 'detached', timeout: 5000 });
    const keys = Object.keys(lastPayload.updateItem).sort().join(',');
    if (keys !== 'base_version,item_id,note') throw new Error('送った項目: ' + keys);
  });

  await check('編集の保存が他の人の更新と競合したら、止めて知らせ、入力を残す。自分が変えていない項目は最新にする', async () => {
    await openDetailOf('ITEM-0002');
    await page.click('#btn-edit');
    await page.fill('#f-note', '自分の備考');
    const it = items.find(i => i.item_id === 'ITEM-0002');
    it.quantity = 99;                 // 自分が触っていない項目を、他の人が変えた
    it.note = '他の人の備考';          // 自分が変えた項目も、他の人が変えた
    await page.click('#item-form button[type=submit]');
    await errorToastMatching('他の人が先にこの備品を更新していた');
    await page.waitForSelector('#view-form:not(.hidden) #conflict-notice');
    const notice = await page.textContent('#conflict-notice');
    if (!notice.includes('他の人の備考') || !notice.includes('自分の備考')) throw new Error('知らせ: ' + notice);
    if ((await page.inputValue('#f-note')) !== '自分の備考') throw new Error('入力が消えた');
    if ((await page.inputValue('#f-quantity')) !== '99') throw new Error('触っていない項目が最新になっていない: ' + await page.inputValue('#f-quantity'));
    if (it.note !== '他の人の備考') throw new Error('競合したのに保存された');
    await page.click('#item-form button[type=submit]');
    await page.waitForSelector('#saving-indicator', { state: 'detached', timeout: 5000 });
    if (it.note !== '自分の備考' || it.quantity !== 99) throw new Error('送り直しの結果: ' + JSON.stringify(it));
    const keys = Object.keys(lastPayload.updateItem).sort().join(',');
    if (keys !== 'base_version,item_id,note') throw new Error('送り直しで送った項目: ' + keys);
  });

  await check('最新の備品が返らない競合（行が消えたなど）でも、入力と写真を残してフォームに戻る', async () => {
    await openDetailOf('ITEM-0002');
    await page.click('#btn-edit');
    await page.fill('#f-note', '失いたくない入力');
    await page.setInputFiles('#f-photo', { name: 'p.png', mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64') });
    await page.waitForSelector('#photo-slot img');
    conflictNoItem.updateItem = true;
    try {
      await page.click('#item-form button[type=submit]');
      await errorToastMatching('最新の内容を確かめられなかった');
      await page.waitForSelector('#view-form:not(.hidden) #f-note');
      if ((await page.inputValue('#f-note')) !== '失いたくない入力') throw new Error('入力が消えた');
      if (!(await page.$('#photo-slot img'))) throw new Error('写真の下書きが消えた');
    } finally { delete conflictNoItem.updateItem; }
    await page.click('#item-form button[type=submit]');
    await page.waitForSelector('#saving-indicator', { state: 'detached', timeout: 5000 });
    if (items.find(i => i.item_id === 'ITEM-0002').note !== '失いたくない入力') throw new Error('送り直しで保存されない');
  });

  await check('ステータス更新が他の人の更新と競合したら、止めて最新の状態を表示する', async () => {
    await openDetailOf('ITEM-0001');
    const it = items.find(i => i.item_id === 'ITEM-0001');
    const shown = await badge();
    const theirs = shown === '在庫なし' ? '残りわずか' : '在庫なし';
    const mine = ['余裕あり', '残りわずか', '在庫なし'].find(s => s !== shown && s !== theirs);
    it.stock_status = theirs;         // 画面が読んだ後に、他の人が変えた
    await page.click('[data-set-status="' + mine + '"]');
    await errorToastMatching('他の人が先にこの備品を更新していた');
    await page.waitForFunction(t => document.querySelector('#view-detail .badge').textContent === t, theirs);
    if (it.stock_status !== theirs) throw new Error('競合したのに保存された');
  });

  /* ---------- 情報の新しさと通信状態（PLAN-2 項目 3） ---------- */
  const syncOf = (sel) => page.$eval(sel, el => {
    const t = el.querySelector('[data-sync-status]');
    return t ? { status: t.getAttribute('data-sync-status'), old: t.hasAttribute('data-sync-old'), text: t.textContent } : null;
  });
  const reloadWithCache = async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.click('#mock-signin');
    await page.waitForSelector('#item-list [data-item-id]', { timeout: FAST });
  };

  await check('キャッシュを出して通信が遅いときは「確認中」といつの情報かを出し、届いたら「最新」にする', async () => {
    apiDelay.loginCheck = SLOW;
    try {
      await reloadWithCache();
      const s = await syncOf('#sync-list');
      if (!s || s.status !== 'checking' || !/確認した情報/.test(s.text)) throw new Error('確認中の表示: ' + JSON.stringify(s));
      await page.waitForFunction(() => { const t = document.querySelector('#sync-list [data-sync-status]'); return t && t.getAttribute('data-sync-status') === 'fresh'; }, null, { timeout: SLOW + 3000 });
      const f = await syncOf('#sync-list');
      if (!/最新の情報です/.test(f.text)) throw new Error('最新の表示: ' + f.text);
    } finally { delete apiDelay.loginCheck; }
  });

  await check('通信できないときは「通信できません」といつの情報かを出し、表示中の内容は消さない。再試行で最新にする', async () => {
    await openDetailOf('ITEM-0001');
    const shownBadge = await badge();
    await page.click('#btn-back');
    await page.waitForSelector('#item-list [data-item-id]');
    apiDrop.getItem = true;
    try {
      await page.click('[data-item-id="ITEM-0001"]');
      await page.waitForFunction(() => { const t = document.querySelector('#sync-detail [data-sync-status]'); return t && t.getAttribute('data-sync-status') === 'offline'; }, null, { timeout: 5000 });
      const s = await syncOf('#sync-detail');
      if (!/通信できません/.test(s.text) || !/確認した情報を表示しています/.test(s.text)) throw new Error('通信断の表示: ' + s.text);
      if ((await badge()) !== shownBadge) throw new Error('表示中の在庫が変わった: ' + await badge());
      await snap('10-sync-offline');
    } finally { delete apiDrop.getItem; }
    await page.click('#sync-detail [data-sync-refresh]');
    await page.waitForFunction(() => { const t = document.querySelector('#sync-detail [data-sync-status]'); return t && t.getAttribute('data-sync-status') === 'fresh'; }, null, { timeout: 5000 });
  });

  await check('1 日以上確かめていない情報は、古いことを目立たせて知らせる', async () => {
    await page.evaluate(k => {
      const c = JSON.parse(localStorage.getItem(k));
      c.confirmedAt = Date.now() - 2 * 24 * 60 * 60 * 1000;
      localStorage.setItem(k, JSON.stringify(c));
    }, CACHE_KEY);
    apiDrop.loginCheck = true;
    try {
      await reloadWithCache();
      await page.waitForFunction(() => { const t = document.querySelector('#sync-list [data-sync-status]'); return t && t.getAttribute('data-sync-status') === 'offline'; }, null, { timeout: 5000 });
      const s = await syncOf('#sync-list');
      if (!s.old || !/1 日以上/.test(s.text) || !/2 日前/.test(s.text)) throw new Error('古い情報の表示: ' + JSON.stringify(s));
      if ((await page.$$('#item-list [data-item-id]')).length === 0) throw new Error('前回の一覧が消えた');
      await snap('9-sync-old');
    } finally { delete apiDrop.loginCheck; }
    await page.click('#sync-list [data-sync-refresh]');
    await page.waitForFunction(() => { const t = document.querySelector('#sync-list [data-sync-status]'); return t && t.getAttribute('data-sync-status') === 'fresh'; }, null, { timeout: 5000 });
  });

  await check('絞り込みを変えた後に通信できなければ、前の一覧や「該当なし」ではなく、取得できなかったと出す', async () => {
    apiDrop.getItems = true;
    try {
      await page.selectOption('#filter-status', '在庫なし');
      await page.waitForSelector('#list-failed', { timeout: 5000 });
      if (await page.$('#item-list [data-item-id]')) throw new Error('絞り込む前の一覧を出している');
      const text = await page.textContent('#item-list');
      if (text.includes('該当する備品がありません')) throw new Error('該当なしと出した');
      if ((await page.textContent('#list-count')).includes('0 件')) throw new Error('0 件と出した');
    } finally { delete apiDrop.getItems; }
    await page.click('#sync-list [data-sync-refresh]');
    await page.waitForFunction(() => !document.querySelector('#list-failed'), null, { timeout: 5000 });
    await page.selectOption('#filter-status', '');
    await page.waitForSelector('#item-list [data-item-id]');
  });

  await check('権限がないと断られたら、キャッシュを消してログイン画面に戻す', async () => {
    await relogin(null);
    if (!(await page.evaluate(k => localStorage.getItem(k), CACHE_KEY))) throw new Error('前提: キャッシュが無い');
    forbidden = true;
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.click('#mock-signin');
      await page.waitForSelector('#view-login:not(.hidden) #login-error:not(.hidden)', { timeout: 5000 });
      if (await page.evaluate(k => localStorage.getItem(k), CACHE_KEY)) throw new Error('キャッシュが残った');
    } finally { forbidden = false; }
    await relogin(null);
  });

  await check('裏で取っていた詳細の古い応答が、更新の後に届いても画面とキャッシュを戻さない', async () => {
    await openDetailOf('ITEM-0003');
    await page.click('[data-nav="list"]');
    await page.waitForSelector('#view-list:not(.hidden)');
    apiDelay.getItem = SLOW;                                  // X を開いたときの裏の取得を遅らせる
    let next;
    try {
      await page.click('[data-item-id="ITEM-0001"]');        // X（手元から表示、裏で getItem 開始）
      await page.waitForSelector('#view-detail:not(.hidden) h2');
      next = (await badge()) === '在庫なし' ? '余裕あり' : '在庫なし';
    } finally { delete apiDelay.getItem; }                   // ここから後の getItem は遅らせない
    await page.click('[data-set-status="' + next + '"]');   // X を更新（すぐ成功する）
    await page.waitForSelector('#saving-indicator', { state: 'detached', timeout: 5000 });
    await openDetailOf('ITEM-0003');                          // 別の備品 Y に移る
    await page.waitForTimeout(SLOW + 800);                    // X の古い応答が届くのを待つ
    const cached = await page.evaluate(k => JSON.parse(localStorage.getItem(k)), CACHE_KEY);
    if (cached.details['ITEM-0001'].item.stock_status !== next) throw new Error('キャッシュの詳細が古い応答で戻った');
    if (cached.items.find(i => i.item_id === 'ITEM-0001').stock_status !== next) throw new Error('キャッシュの一覧が古い応答で戻った');
    await page.click('[data-nav="list"]');
    await page.waitForSelector('#view-list:not(.hidden)');
    await page.click('[data-item-id="ITEM-0001"]');
    await page.waitForSelector('#view-detail:not(.hidden) h2');
    if ((await badge()) !== next) throw new Error('詳細が古い応答で戻った: ' + await badge());
    await page.waitForTimeout(500);
  });

  await check('裏で取っていた一覧の古い応答が、更新の後に届いても一覧とキャッシュを戻さない', async () => {
    await openDetailOf('ITEM-0001');
    apiDelay.getItems = SLOW;                                 // 一覧に戻ったときの裏の取得を遅らせる
    try {
      await page.click('[data-nav="list"]');
      await page.waitForSelector('#view-list:not(.hidden)');
    } finally { delete apiDelay.getItems; }
    await page.click('[data-item-id="ITEM-0001"]');
    await page.waitForSelector('#view-detail:not(.hidden) h2');
    const next = (await badge()) === '在庫なし' ? '余裕あり' : '在庫なし';
    await page.click('[data-set-status="' + next + '"]');
    await page.waitForSelector('#saving-indicator', { state: 'detached', timeout: 5000 });
    await page.waitForTimeout(SLOW + 800);                    // 古い一覧が届くのを待つ
    const cached = await page.evaluate(k => JSON.parse(localStorage.getItem(k)), CACHE_KEY);
    if (cached.items.find(i => i.item_id === 'ITEM-0001').stock_status !== next) throw new Error('キャッシュの一覧が古い応答で戻った');
    const shown = await page.$eval('[data-item-id="ITEM-0001"] .badge', e => e.textContent.trim());
    if (shown !== next) throw new Error('一覧が古い応答で戻った: ' + shown);
  });

  /* ---------- 写真（PERF.md 項目 7） ---------- */
  await check('一覧の写真は表示を妨げず、画面外の写真は読み込まない', async () => {
    const base = items.length;
    for (let i = 0; i < 30; i++) {
      items.push({ item_id: 'PHOTO-' + String(i).padStart(2, '0'), name: '写真つき ' + i, category: '', location: '', stock_status: '余裕あり',
        quantity: 1, photo_url: `http://localhost:${PORT}/mockphoto/${i}`, note: '', updated_at: '2026-08-14 09:00:' + String(59 - i).padStart(2, '0'),
        updated_by: 'taro@example.com', is_deleted: false });
    }
    photoRequests.length = 0;
    photoDelay = SLOW;
    try {
      await page.click('[data-nav="scan"]');
      await page.click('[data-nav="list"]');                  // 一覧に戻る（裏の取得で 30 件が加わる）
      await page.waitForFunction(() => document.querySelectorAll('#item-list [data-item-id^="PHOTO-"]').length === 30, null, { timeout: FAST + 1000 });
      for (let t = 0; t < 20 && photoRequests.length === 0; t++) await page.waitForTimeout(100);
      if (photoRequests.length === 0) throw new Error('画面内の写真を取りに行っていない');
      await page.waitForTimeout(500);
      const requested = new Set(photoRequests).size;
      if (requested >= 30) throw new Error('画面外の写真まで読み込んだ: ' + requested + ' 件');
      // 写真の応答を待たずに操作できる（覆いが出ていない）
      if (!await page.evaluate(() => document.getElementById('loading').classList.contains('hidden'))) throw new Error('読み込み中の覆いが出ている');
    } finally {
      photoDelay = 0;
      items.splice(base);
    }
  });

  await check('写真の読み込みに失敗したら 1 回だけ読み直し、それも失敗したら灰色の枠にする', async () => {
    const a = items.find(i => i.item_id === 'ITEM-0001');
    const b2 = items.find(i => i.item_id === 'ITEM-0002');
    const oldA = a.photo_url, oldB = b2.photo_url;
    a.photo_url = `http://localhost:${PORT}/mockphoto/flaky-${Date.now()}`;
    b2.photo_url = `http://localhost:${PORT}/mockphoto/broken-${Date.now()}`;
    try {
      await page.click('[data-nav="scan"]');
      await page.click('[data-nav="list"]');
      await page.waitForFunction(u => { const i = document.querySelector('[data-item-id="ITEM-0001"] img'); return i && i.src === u; }, a.photo_url);
      await page.waitForTimeout(2000);
      const ok = await page.$eval('[data-item-id="ITEM-0001"] img', i => i.complete && i.naturalWidth > 0).catch(() => false);
      if (!ok) throw new Error('1 回目に失敗した写真が読み直されていない');
      if (photoRequests.filter(u => u.endsWith(a.photo_url.split('/').pop())).length !== 2) throw new Error('読み直しの回数が違う');
      if (await page.$('[data-item-id="ITEM-0002"] img')) throw new Error('2 回失敗した写真が失敗の表示になっていない');
    } finally {
      a.photo_url = oldA;
      b2.photo_url = oldB;
    }
  });

  /* ---------- 写真の読み込み失敗の見分けと手で読み直す操作（PLAN-2 項目 4） ---------- */
  const photoCount = (url) => photoRequests.filter(u => u.endsWith(url.split('/').pop())).length;
  // 一覧を通らずに（スキャン画面の手入力で）詳細を開く。一覧のサムネイルが同じ写真を取りに行かないので、
  // 写真の要求を詳細の分だけ数えられる
  const openDetailById = async (id, photoUrl) => {
    await page.click('[data-nav="scan"]');
    await page.waitForSelector('#manual-id');
    await page.fill('#manual-id', id);
    await page.click('#btn-manual-go');
    await page.waitForFunction(u => { const d = document.querySelector('#view-detail:not(.hidden)');
      return d && (d.querySelector('img[src="' + u + '"]') || d.querySelector('#photo-failed')); }, photoUrl, { timeout: 5000 });
  };

  await check('何度も失敗した写真は「読めません」と出し、写真なし（📦）と見分けられる。一覧から読み直せる', async () => {
    const a = items.find(i => i.item_id === 'ITEM-0001');
    const c = items.find(i => i.item_id === 'ITEM-0003');
    const oldA = a.photo_url, oldC = c.photo_url;
    a.photo_url = `http://localhost:${PORT}/mockphoto/fail2-list-${Date.now()}`;
    c.photo_url = '';
    try {
      await page.click('[data-nav="scan"]');
      await page.click('[data-nav="list"]');
      await page.waitForSelector('[data-item-id="ITEM-0001"] [data-photo-failed]', { timeout: 5000 });
      if (!(await page.textContent('[data-item-id="ITEM-0001"] [data-photo-failed]')).includes('読めません')) throw new Error('失敗の表示の文言');
      if (!(await page.textContent('[data-item-id="ITEM-0003"]')).includes('📦')) throw new Error('写真なしの表示が変わった');
      if (await page.$('[data-item-id="ITEM-0003"] [data-photo-failed]')) throw new Error('写真なしを失敗と表示した');
      if (photoCount(a.photo_url) !== 2) throw new Error('自動の読み直しの回数: ' + photoCount(a.photo_url));
      await page.click('#btn-photo-reload-list');
      await page.waitForFunction(() => { const i = document.querySelector('[data-item-id="ITEM-0001"] img'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 5000 });
      if (await page.isVisible('#btn-photo-reload-list')) throw new Error('読み直した後もボタンが出ている');
    } finally { a.photo_url = oldA; c.photo_url = oldC; }
  });

  await check('詳細の写真を読み込めなければ「再読み込み」を出し、押すと取り直す。読み直しは続かない', async () => {
    const it = items.find(i => i.item_id === 'ITEM-0002');
    const old = it.photo_url, oldPhotos = it.photos;
    delete it.photos;
    it.photo_url = `http://localhost:${PORT}/mockphoto/broken-detail-${Date.now()}`;
    try {
      await openDetailById('ITEM-0002', it.photo_url);
      await page.waitForSelector('#view-detail #photo-failed #btn-photo-reload', { timeout: 6000 });
      if (photoCount(it.photo_url) !== 2) throw new Error('自動の読み直しの回数: ' + photoCount(it.photo_url));
      await page.click('#btn-photo-reload');
      await page.waitForSelector('#view-detail #photo-failed', { timeout: 6000 });
      await page.waitForTimeout(2500);
      if (photoCount(it.photo_url) !== 4) throw new Error('手で読み直した後の回数（手で 1 回＋自動 1 回のはず）: ' + photoCount(it.photo_url));
      // 2 回目まで失敗する写真なら、手で読み直すと出る
      it.photo_url = `http://localhost:${PORT}/mockphoto/fail2-detail-${Date.now()}`;
      await page.click('#sync-detail [data-sync-refresh]');
      await page.waitForSelector('#view-detail #btn-photo-reload', { timeout: 6000 });
      await page.click('#btn-photo-reload');
      await page.waitForFunction(() => { const i = document.querySelector('#view-detail img'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 5000 });
    } finally { it.photo_url = old; it.photos = oldPhotos; }
  });

  await check('読み直す前に画面を離れたら、写真を取りに行かない', async () => {
    const it = items.find(i => i.item_id === 'ITEM-0002');
    const old = it.photo_url, oldPhotos = it.photos;
    delete it.photos;
    it.photo_url = `http://localhost:${PORT}/mockphoto/broken-leave-${Date.now()}`;
    try {
      await openDetailById('ITEM-0002', it.photo_url);
      await page.waitForFunction(u => { const i = document.querySelector('#view-detail img'); return i && i.src === u && i.dataset.retry === '1'; }, it.photo_url, { timeout: 5000 });
      await page.click('[data-nav="scan"]');                  // 1 秒後の読み直しの前に別の画面へ移る
      await page.waitForTimeout(1800);
      if (photoCount(it.photo_url) !== 1) throw new Error('画面を離れた後に取りに行った: ' + photoCount(it.photo_url));
    } finally { it.photo_url = old; it.photos = oldPhotos; }
  });

  /* ---------- 要補充の入口（PLAN-2 項目 5） ---------- */
  const cardIds = () => page.$$eval('#item-list [data-item-id]', els => els.map(e => e.getAttribute('data-item-id')));

  await check('「要補充」で残りわずか・在庫なしだけを出し、件数と絞り込みの状態が合う。在庫の選択・クリアで外れる', async () => {
    await page.click('[data-nav="list"]');
    await page.waitForSelector('#view-list:not(.hidden) [data-item-id]');
    await page.click('#btn-restock');
    await page.waitForFunction(() => document.querySelector('#list-count').textContent.startsWith('要補充'));
    if (lastPayload.getItems.restock !== true) throw new Error('要補充を送っていない: ' + JSON.stringify(lastPayload.getItems));
    const want = items.filter(i => !i.is_deleted && ['残りわずか', '在庫なし'].includes(i.stock_status)).map(i => i.item_id).sort();
    const shown = (await cardIds()).sort();
    if (JSON.stringify(shown) !== JSON.stringify(want)) throw new Error('出した備品: ' + shown + ' / 期待: ' + want);
    if ((await page.textContent('#list-count')).trim() !== '要補充 ' + want.length + ' 件') throw new Error('件数: ' + await page.textContent('#list-count'));
    if (await page.getAttribute('#btn-restock', 'aria-pressed') !== 'true') throw new Error('ボタンが押された状態になっていない');
    // カテゴリとの併用
    const cat = items.find(i => want.includes(i.item_id)).category;
    await page.selectOption('#filter-category', cat);
    await page.waitForFunction(c => { const p = document.querySelector('#filter-category'); return p.value === c; }, cat);
    await page.waitForTimeout(300);
    const both = (await cardIds()).sort();
    const wantBoth = items.filter(i => !i.is_deleted && ['残りわずか', '在庫なし'].includes(i.stock_status) && i.category === cat).map(i => i.item_id).sort();
    if (JSON.stringify(both) !== JSON.stringify(wantBoth)) throw new Error('カテゴリとの併用: ' + both);
    // 在庫を選ぶと要補充は外れる
    await page.selectOption('#filter-status', '余裕あり');
    await page.waitForFunction(() => document.querySelector('#btn-restock').getAttribute('aria-pressed') === 'false');
    await page.waitForTimeout(300);
    if (lastPayload.getItems.restock) throw new Error('在庫を選んでも要補充を送った');
    // クリアで全部に戻る
    await page.click('#btn-clear-filter');
    await page.waitForFunction(n => document.querySelectorAll('#item-list [data-item-id]').length === n, items.filter(i => !i.is_deleted).length);
    if ((await page.textContent('#list-count')).includes('要補充')) throw new Error('クリアしても要補充のまま');
  });

  await check('要補充が 0 件なら「補充が必要な備品はありません」と出し、通信の失敗とは別に表示する', async () => {
    const saved = items.map(i => i.stock_status);
    items.forEach(i => { i.stock_status = '余裕あり'; });
    try {
      await page.click('#btn-restock');
      await page.waitForSelector('#list-empty', { timeout: 5000 });
      if (!(await page.textContent('#list-empty')).includes('補充が必要な備品はありません')) throw new Error('0 件の文言');
      if ((await page.textContent('#list-count')).trim() !== '要補充 0 件') throw new Error('件数: ' + await page.textContent('#list-count'));
      await page.click('#btn-restock');                // いったん外す
      await page.waitForSelector('#item-list [data-item-id]');
      apiDrop.getItems = true;
      try {
        await page.click('#btn-restock');              // 通信できないときに要補充を押す
        await page.waitForSelector('#list-failed', { timeout: 5000 });
        if (await page.$('#list-empty')) throw new Error('通信の失敗を 0 件と表示した');
      } finally { delete apiDrop.getItems; }
    } finally {
      items.forEach((i, k) => { i.stock_status = saved[k]; });
    }
    await page.click('#btn-clear-filter');
    await page.waitForSelector('#item-list [data-item-id]');
  });

  await check('Drive の写真は表示の大きさに縮めた URL で取る', async () => {
    const it = items.find(i => i.item_id === 'ITEM-0003');
    const old = it.photo_url, oldPhotos = it.photos;
    delete it.photos;
    it.photo_url = 'https://lh3.googleusercontent.com/d/FILEID123';
    driveRequests.length = 0;
    try {
      await page.click('[data-nav="scan"]');
      await page.click('[data-nav="list"]');
      await page.waitForFunction(() => { const i = document.querySelector('[data-item-id="ITEM-0003"] img'); return i && i.src.includes('FILEID123'); });
      const thumb = await page.getAttribute('[data-item-id="ITEM-0003"] img', 'src');
      if (!thumb.endsWith('=w128-h128-c')) throw new Error('一覧の URL: ' + thumb);   // 64px × 画素密度 2
      await page.click('[data-item-id="ITEM-0003"]');
      await page.waitForSelector('#view-detail:not(.hidden) img');
      const detail = await page.getAttribute('#view-detail img', 'src');
      if (!/=w800$/.test(detail)) throw new Error('詳細の URL: ' + detail);          // 幅 390px × 2 → 800px
      await page.waitForTimeout(300);
      if (driveRequests.some(u => u.endsWith('/FILEID123'))) throw new Error('原寸を取りに行った');
    } finally {
      it.photo_url = old; it.photos = oldPhotos;
    }
  });

  await check('Drive の写真は Referer を付けずに取る（lh3 の 429 と ORB を避ける）', async () => {
    const it = items.find(i => i.item_id === 'ITEM-0003');
    const old = it.photo_url, oldPhotos = it.photos;
    delete it.photos;
    it.photo_url = 'https://lh3.googleusercontent.com/d/FILEID456';
    driveRequests.length = 0;
    driveReferers.length = 0;
    try {
      await page.click('[data-nav="scan"]');
      await page.click('[data-nav="list"]');
      await page.waitForFunction(() => { const i = document.querySelector('[data-item-id="ITEM-0003"] img'); return i && i.src.includes('FILEID456') && i.complete; });
      await page.click('[data-item-id="ITEM-0003"]');
      // 詳細はまず端末内キャッシュ（前の検証の写真）で出てから最新に替わるので、この写真になるまで待つ
      await page.waitForFunction(() => { const i = document.querySelector('#view-detail:not(.hidden) img'); return i && i.src.includes('FILEID456') && i.complete; });
      const n = driveRequests.filter(u => u.includes('FILEID456')).length;
      if (n < 2) throw new Error('一覧と詳細の写真を取りに行っていない: ' + n);
      if (driveReferers.length) throw new Error('Referer が付いた: ' + driveReferers.join(', '));
      const policies = await page.$$eval('#item-list img, #view-detail img', els => els.map(e => e.referrerPolicy));
      if (policies.some(p => p !== 'no-referrer')) throw new Error('referrerpolicy: ' + policies.join(','));
    } finally {
      it.photo_url = old; it.photos = oldPhotos;
    }
  });

  await check('QR ラベル生成ページが動く', async () => {
    const p2 = await ctx.newPage();
    await p2.goto(`http://localhost:${PORT}/qr.html`, { waitUntil: 'networkidle' });
    await p2.fill('#ids', 'ITEM-0001\nITEM-0002\nITEM-0003\nITEM-0004');
    await p2.fill('#base', 'https://example.github.io/parts/');
    await p2.click('#btn-generate');
    await p2.waitForTimeout(800);
    const n = await p2.locator('#labels canvas').count();
    if (n !== 4) throw new Error('ラベル数が ' + n);
    const f = path.join(__dirname, 'shot-8-qr.png');
    await p2.screenshot({ path: f, fullPage: true });
    shots.push(f);
    await p2.close();
  });

  // PHOTO.md 項目2: OS選択画面を迂回して両入力の同じ保存経路を確認する。
  const generatedPhoto = { name: 'generated.png', mimeType: 'image/png', buffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64') };
  for (const input of ['#f-photo', '#f-photo-album']) {
    await check('撮影/アルバムの登録・編集・取消・失敗・競合: ' + input, async () => {
      await page.click('[data-nav="new"]');
      const names = ['撮影する', 'アルバムから選ぶ'];
      for (const name of names) {
        const b = page.getByRole('button', { name, exact: true });
        await b.focus();
        if (!(await b.evaluate(e => e === document.activeElement))) throw new Error('キーボードでフォーカスできない');
        const box = await b.boundingBox();
        if (!box || box.height < 44 || box.width < 44 || box.x < 0 || box.x + box.width > 390) throw new Error('ボタンの大きさ/位置: ' + JSON.stringify(box));
      }
      if ((await page.getAttribute('#f-photo', 'capture')) !== 'environment') throw new Error('captureなし');
      if ((await page.getAttribute('#f-photo-album', 'capture')) !== null) throw new Error('アルバムにcaptureあり');
      const name = '両入力テスト' + input;
      await page.fill('#f-name', name);
      await page.setInputFiles(input, generatedPhoto);
      await page.waitForSelector('#photo-slot img');
      await page.click('#btn-photo-clear');
      if (await page.$('#photo-slot img')) throw new Error('取消で下書きが残る');
      await page.setInputFiles(input, generatedPhoto);
      await page.waitForSelector('#photo-slot img');
      apiDrop.createItem = true;
      try {
        await page.click('#item-form button[type=submit]');
        await errorToastMatching('保存できたか確認できませんでした');
        await page.waitForSelector('#view-form:not(.hidden) #photo-slot img');
        if ((await page.inputValue('#f-name')) !== name) throw new Error('失敗で入力が消える');
      } finally { delete apiDrop.createItem; }
      photoFail = true;
      try {
        await page.click('#item-form button[type=submit]');
        await page.waitForSelector('#view-detail:not(.hidden) #btn-photo-retry');
      } finally { photoFail = false; }
      await page.click('#btn-photo-retry');
      await page.waitForSelector('#saving-indicator', { state: 'detached' });
      const it = items.find(i => i.name === name);
      if (!it || !it.photo_url) throw new Error('写真の再送失敗');
      await page.click('#btn-edit');
      const original = await page.getAttribute('#photo-slot img', 'src');
      await page.setInputFiles(input, generatedPhoto);
      await page.waitForFunction(() => Array.from(document.querySelectorAll('#photo-slot img')).some(i => i.src.startsWith('data:')));
      await page.click('#btn-photo-clear');
      if ((await page.getAttribute('#photo-slot img', 'src')) !== original) throw new Error('取消で元写真に戻らない');
      await page.setInputFiles(input, generatedPhoto);
      await page.waitForFunction(() => Array.from(document.querySelectorAll('#photo-slot img')).some(i => i.src.startsWith('data:')));
      await page.fill('#f-note', '下書き');
      it.note = '他者';
      await page.click('#item-form button[type=submit]');
      await page.waitForSelector('#view-form:not(.hidden) #conflict-notice');
      if (!(await page.locator('#photo-slot img[src^="data:"]').count())) throw new Error('競合で写真が消える');
      await page.click('#item-form button[type=submit]');
      await page.waitForSelector('#saving-indicator', { state: 'detached' });
      if (it.note !== '下書き' || !it.photo_url) throw new Error('編集保存失敗');
    });
  }

  await check('8000px JPEGを1280px以下へ縮め、上限未満のJPEGで保存する', async () => {
    const source = await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 8000; c.height = 6000;
      const x = c.getContext('2d'); x.fillStyle = '#ec481f'; x.fillRect(0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.95).split(',')[1];
    });
    await page.click('[data-nav="new"]'); await page.fill('#f-name', '高画素写真');
    await page.setInputFiles('#f-photo-album', { name: 'large.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(source, 'base64') });
    await page.waitForSelector('#photo-slot img');
    const dims = await page.locator('#photo-slot img').evaluate(i => [i.naturalWidth, i.naturalHeight]);
    if (dims.join(',') !== '1280,960') throw new Error('圧縮寸法: ' + dims);
    await page.click('#item-form button[type=submit]'); await page.waitForSelector('#saving-indicator', { state: 'detached' });
    const p = lastPayload.createItem.photos[0].photo;
    if (!p || p.mimeType !== 'image/jpeg' || Buffer.from(p.data, 'base64').length > 6 * 1024 * 1024) throw new Error('保存形式/サイズ');
  });

  await check('EXIF orientation=6の写真が回転され、画素位置と保存JPEGの向きが正しい', async () => {
    const source = await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 80; c.height = 40;
      const x = c.getContext('2d'); x.fillStyle = '#ff0000'; x.fillRect(0, 0, 40, 40);
      x.fillStyle = '#0000ff'; x.fillRect(40, 0, 40, 40);
      return c.toDataURL('image/jpeg', 0.95).split(',')[1];
    });
    // EXIFのTIFF little-endian、orientation=6（90度時計回り）。画像は実物を使わず生成。
    const exif = Buffer.from('45786966000049492a0008000000010012010300010000000600000000000000', 'hex');
    const header = Buffer.alloc(4); header.writeUInt16BE(0xffe1, 0); header.writeUInt16BE(exif.length + 2, 2);
    const jpeg = Buffer.from(source, 'base64'); const oriented = Buffer.concat([jpeg.subarray(0, 2), header, exif, jpeg.subarray(2)]);
    await page.click('[data-nav="new"]'); await page.fill('#f-name', 'EXIF写真');
    await page.setInputFiles('#f-photo-album', { name: 'exif.jpg', mimeType: 'image/jpeg', buffer: oriented });
    await page.waitForSelector('#photo-slot img');
    const values = await page.locator('#photo-slot img').evaluate(i => {
      const c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight;
      const x = c.getContext('2d'); x.drawImage(i, 0, 0);
      return { w: c.width, h: c.height, top: Array.from(x.getImageData(20, 10, 1, 1).data), bottom: Array.from(x.getImageData(20, 70, 1, 1).data) };
    });
    if (values.w !== 40 || values.h !== 80 || values.top[0] < 180 || values.bottom[2] < 180) throw new Error('EXIF結果: ' + JSON.stringify(values));
    await page.click('#item-form button[type=submit]'); await page.waitForSelector('#saving-indicator', { state: 'detached' });
    if (lastPayload.createItem.photos[0].photo.mimeType !== 'image/jpeg') throw new Error('保存形式');
  });

  await check('非画像・読めない画像・canvas例外で対処を表示し以前の下書きを保つ', async () => {
    await page.click('[data-nav="new"]'); await page.fill('#f-name', '下書き保持');
    await page.setInputFiles('#f-photo-album', generatedPhoto); await page.waitForSelector('#photo-slot img');
    const original = await page.getAttribute('#photo-slot img', 'src');
    for (const f of [{ name: 'text.txt', mimeType: 'text/plain', buffer: Buffer.from('text') },
      { name: 'fake.heic', mimeType: 'image/heic', buffer: Buffer.from('unsupported') }]) {
      await page.setInputFiles('#f-photo-album', f);
      await page.waitForFunction(() => document.querySelector('#photo-error').textContent.includes('JPEG'));
      if ((await page.getAttribute('#photo-slot img', 'src')) !== original) throw new Error('下書きを消した');
      if (await page.isVisible('#loading')) throw new Error('処理中が残る');
    }
    await page.evaluate(() => { window.__toDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = () => { throw new Error('模擬canvas失敗'); }; });
    try {
      await page.setInputFiles('#f-photo-album', generatedPhoto);
      await page.waitForFunction(() => document.querySelector('#photo-error').textContent.includes('小さいJPEG'));
      if ((await page.getAttribute('#photo-slot img', 'src')) !== original) throw new Error('canvas失敗で下書きを消した');
      if (await page.isVisible('#loading')) throw new Error('処理中が残る');
    } finally { await page.evaluate(() => { HTMLCanvasElement.prototype.toDataURL = window.__toDataURL; }); }
  });

  // PHOTO.md 項目5: 全置換APIを使う複数写真の操作と失敗回復。
  const waitPhotos = async n => page.waitForFunction(n => document.querySelectorAll('#photo-slot [data-form-photo]').length === n && document.querySelector('#loading').classList.contains('hidden'), n);
  let multi;
  await check('複数選択・上限・代表・取り外し・取消をモバイルで保存する', async () => {
    await page.click('[data-nav="new"]'); await page.fill('#f-name', '複数写真');
    if (await page.getAttribute('#f-photo-album', 'multiple') === null) throw new Error('multipleなし');
    await page.setInputFiles('#f-photo-album', Array.from({ length: 5 }, (_, i) => ({ ...generatedPhoto, name: 'over' + i + '.png' })));
    await page.waitForFunction(() => document.querySelector('#photo-error').textContent.includes('あと4枚'));
    if (await page.locator('#photo-slot img').count()) throw new Error('超過選択を追加した');
    await page.setInputFiles('#f-photo-album', Array.from({ length: 4 }, (_, i) => ({ ...generatedPhoto, name: 'multi' + i + '.png' })));
    await waitPhotos(4);
    for (const id of ['#btn-photo-pick', '#btn-photo-album']) if (!(await page.isDisabled(id))) throw new Error('上限で無効にならない');
    if (!(await page.textContent('#photo-limit')).includes('外してください')) throw new Error('上限の対処なし');
    await page.getByRole('button', { name: '写真3を代表にする', exact: true }).click();
    await page.screenshot({ path: path.join(__dirname, 'shot-9-photos-form.png'), fullPage: true });
    await page.click('#item-form button[type=submit]'); await page.waitForSelector('#saving-indicator', { state: 'detached' });
    multi = items.find(i => i.name === '複数写真');
    if (multi.photos.length !== 4 || multi.photo_url !== multi.photos[2].url) throw new Error('4枚/代表保存');
    if (await page.locator('#view-detail [data-detail-photo]').count() !== 4) throw new Error('詳細の全写真');
    await page.click('#btn-edit');
    await page.getByRole('button', { name: '写真3を外す', exact: true }).click();
    if (!(await page.textContent('#photo-slot figure:first-child')).includes('代表')) throw new Error('代表を外した後の先頭');
    await page.click('#btn-photo-clear'); await waitPhotos(4);
    if (await page.getByRole('button', { name: '写真3を代表にする', exact: true }).getAttribute('aria-pressed') !== 'true') throw new Error('取消で代表が戻らない');
    await page.getByRole('button', { name: '写真3を外す', exact: true }).click();
    await page.click('#item-form button[type=submit]'); await page.waitForSelector('#saving-indicator', { state: 'detached' });
    if (multi.photos.length !== 3 || multi.photo_url !== multi.photos[0].url) throw new Error('取り外し保存');
  });

  await check('一覧は代表1枚だけ取得、拡大は操作後に取得しEscape/閉じるでフォーカスを戻す', async () => {
    driveRequests.length = 0;
    await page.click('[data-nav="list"]');
    const row = page.locator('[data-item-id="' + multi.item_id + '"]'); await row.scrollIntoViewIfNeeded();
    await page.waitForFunction(id => { const img = document.querySelector('[data-item-id="' + id + '"] img'); return img && img.complete; }, multi.item_id);
    if (await row.locator('img').count() !== 1) throw new Error('一覧で複数画像');
    for (const p of multi.photos.slice(1)) if (driveRequests.some(u => u.includes('/d/' + p.url.split('/').pop()))) throw new Error('一覧で非代表を取得');
    if (!(await row.locator('img').getAttribute('src')).includes(multi.photo_url.split('/').pop())) throw new Error('一覧の代表');
    await row.click(); await page.waitForSelector('#view-detail:not(.hidden)');
    const b = page.getByRole('button', { name: '写真2を拡大', exact: true }); await b.focus(); await page.keyboard.press('Enter');
    await page.getByRole('dialog', { name: '写真2の拡大', exact: true }).waitFor();
    if (await page.locator('dialog img').getAttribute('referrerpolicy') !== 'no-referrer') throw new Error('拡大のReferer');
    await page.keyboard.press('Escape'); await page.waitForSelector('dialog', { state: 'detached' });
    if (!(await b.evaluate(e => e === document.activeElement))) throw new Error('Escape後のフォーカス');
    await b.click(); await page.getByRole('button', { name: '閉じる', exact: true }).click();
    await page.waitForSelector('dialog', { state: 'detached' });
    if (!(await b.evaluate(e => e === document.activeElement))) throw new Error('閉じる後のフォーカス');
  });

  await check('部分失敗だけ新操作で再送し、成功参照・順序・希望の代表を保持する', async () => {
    await page.click('[data-nav="new"]'); await page.fill('#f-name', '部分失敗写真');
    await page.setInputFiles('#f-photo-album', [generatedPhoto, { ...generatedPhoto, name: 'second.png' }]); await waitPhotos(2);
    await page.getByRole('button', { name: '写真2を代表にする', exact: true }).click();
    photoFailAt = 2;
    try { await page.click('#item-form button[type=submit]'); await page.waitForSelector('#view-detail:not(.hidden) #btn-photo-retry'); }
    finally { photoFailAt = 0; }
    const it = items.find(i => i.name === '部分失敗写真'), first = it.photos[0], writes = photoWrites;
    if (!(await page.textContent('#photo-retry')).includes('写真2')) throw new Error('失敗の写真番号なし');
    const createOp = opCalls.filter(c => c.action === 'createItem').at(-1).op_id;
    await page.click('#btn-photo-retry'); await page.waitForSelector('#saving-indicator', { state: 'detached' });
    const sent = lastPayload.updateItem;
    if (sent.photos[0].url !== first.url || sent.photos[0].photo || !sent.photos[1].photo) throw new Error('成功参照/失敗画像の再送');
    if (it.photos.length !== 2 || photoWrites !== writes + 1 || it.photo_url !== it.photos[1].url) throw new Error('順序/代表/重複');
    if (opCalls.filter(c => c.action === 'updateItem').at(-1).op_id === createOp) throw new Error('部分成功で旧操作ID再利用');
  });

  await check('部分失敗から編集しても失敗下書きと代表の希望を保持し、保存後は再送案内を消す', async () => {
    await page.click('[data-nav="new"]'); await page.fill('#f-name', '部分失敗から編集');
    await page.setInputFiles('#f-photo-album', [generatedPhoto, generatedPhoto]); await waitPhotos(2);
    await page.getByRole('button', { name: '写真2を代表にする', exact: true }).click();
    photoFailAt = 2;
    try { await page.click('#item-form button[type=submit]'); await page.waitForSelector('#view-detail:not(.hidden) #btn-photo-retry'); }
    finally { photoFailAt = 0; }
    await page.click('#btn-edit');
    if (await page.locator('#photo-slot img[src^="data:"]').count() !== 1) throw new Error('編集へ戻ると失敗下書きが消える');
    if (await page.getByRole('button', { name: '写真2を代表にする', exact: true }).getAttribute('aria-pressed') !== 'true') throw new Error('代表の希望を失った');
    await page.fill('#f-note', '編集から回復');
    await page.click('#item-form button[type=submit]'); await page.waitForSelector('#saving-indicator', { state: 'detached' });
    const it = items.find(i => i.name === '部分失敗から編集');
    if (it.photos.length !== 2 || it.photo_url !== it.photos[1].url || await page.locator('#photo-retry').count()) throw new Error('編集回復後の状態');
  });

  await check('写真再送の応答喪失後も同じ操作ID・payload・版で確認し重複しない', async () => {
    await page.click('[data-nav="new"]'); await page.fill('#f-name', '再送応答喪失');
    await page.setInputFiles('#f-photo-album', [generatedPhoto, generatedPhoto]); await waitPhotos(2);
    photoFail = true;
    try { await page.click('#item-form button[type=submit]'); await page.waitForSelector('#view-detail:not(.hidden) #btn-photo-retry'); }
    finally { photoFail = false; }
    const before = opCalls.length, writes = photoWrites;
    apiLose.updateItem = Infinity;
    try { await page.click('#btn-photo-retry'); await errorToastMatching('写真を保存できたか確認できませんでした'); }
    finally { delete apiLose.updateItem; }
    const attempts = opCalls.slice(before);
    await page.click('#btn-photo-retry'); await page.waitForSelector('#saving-indicator', { state: 'detached' });
    const final = opCalls.at(-1);
    if (attempts.some(c => c.op_id !== final.op_id || JSON.stringify({ ...c.payload, op_attempt: 0 }) !== JSON.stringify({ ...final.payload, op_attempt: 0 }))) throw new Error('不明結果の送信内容が変化');
    if (photoWrites !== writes + 2 || items.find(i => i.name === '再送応答喪失').photos.length !== 2) throw new Error('再送で重複');
  });

  await check('写真競合で他者の4枚を保持し、追加下書きを待機させ利用者が再判断する', async () => {
    await openDetailOf(multi.item_id); await page.click('#btn-edit');
    await page.setInputFiles('#f-photo-album', generatedPhoto); await waitPhotos(4);
    const old = multi.photos.slice();
    const other = { id: 'other-new', url: 'https://lh3.googleusercontent.com/d/other-new' };
    multi.photos = old.concat([other]); multi.photo_url = other.url;
    await page.click('#item-form button[type=submit]'); await page.waitForSelector('#view-form:not(.hidden) #conflict-notice');
    await waitPhotos(5);
    if (await page.locator('#photo-slot img[src^="data:"]').count() !== 1) throw new Error('新規下書きを消した');
    if (!(await page.textContent('#photo-slot')).includes('待機中')) throw new Error('上限下書きの待機なし');
    await page.click('#item-form button[type=submit]');
    await page.waitForFunction(() => document.querySelector('#photo-error').textContent.includes('待機中'));
    if (multi.photos.length !== 4) throw new Error('待機を黙って保存した');
    await page.getByRole('button', { name: '写真1を外す', exact: true }).click();
    await page.getByRole('button', { name: '追加する', exact: true }).click(); await waitPhotos(4);
    await page.click('#item-form button[type=submit]'); await page.waitForSelector('#saving-indicator', { state: 'detached' });
    if (multi.photos.length !== 4 || !multi.photos.some(p => p.id === other.id)) throw new Error('他者写真を消した');
  });

  await check('詳細の失敗表示と再読み込みは写真ごとで、成功写真を再取得しない', async () => {
    const stamp = Date.now();
    multi.photos = [{ id: 'ok', url: `http://localhost:${PORT}/mockphoto/ok-multi-${stamp}` }, { id: 'bad', url: `http://localhost:${PORT}/mockphoto/fail2-multi-${stamp}` }];
    multi.photo_url = multi.photos[0].url;
    await openDetailOf(multi.item_id);
    await page.waitForSelector('#view-detail [data-detail-photo="bad"] [data-photo-failed]');
    const goodCount = photoCount(multi.photos[0].url);
    if (!(await page.textContent('#view-detail [data-detail-photo="bad"]')).includes('写真2を読み込めなかった')) throw new Error('失敗番号なし');
    await page.locator('#view-detail [data-detail-photo="bad"] [data-photo-reload]').click();
    await page.waitForFunction(() => { const i = document.querySelector('#view-detail [data-detail-photo="bad"] img'); return i && i.complete && i.naturalWidth; });
    if (photoCount(multi.photos[0].url) !== goodCount || photoCount(multi.photos[1].url) !== 3) throw new Error('個別再取得の要求数');
    await page.screenshot({ path: path.join(__dirname, 'shot-10-photos-detail.png'), fullPage: true });
  });

  for (const recovery of ['写真再送', '編集', '上限で待機']) {
    await check('部分成功の応答喪失→他者写真追加→同ID確認で他者の写真を保持: ' + recovery, async () => {
      const name = '応答喪失他者追加-' + recovery;
      await page.click('[data-nav="new"]'); await page.fill('#f-name', name);
      await page.setInputFiles('#f-photo-album', [generatedPhoto, generatedPhoto]); await waitPhotos(2);
      await page.getByRole('button', { name: '写真2を代表にする', exact: true }).click();
      photoFailAt = 2; apiLose.createItem = Infinity;
      try {
        await page.click('#item-form button[type=submit]');
        await errorToastMatching('保存できたか確認できませんでした');
        await page.waitForSelector('#view-form:not(.hidden) #photo-slot img');
      } finally { photoFailAt = 0; delete apiLose.createItem; }
      const it = items.find(i => i.name === name);
      if (!it || it.photos.length !== 1) throw new Error('部分成功になっていない');
      const other = Array.from({ length: recovery === '上限で待機' ? 3 : 1 }, (_, i) => ({
        id: 'other-' + ['写真再送', '編集', '上限で待機'].indexOf(recovery) + '-' + i,
        url: 'https://lh3.googleusercontent.com/d/other-' + Date.now() + '-' + i
      }));
      it.photos = it.photos.concat(other); it.photo_url = other.at(-1).url;
      await page.click('#item-form button[type=submit]');
      await page.waitForSelector('#view-detail:not(.hidden) #btn-photo-retry');
      const before = opCalls.filter(c => c.action === 'updateItem').length;
      await page.click(recovery === '編集' ? '#btn-edit' : '#btn-photo-retry');
      await page.waitForFunction(() => !document.querySelector('#view-form').classList.contains('hidden') || !document.querySelector('#saving-indicator'));
      if (opCalls.filter(c => c.action === 'updateItem').length !== before) throw new Error('他者変更を再確認せず再送して写真を取り外した');
      await page.waitForSelector('#view-form:not(.hidden) #conflict-notice', { timeout: 5000 });
      for (const p of other) if (!(await page.locator('[data-form-photo="' + p.id + '"]').count())) throw new Error('他者の写真が下書きに無い');
      if (!(await page.textContent('#conflict-notice')).includes('代表')) throw new Error('代表/取り外しの再確認案内なし');
      if (recovery === '上限で待機') {
        if (!(await page.textContent('#photo-slot')).includes('待機中')) throw new Error('失敗下書きの待機なし');
        await page.getByRole('button', { name: '写真1を外す', exact: true }).click();
        await page.getByRole('button', { name: '追加する', exact: true }).click();
      }
      const n = recovery === '上限で待機' ? 4 : 3;
      await page.getByRole('button', { name: '写真' + n + 'を代表にする', exact: true }).click();
      await page.click('#item-form button[type=submit]'); await page.waitForSelector('#saving-indicator', { state: 'detached' });
      for (const p of other) if (!it.photos.some(x => x.id === p.id)) throw new Error('保存後に他者写真が消えた');
      if (it.photos.length !== n || it.photo_url !== it.photos.at(-1).url) throw new Error('回復後の枚数/代表');
    });
  }


  await check('検索・絞り込み・備品ID入力に読み上げ名がある', async () => {
    await page.click('[data-nav="list"]');
    for (const [role, name] of [['searchbox', '備品を検索'], ['combobox', '在庫で絞り込む'], ['combobox', 'カテゴリで絞り込む'], ['combobox', '場所で絞り込む']]) {
      if (await page.getByRole(role, { name, exact: true }).count() !== 1) throw new Error('入力名なし: ' + name);
    }
    await page.click('[data-nav="scan"]');
    if (await page.getByLabel('読み取れないときは備品IDを直接入力', { exact: true }).count() !== 1) throw new Error('備品IDのラベルなし');
    await page.click('[data-nav="list"]');
  });

  await check('保存の通信期限後も下書きと操作IDを保ち、同じ操作で結果を確認する', async () => {
    await page.click('[data-nav="new"]'); await page.fill('#f-name', '期限切れ登録');
    const from = opCalls.length;
    apiDelay.createItem = 2000;
    await page.evaluate(() => { window.APP_CONFIG.API_WRITE_TIMEOUT_MS = 100; });
    try {
      await page.click('#item-form button[type=submit]');
      await errorToastMatching('確認できませんでした');
      await page.waitForSelector('#view-form:not(.hidden) #f-name');
      if (await page.inputValue('#f-name') !== '期限切れ登録') throw new Error('期限後の下書きが消えた');
    } finally {
      delete apiDelay.createItem;
      await page.evaluate(() => { delete window.APP_CONFIG.API_WRITE_TIMEOUT_MS; });
    }
    await page.click('#item-form button[type=submit]');
    await page.waitForSelector('#saving-indicator', { state: 'detached', timeout: 5000 });
    const sent = opsOf('createItem', from);
    if (new Set(sent.map(c => c.op_id)).size !== 1 || [...new Set(sent.map(c => c.op_attempt))].join(',') !== '1,2,3,4') throw new Error('期限後の同ID確認: ' + JSON.stringify(sent));
    if (countByName('期限切れ登録') !== 1) throw new Error('期限後に二重登録');
  });

  await check('JS エラーが出ていない', async () => {
    // 写真の読み直しの検証でわざと失敗させた 500 は除く
    const real = errors.filter(e => !/favicon|net::ERR|status of 500/.test(e));
    if (real.length) throw new Error(real.join(' | '));
  });

  console.log('\nスクリーンショット: ' + shots.map(s => path.basename(s)).join(', '));
  console.log(fail ? '\n===== ' + fail + ' failed =====\n' : '\n===== すべて成功 =====\n');

  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})();
