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

function handleApi(body) {
  const { action, payload = {} } = JSON.parse(body);
  const live = () => items.filter(i => !i.is_deleted);
  switch (action) {
    case 'loginCheck':
      return { ok: true, data: {
        user: { email: 'taro@example.com', name: 'テスト太郎', picture: '' },
        stockStatuses: ['余裕あり', '残りわずか', '在庫なし'],
        categories: ['IT機器', '事務用品', '消耗品'],
        locations: ['本館-1F-倉庫', '本館-3F-A棚-2段', '本館-3F-B棚-1段'],
        itemCount: live().length, serverTime: '2026-08-13 10:00:00'
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
      logs.push({ log_id: 'LOG-20260813-00' + (logs.length + 1), timestamp: '2026-08-13 10:05:00', item_id: it.item_id, user_email: 'taro@example.com', action_type: 'UPDATE_STATUS', before_state: JSON.stringify({ stock_status: before }), after_state: JSON.stringify({ stock_status: it.stock_status }) });
      return { ok: true, data: { item: it } };
    }
    case 'createItem': {
      const id = 'ITEM-000' + (items.length + 1);
      const it = Object.assign({ item_id: id, photo_url: payload.photo ? 'https://lh3.googleusercontent.com/d/mock' : '', is_deleted: false, updated_at: '2026-08-13 10:10:00', updated_by: 'taro@example.com' }, payload);
      delete it.photo;
      items.push(it);
      return { ok: true, data: { item: it } };
    }
    case 'updateItem': {
      const it = items.find(i => i.item_id === payload.item_id);
      Object.assign(it, payload);
      return { ok: true, data: { item: it } };
    }
    case 'deleteItem': {
      const it = items.find(i => i.item_id === payload.item_id);
      it.is_deleted = true;
      return { ok: true, data: { item: it } };
    }
    default:
      return { ok: false, error: { code: 'UNKNOWN_ACTION', message: 'unknown', status: 400 } };
  }
}

/* ---------- 静的配信 + API ---------- */
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(handleApi(body)));
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
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
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
  await ctx.addInitScript(() => {
    window.google = { accounts: { id: {
      initialize(cfg) { window.__gsiCallback = cfg.callback; },
      renderButton(el) {
        const b = document.createElement('button');
        b.textContent = 'Google でログイン（モック）';
        b.id = 'mock-signin';
        b.className = 'h-11 px-6 rounded-full bg-blue-600 text-white font-semibold';
        b.onclick = () => window.__gsiCallback({ credential:
          'eyJhbGciOiJIUzI1NiJ9.' + btoa(JSON.stringify({ exp: Math.floor(Date.now()/1000)+3600 })) + '.sig' });
        el.appendChild(b);
      },
      prompt() {}, disableAutoSelect() {}
    } } };
  });

  const page = await ctx.newPage();
  const errors = [];
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
    await page.fill('#manual-id', 'ITEM-0001');
    await page.click('#btn-manual-go');
    await page.waitForSelector('#view-detail h2', { timeout: 5000 });
    const t = await page.textContent('#view-detail h2');
    if (!t.includes('コピー用紙')) throw new Error('見出しが ' + t);
  });
  await snap('7-scan-manual');

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
    const real = errors.filter(e => !/favicon|net::ERR/.test(e));
    if (real.length) throw new Error(real.join(' | '));
  });

  console.log('\nスクリーンショット: ' + shots.map(s => path.basename(s)).join(', '));
  console.log(fail ? '\n===== ' + fail + ' failed =====\n' : '\n===== すべて成功 =====\n');

  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})();
