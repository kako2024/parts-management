/** PHOTO.md 項目7: 場面Dだけをローカル模擬。実GASへの接続・書き込みは行わない。 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');
const assert = require('assert');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..');
const BASE = '1e5c47ecb1b3277463dc9145f5cd6f97e27d7fc5';
const FAST_4G = { offline: false, latency: 165, downloadThroughput: 9e6 / 8 * 0.9, uploadThroughput: 1.5e6 / 8 * 0.9 };
const oldFiles = {};
for (const name of fs.readdirSync(path.join(ROOT, 'docs')).filter(n => /\.(js|css|html)$/.test(n))) {
  oldFiles[name] = execFileSync('git', ['show', BASE + ':docs/' + name]);
}
const variants = ['old1', 'new1', 'new4'];
let variant, images, origin, requests = [], apiActions = [];
const items = () => Array.from({ length: 20 }, (_, i) => {
  const photos = Array.from({ length: variant === 'new4' ? 4 : 1 }, (_, j) => ({ id: `p-${i}-${j}`, url: `https://lh3.googleusercontent.com/d/${i}-${j}` }));
  return { item_id: 'ITEM-' + String(i + 1).padStart(4, '0'), name: '計測用生成写真 ' + i, category: '模擬', location: '模擬', stock_status: '余裕あり', quantity: 1,
    photo_url: photos[0].url, photos, note: '', updated_at: '2026-10-06 00:00:00', updated_by: 'test@example.com', is_deleted: false, version: 'mock' };
});
const certDir=fs.mkdtempSync(path.join(os.tmpdir(),'parts-photo-perf-'));
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(certDir,'key.pem'),'-out',path.join(certDir,'cert.pem'),'-subj','/CN=localhost','-days','1'],{stdio:'ignore'});
const tls={key:fs.readFileSync(path.join(certDir,'key.pem')),cert:fs.readFileSync(path.join(certDir,'cert.pem'))};
fs.rmSync(certDir,{recursive:true});
const server = https.createServer(tls, (req, res) => {
  const name = req.url.split('?')[0].slice(1) || 'index.html';
  if (name.startsWith('photo/')) {
    requests.push({ url: name, referer: req.headers.referer || '' });
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
    return res.end(name.includes('=w64-h64-c') ? images.thumb : images.detail);
  }
  if (name === 'api') {
    let body = ''; req.on('data', c => body += c);
    return req.on('end', () => {
      const { action, payload } = JSON.parse(body); apiActions.push(action);
      let data;
      if (action === 'loginCheck') data = { user: { email: 'test@example.com', name: '模擬' }, stockStatuses: ['余裕あり','残りわずか','在庫なし'], categories: ['模擬'], locations: ['模擬'], items: items(), total: 20 };
      else if (action === 'getItems') data = { items: items(), total: 20 };
      else if (action === 'getItem') data = { item: items().find(i => i.item_id === payload.item_id), logs: [] };
      else { res.writeHead(400); return res.end('模擬計測は読み取りのみ'); }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      // 初回画像計測中の背景応答によるDOM差し替えを避ける。全版で同じ条件。
      setTimeout(() => res.end(JSON.stringify({ ok: true, data })), action === 'getItem' ? 10000 : 0).unref();
    });
  }
  if (name === 'config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end(`window.APP_CONFIG={GAS_API_URL:'${origin}/api',GOOGLE_CLIENT_ID:'mock.apps.googleusercontent.com',APP_NAME:'模擬',PHOTO_MAX_EDGE:1280,PHOTO_QUALITY:0.82,MAX_PHOTOS:4};`);
  }
  if (!/^[\w.-]+$/.test(name) || !fs.existsSync(path.join(ROOT, 'docs', name))) { res.writeHead(404); return res.end(); }
  const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(name)];
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  let content=variant === 'old1' ? oldFiles[name] : fs.readFileSync(path.join(ROOT, 'docs', name));
  // 同じ時点の画面内枚数を観測するだけ。計測の動作は元関数に委ねる。
  if(name==='perf.js') content=content.toString()+`
window.__photoWatch=[];const originalWatch=window.PERF.watchImages;window.PERF.watchImages=function(key,root){window.__photoWatch.push({key,count:[...root.querySelectorAll('img')].filter(i=>{if(!i.getClientRects().length)return false;const r=i.getBoundingClientRect();return r.bottom>=0&&r.top<innerHeight;}).length});return originalWatch.apply(this,arguments);};`;
  res.end(content);
});
const median = a => a.slice().sort((x,y) => x-y)[Math.floor(a.length/2)];
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  origin = 'https://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  const results = [];
  try {
    const generator = await browser.newPage();
    const generated = await generator.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 640; c.height = 480;
      const ctx = c.getContext('2d'), pixels = ctx.createImageData(640,480);
      let seed = 12345;
      for (let n=0; n<pixels.data.length; n+=4) {
        seed = (Math.imul(seed,1664525)+1013904223)>>>0;
        pixels.data[n]=seed>>>24; pixels.data[n+1]=seed>>>16; pixels.data[n+2]=seed>>>8; pixels.data[n+3]=255;
      }
      ctx.putImageData(pixels,0,0);
      const detail=c.toDataURL('image/jpeg',0.82).split(',')[1];
      const t=document.createElement('canvas');t.width=64;t.height=64;t.getContext('2d').drawImage(c,0,0,64,64);
      return { detail, thumb:t.toDataURL('image/jpeg',0.82).split(',')[1] };
    });
    images={detail:Buffer.from(generated.detail,'base64'),thumb:Buffer.from(generated.thumb,'base64')};
    await generator.close();
    for (let round=1; round<=5; round++) for (variant of variants) {
      requests=[]; apiActions=[];
      const ctx = await browser.newContext({ viewport: { width:430,height:932 }, deviceScaleFactor:1, ignoreHTTPSErrors:true });
      // CDN/GISは固定応答。Drive URLをcontinueでローカルHTTPへ送り、実転送をCDP制約下で行う。
      await ctx.route('https://**', r => {
        if(new URL(r.request().url()).hostname==='127.0.0.1') return r.continue();
        if (r.request().url().startsWith('https://cdn.tailwindcss.com')) return r.fulfill({ contentType:'text/javascript', body:fs.readFileSync(process.env.TAILWIND_SCRIPT || '/tmp/parts-tailwindcdn.js','utf8') });
        return r.fulfill({ contentType:'text/javascript',body:'' });
      });
      await ctx.route('https://lh3.googleusercontent.com/**', r => r.continue({ url: origin+'/photo/'+r.request().url().split('/d/')[1] }));
      await ctx.addInitScript(() => {
        localStorage.removeItem('parts-cache:v1'); localStorage.setItem('perf:log','[]');
        window.google={accounts:{id:{initialize(c){window.login=c.callback;},renderButton(el){const b=document.createElement('button');b.id='mock-signin';b.textContent='模擬ログイン';b.onclick=()=>window.login({credential:'x.'+btoa(JSON.stringify({email:'test@example.com',exp:Math.floor(Date.now()/1000)+3600}))+'.x'});el.appendChild(b);},prompt(){},disableAutoSelect(){}}}};
      });
      const page = await ctx.newPage();
      const errors=[]; page.on('pageerror',e=>errors.push(e.message));
      const cdp=await ctx.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions',FAST_4G);
      await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
      await page.goto(origin+'/?perf=1',{waitUntil:'networkidle'});
      await page.click('#mock-signin');
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('perf:log')||'[]').some(r=>r.scene==='D 一覧写真'&&!/失敗|中断/.test(r.note)));
      await page.waitForSelector('#loading', { state: 'hidden' });
      assert.strictEqual(await page.locator('#item-list img').count(),20);
      const listRequests=requests.map(r=>r.url);
      assert(listRequests.every(u=>/-0=w64-h64-c$/.test(u)), '一覧が代表以外を取得');
      const visible=await page.locator('#item-list img').evaluateAll(imgs=>imgs.filter(i=>{const r=i.getBoundingClientRect();return r.bottom>=0&&r.top<innerHeight;}).length);
      const listLog=await page.evaluate(()=>JSON.parse(localStorage.getItem('perf:log')).filter(r=>r.scene==='D 一覧写真'&&!/失敗|中断/.test(r.note)).at(-1));
      assert.strictEqual(listLog.note, visible+'枚');
      requests=[];
      await page.click('#item-list [data-item-id="ITEM-0001"]');
      await page.waitForSelector('#view-detail:not(.hidden)');
      await page.waitForSelector('#loading', { state: 'hidden' });
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('perf:log')||'[]').some(r=>r.scene==='D 詳細写真'&&!/失敗|中断/.test(r.note)));
      const detailLog=await page.evaluate(()=>JSON.parse(localStorage.getItem('perf:log')).filter(r=>r.scene==='D 詳細写真'&&!/失敗|中断/.test(r.note)).at(-1));
      assert.strictEqual(await page.locator('#view-detail img').count(),variant==='new4'?4:1);
      const detailVisible=await page.locator('#view-detail img').evaluateAll(imgs=>imgs.filter(i=>{const r=i.getBoundingClientRect();return r.bottom>=0&&r.top<innerHeight;}).length);
      const detailAtStart=await page.evaluate(()=>window.__photoWatch.filter(r=>r.key==='D 詳細写真').at(-1).count);
      assert.strictEqual(detailLog.note,detailAtStart+'枚');
      assert(requests.every(r=>!r.referer),'写真のReferer');
      assert(apiActions.every(a=>['loginCheck','getItems','getItem'].includes(a)));
      assert.deepStrictEqual(errors,[]);
      results.push({variant,round,list:listLog,detail:detailLog,listVisible:visible,listRequests:listRequests.length,detailVisible,detailAtStart});
      console.log(`${variant} #${round}: list=${listLog.ms}ms (${visible}枚/${listRequests.length}要求) detail=${detailLog.ms}ms (開始${detailAtStart}枚/読込後${detailVisible}枚)`);
      await ctx.close();
    }
    const summary=variants.map(v=>{const rows=results.filter(r=>r.variant===v);return {variant:v,listMedian:median(rows.map(r=>r.list.ms)),detailMedian:median(rows.map(r=>r.detail.ms))};});
    const before=summary[0], after=summary[1];
    // タイマー/描画の揺れを許容。同条件1枚が100msか20%の大きい方を超えて遅ければ失敗。
    for(const key of ['listMedian','detailMedian']) assert(after[key]<=before[key]+Math.max(100,before[key]*0.2),key+'が悪化');
    const out={env:{at:new Date().toISOString(),browser:browser.version(),baseline:BASE,rounds:5,viewport:'430x932',fast4G:FAST_4G,cache:'無効',items:20,photoItems:20,imageBytes:{thumb:images.thumb.length,detail:images.detail.length},getItemDelayMs:10000,cdn:'同じ保存済み応答',cpu:'既定（PERF.mdと同じ）',api:'ローカル模擬'},summary,results};
    fs.writeFileSync(path.join(__dirname,'photo-perf-result.json'),JSON.stringify(out,null,2)+'\n');
    console.log(JSON.stringify(summary));
  } finally { await browser.close(); server.close(); }
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
