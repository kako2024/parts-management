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
function handleApi(body) {
  const { action, payload = {}, idToken } = JSON.parse(body);
  apiCalls.push(action);
  const live = () => items.filter(i => !i.is_deleted);
  switch (action) {
    case 'loginCheck':
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
      const before = it.stock_status;
      it.stock_status = payload.stock_status;
      it.updated_at = '2026-08-13 10:05:00';
      const log = addLog(it.item_id, 'UPDATE_STATUS', { stock_status: before }, { stock_status: it.stock_status });
      return { ok: true, data: { item: it, log } };
    }
    case 'createItem': {
      const id = 'ITEM-000' + (items.length + 1);
      const it = Object.assign({ item_id: id, photo_url: payload.photo ? 'https://lh3.googleusercontent.com/d/mock' : '', is_deleted: false, updated_at: '2026-08-13 10:10:00', updated_by: 'taro@example.com' }, payload);
      delete it.photo;
      items.push(it);
      const log = addLog(it.item_id, 'CREATE', '', { name: it.name, stock_status: it.stock_status });
      return { ok: true, data: { item: it, log } };
    }
    case 'updateItem': {
      const it = items.find(i => i.item_id === payload.item_id);
      const patch = Object.assign({}, payload);
      delete patch.item_id;
      Object.assign(it, patch);
      const log = addLog(it.item_id, 'UPDATE', {}, patch);
      return { ok: true, data: { item: it, log } };
    }
    case 'deleteItem': {
      const it = items.find(i => i.item_id === payload.item_id);
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
    if (req.url.includes('broken') || (req.url.includes('flaky') && n === 1)) {
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
    return res.end(`window.APP_CONFIG={GAS_API_URL:'http://localhost:${PORT}/api',GOOGLE_CLIENT_ID:'test.apps.googleusercontent.com',APP_NAME:'備品管理',PHOTO_MAX_EDGE:1280,PHOTO_QUALITY:0.82};`);
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
  await ctx.route('https://lh3.googleusercontent.com/**', r => { driveRequests.push(r.request().url()); r.fulfill({ status: 200, contentType: 'image/png',
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
  const check = async (label, fn) => {
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
      if (await page.$('[data-item-id="ITEM-0002"] img')) throw new Error('2 回失敗した写真が灰色の枠になっていない');
    } finally {
      a.photo_url = oldA;
      b2.photo_url = oldB;
    }
  });

  await check('Drive の写真は表示の大きさに縮めた URL で取る', async () => {
    const it = items.find(i => i.item_id === 'ITEM-0003');
    const old = it.photo_url;
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
      it.photo_url = old;
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
