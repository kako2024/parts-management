/** PHOTO.md 項目3: 旧/現compressImageを隔離VMで比較。共有ソースは戻さない。 */
const fs = require('fs');
const vm = require('vm');
const { execFileSync } = require('child_process');
const assert = require('assert/strict');
const oldSource = execFileSync('git', ['show', '1e5c47ecb1b3277463dc9145f5cd6f97e27d7fc5:docs/app.js'], { encoding: 'utf8' });
const newSource = require('./app-source').byFile['photo.js'];
function extract(s) {
  // 旧版は app.js 1 ファイル（2 字下げ）で次の見出しまで、現行は app/photo.js（字下げなし）で末尾まで
  const start = s.search(/^ *function compressImage\(file, maxEdge, quality\) \{/m);
  const next = s.slice(start).search(/^ *\/\* ================================================================/m);
  const end = next === -1 ? s.length : start + next;
  assert(start >= 0 && end > start); return s.slice(start, end);
}
async function run(source, failAt) {
  const events = { uncaught: [], revoked: 0, canvas: null };
  class Image {
    constructor() { this.naturalWidth = 80; this.naturalHeight = 40; }
    set src(v) { if (!v) return; setTimeout(() => { try { this.onload(); } catch (e) { events.uncaught.push(e.message); } }, 0); }
  }
  const canvas = { width: 0, height: 0,
    getContext: () => ({ drawImage: () => { if (failAt === 'draw') throw new Error('模擬メモリ不足'); } }),
    toDataURL: () => { if (failAt === 'encode') throw new Error('模擬JPEG出力失敗'); return 'data:image/jpeg;base64,YQ=='; } };
  events.canvas = canvas;
  const context = vm.createContext({ Image, URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: () => events.revoked++ },
    document: { createElement: () => canvas }, Promise, Error, Math });
  vm.runInContext(extract(source), context);
  const settled = context.compressImage({ name: 'generated.jpg' }, 1280, 0.82).then(() => 'resolved', () => 'rejected');
  const outcome = await Promise.race([settled, new Promise(r => setTimeout(() => r('pending'), 50))]);
  return { outcome, events };
}
(async () => {
  for (const failAt of ['draw', 'encode']) {
    const before = await run(oldSource, failAt), after = await run(newSource, failAt);
    assert.equal(before.outcome, 'pending'); assert.equal(before.events.uncaught.length, 1);
    assert.equal(after.outcome, 'rejected'); assert.equal(after.events.uncaught.length, 0);
    assert.equal(after.events.revoked, 1); assert.equal(after.events.canvas.width, 1);
    assert.equal(after.events.canvas.height, 1);
    console.log('ok  ' + failAt + ': 旧実装=未完了/未捕捉例外、現実装=reject/解放');
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
