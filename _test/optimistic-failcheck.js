/**
 * 更新の即時反映（PERF.md 項目 6）で、API が失敗したときに表示が元に戻り、失敗が通知されることを
 * 本番の GAS を相手に実ブラウザで確かめる（PERF.md 4.4）。
 *
 * perf-measure.js と同じく、計測用 Chromium（--remote-debugging-port=9222）で ?perf=1 のアプリを開いておき、
 * 環境変数 TOK に計測用の認証省略トークンを渡して実行する。GAS への要求を CDP で保留させ、
 * 押した直後の表示を読んでから通信エラーで失敗させる（本番のデータは変わらない）。
 *
 *   TOK=＜トークン＞ [SHOT=画面.png] node _test/optimistic-failcheck.js
 */
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = b.contexts()[0];
  const page = ctx.pages().find(p => p.url().startsWith('http://localhost:8000'));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await page.evaluate((t) => localStorage.setItem('perf:bypassToken', t), process.env.TOK);
  await page.reload();
  await page.waitForSelector('#item-list [data-item-id]');
  await page.waitForFunction(() => document.getElementById('loading').classList.contains('hidden'));
  await page.waitForTimeout(4000); // 起動時の最新取得を終わらせる
  const id = await page.getAttribute('#item-list [data-item-id]', 'data-item-id');
  await page.click('[data-item-id="' + id + '"]');
  await page.waitForTimeout(5000); // 詳細の最新取得を終わらせる
  const before = (await page.textContent('#view-detail .badge')).trim();
  const next = before === '在庫なし' ? '余裕あり' : '在庫なし';
  // GAS への要求を保留させ、押した直後の表示を読んでから通信エラーで失敗させる
  let paused = null;
  const gotPaused = new Promise(r => cdp.on('Fetch.requestPaused', e => { paused = e.requestId; r(); }));
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*script.google.com*' }] });
  await page.click('[data-set-status="' + next + '"]');
  await gotPaused;
  const shown = (await page.textContent('#view-detail .badge')).trim();
  const indicator = await page.isVisible('#saving-indicator');
  await cdp.send('Fetch.failRequest', { requestId: paused, errorReason: 'ConnectionFailed' });
  const toast = await page.waitForSelector('.toast-error', { timeout: 15000 }).then(t => t.textContent());
  const after = (await page.textContent('#view-detail .badge')).trim();
  await cdp.send('Fetch.disable');
  const shot = process.env.SHOT; if (shot) await page.screenshot({ path: shot });
  await page.evaluate(() => localStorage.removeItem('perf:bypassToken'));
  console.log(JSON.stringify({ id, before, clicked: next, shownRightAfterTap: shown, savingIndicator: indicator, toast, afterFailure: after }, null, 1));
  await b.close();
})();
