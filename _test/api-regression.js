/** 実際のフロント関数を隔離し、不正QRと応答/本文の保留を確認する。 */
const fs = require('fs');
const vm = require('vm');
const assert = require('assert/strict');
const source = fs.readFileSync(require('path').join(__dirname, '../docs/app.js'), 'utf8');
const apiSource = source.slice(source.indexOf('  function api('), source.indexOf('  /* ---------- 更新操作'));
const sendSource = source.slice(source.indexOf('  function outcomeUnknown('), source.indexOf('  /**\n   * 新しいセッション'));
const qrSource = source.slice(source.indexOf('  function extractItemId('), source.indexOf('  /* ================================================================\n   * アカウント'));
let failed = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const bounded = p => Promise.race([p, sleep(150).then(() => { throw new Error('通信期限で決着しない'); })]);
function context(fetchImpl) {
  const timers = new Set();
  const ctx = vm.createContext({
    CFG: { GAS_API_URL: 'https://example.invalid/', API_READ_TIMEOUT_MS: 10, API_WRITE_TIMEOUT_MS: 10 },
    state: { session: 0, idToken: 'test' }, PERF: { enabled: false, api() {} }, performance,
    AbortController, fetch: fetchImpl, OP_RETRY_DELAYS_MS: [1, 1],
    handleAuthExpired() {},
    setTimeout(fn, ms) { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; },
    clearTimeout(id) { timers.delete(id); clearTimeout(id); }
  });
  vm.runInContext(apiSource + sendSource + qrSource, ctx);
  return { ctx, timers };
}
const pending = signal => new Promise((resolve, reject) => {
  signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
});
async function check(label, fn) {
  try { await fn(); console.log('ok ' + label); }
  catch (e) { failed++; console.log('FAIL ' + label + ': ' + e.message); }
}
(async () => {
  await check('正常なQRと不正エンコードのquery/末尾', () => {
    const { ctx } = context();
    assert.equal(ctx.extractItemId('https://example.invalid/?item=ITEM-0001'), 'ITEM-0001');
    assert.equal(ctx.extractItemId('item-10000'), 'ITEM-10000');
    assert.equal(ctx.extractItemId('https://example.invalid/?item=%'), '');
    assert.equal(ctx.extractItemId('https://example.invalid/%'), '');
  });
  for (const phase of ['response', 'body']) {
    await check('保留された' + phase + 'は期限でNETWORK_ERRORになる', async () => {
      const { ctx, timers } = context((url, options) => phase === 'response' ? pending(options.signal) : Promise.resolve({ text: () => pending(options.signal) }));
      await assert.rejects(bounded(ctx.api('getItems')), e => e.code === 'NETWORK_ERROR' && /時間/.test(e.message));
      assert.equal(timers.size, 0, '通信タイマーが残った');
    });
  }
  await check('本文の読取失敗も未確定として扱う', async () => {
    const { ctx, timers } = context(() => Promise.resolve({ text: () => Promise.reject(new Error('connection reset')) }));
    await assert.rejects(ctx.api('updateItem'), e => e.code === 'NETWORK_ERROR');
    assert.equal(timers.size, 0);
  });
  await check('期限切れの自動再送と手動確認は同ID/同じ版/同じ下書き', async () => {
    const calls = []; let hold = true;
    const { ctx, timers } = context((url, options) => {
      calls.push(JSON.parse(options.body));
      return hold ? pending(options.signal) : Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ ok: true, data: { replayed: true } })) });
    });
    const payload = { item_id: 'ITEM-0001', base_version: 'original', photos: [{ id: 'new', photo: { base64: 'draft' } }] }, op = { id: 'same-id', attempt: 0 };
    await assert.rejects(bounded(ctx.sendOp('updateItem', payload, op)), e => e.code === 'NETWORK_ERROR' && e.unknown === true);
    hold = false;
    assert.equal((await ctx.sendOp('updateItem', payload, op)).replayed, true);
    assert.deepEqual(calls.map(c => c.payload.op_attempt), [1, 2, 3, 4]);
    for (const c of calls) assert.deepEqual(c.payload, { ...payload, op_id: 'same-id', op_attempt: c.payload.op_attempt });
    assert.equal(timers.size, 0);
  });
  await check('成功/APIエラー/古いセッションでタイマーを片付ける', async () => {
    let ok = true;
    const { ctx, timers } = context(() => Promise.resolve({ text: () => Promise.resolve(JSON.stringify(ok ? { ok: true, data: 1 } : { ok: false, error: { code: 'CONFLICT' } })) }));
    assert.equal(await ctx.api('getItems'), 1); assert.equal(timers.size, 0);
    ok = false; await assert.rejects(ctx.api('updateItem'), e => e.code === 'CONFLICT'); assert.equal(timers.size, 0);
    const stale = ctx.api('getItem'); ctx.state.session++;
    assert.equal(await Promise.race([stale.then(() => 'resolved', () => 'rejected'), sleep(25).then(() => 'ignored')]), 'ignored');
    assert.equal(timers.size, 0);
  });
  process.exit(failed ? 1 : 0);
})();
