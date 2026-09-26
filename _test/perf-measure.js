/**
 * 場面 A〜D の所要時間を実ブラウザで自動計測する（PERF.md 1.5 の手順で使う）。
 *
 * ログイン済みの Chromium に DevTools プロトコル（CDP）でつなぎ、docs/perf.js の記録を集める。
 * 本番の GAS とスプレッドシートを相手にする。登録・編集・ステータス更新は、この
 * スクリプトが作る計測用の備品にだけ行い、各回の最後に論理削除する。
 *
 *   node _test/perf-measure.js --out perf-result.json [--rounds 5] [--cdp http://127.0.0.1:9222]
 *
 * 環境変数 PERF_BYPASS_TOKEN があれば、Google ログインの代わりに計測用の認証省略トークンを使う
 * （GAS 側に計測用のファイルを置いている間だけ有効。PERF.md 1.5）。この場合 A に Google ログインの時間は含まれない。
 */
const fs = require('fs');

const args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf('--' + name);
  return i === -1 ? def : args[i + 1];
}
const CDP_URL = opt('cdp', 'http://127.0.0.1:9222');
const APP_URL = opt('app', 'http://localhost:8000/?perf=1');
const ROUNDS = Number(opt('rounds', 5));
const OUT = opt('out', null);
/**
 * 判定する場面（頭文字をカンマ区切り。例: "C"、"A,B"）。省略時は全場面。
 * 施策の評価は、その施策が対象とする場面だけで判定する（PERF.md 1.3 の採用基準）。
 */
const SCENES = (opt('scenes', 'A,B,C,D') || '').split(',').map(x => x.trim()).filter(Boolean);
/**
 * --only D: 場面 D（写真）だけを計る。キャッシュなしで再読み込みして一覧の写真を計り、
 * 続けて写真つきの備品の詳細を開いて詳細の写真を計る、を --rounds 回繰り返す（登録などの書き込みはしない）。
 * 判定も D だけで行う（--scenes D と同じ）。
 */
const ONLY = opt('only', null);
if (ONLY === 'D') SCENES.splice(0, SCENES.length, 'D');

/** Chrome DevTools の Throttling プリセット「Fast 4G」と同じ値 */
const FAST_4G = {
  offline: false,
  latency: 60 * 2.75,
  downloadThroughput: 9 * 1000 * 1000 / 8 * 0.9,
  uploadThroughput: 1.5 * 1000 * 1000 / 8 * 0.9
};

/** 自動ログインが働かなかったときに待つ時間（FedCM の自動再認証には間隔の制限がある） */
const RELOGIN_WAIT_MS = 10.5 * 60 * 1000;
const RELOGIN_TRIES = 3;

const A = 'A 起動→一覧';

let page, cdp;
let cacheDisabled = false;
const results = [];   // { phase, cache, ...perf の記録 }
let seen = 0;         // perf:log のうち取り込み済みの件数

function log(msg) { console.log(new Date().toISOString().slice(11, 19) + ' ' + msg); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function readPerfLog() {
  return page.evaluate(() => JSON.parse(localStorage.getItem('perf:log') || '[]'));
}

/**
 * perf:log の新しい記録を取り込む。
 * refScenes に挙げた場面は参考扱い（phase に「（参考）」を付け、集計と検証から外す）にする。
 */
async function collect(phase, refScenes) {
  const all = await readPerfLog();
  const fresh = all.slice(seen);
  seen = all.length;
  fresh.forEach(r => {
    const p = (refScenes || []).indexOf(r.scene) !== -1 ? phase + '（参考）' : phase;
    results.push(Object.assign({ phase: p, cache: cacheDisabled ? 'なし' : 'あり' }, r));
  });
  return fresh;
}

/** mustRecord: 記録が現れなければ例外にする */
async function mustRecord(scene, timeoutMs) {
  if (!await waitRecord(scene, timeoutMs)) throw new Error('「' + scene + '」が ' + (timeoutMs / 1000) + ' 秒以内に記録されなかった');
}

/** 場面 scene の記録が seen 以降に現れるまで待つ */
async function waitRecord(scene, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const all = await readPerfLog().catch(() => []);
    if (all.slice(seen).some(r => r.scene === scene)) return true;
    await sleep(200);
  }
  return false;
}

async function waitIdle() {
  await page.waitForFunction(() => document.getElementById('loading').classList.contains('hidden'), null, { timeout: 60000 });
}

async function setCache(disabled) {
  cacheDisabled = disabled;
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: disabled });
}

/** 再読み込みして一覧が出るまでを 1 回計る。自動ログインが働かなければ待って再試行する */
async function runA(phase, disabled) {
  await setCache(disabled);
  for (let t = 0; t < RELOGIN_TRIES; t++) {
    await page.reload();
    if (await waitRecord(A, 60000)) {
      // D 一覧はキャッシュの有無にかかわらず待ってから取り込む（後の場面の条件で集計されないように）
      if (await page.locator('#item-list img').count()) await mustRecord('D 一覧写真', 30000);
      await waitIdle();
      await collect(phase);
      return true;
    }
    await collect(phase + '（失敗）');
    log('自動ログインが働かなかった。' + (RELOGIN_WAIT_MS / 60000) + ' 分待って再試行する');
    await sleep(RELOGIN_WAIT_MS);
  }
  throw new Error('自動ログインが ' + RELOGIN_TRIES + ' 回続けて働かなかった');
}

/** 一覧タブで一覧へ戻る（戻るボタンだとスキャン画面を経由した場合にスキャン画面へ戻るため） */
async function backToList() {
  await page.click('[data-nav="list"]');
  await page.waitForSelector('#view-list:not(.hidden)');
  await waitIdle();
}

/** 場面 B（一覧→詳細、ID 入力→詳細）と D 詳細。キャッシュなし */
async function roundB(phase) {
  await setCache(true);
  const withPhoto = page.locator('#item-list [data-item-id]:has(img)').first();
  const card = (await withPhoto.count()) ? withPhoto : page.locator('#item-list [data-item-id]').first();
  const itemId = await card.getAttribute('data-item-id');

  await card.click();
  await mustRecord('B 一覧→詳細', 60000);
  if (await page.locator('#view-detail img').count()) await mustRecord('D 詳細写真', 30000);
  await collect(phase);
  await backToList();

  await page.click('[data-nav="scan"]');
  await page.fill('#manual-id', itemId);
  await page.click('#btn-manual-go');
  await mustRecord('B ID入力→詳細', 60000);
  // 参考扱いの D 詳細が遅れて届くと次の場面の条件で集計されるので、ここで待ってから取り込む
  if (await page.locator('#view-detail img').count()) await waitRecord('D 詳細写真', 30000);
  // 直前に同じ写真を表示しているため、この回の D 詳細はメモリ上の画像で即完了する。基準値には使わない
  await collect(phase, ['D 詳細写真']);
  await backToList();
}

/** 後片付けできなかった計測用備品の ID（最後に手順とともに表示する） */
const leftovers = [];

/** 詳細画面で表示中の備品を論理削除して一覧へ戻る */
async function deleteShownItem() {
  await page.click('#btn-delete'); // confirm は dialog ハンドラで承諾する
  await page.waitForSelector('#view-list:not(.hidden)');
  await waitIdle();
}

/** ID を指定して開き直し、論理削除する（途中で失敗したときの後片付け） */
async function deleteById(itemId) {
  await waitIdle().catch(() => {});
  await page.click('[data-nav="scan"]');
  await page.fill('#manual-id', itemId);
  await page.click('#btn-manual-go');
  await page.waitForSelector('#view-detail:not(.hidden) #btn-delete', { timeout: 60000 });
  await waitIdle();
  await deleteShownItem();
}

/**
 * 名前で一覧を検索し、該当する備品の ID を返す（登録の直後に失敗して ID を画面から取れなかったときの後片付け用）。
 * 名前は毎回一意にしているので、見つかるのは 0 件か 1 件。
 */
async function findIdsByName(name) {
  await waitIdle().catch(() => {});
  await page.click('[data-nav="list"]');
  await waitIdle();
  await page.fill('#search-input', name);
  await sleep(800); // 入力から検索までの待ち（app.js は 350ms）
  await waitIdle();
  const ids = await page.$$eval('#item-list [data-item-id]', (cards, n) =>
    cards.filter(c => (c.querySelector('p.font-semibold') || {}).textContent === n).map(c => c.getAttribute('data-item-id')), name);
  await page.fill('#search-input', '');
  await sleep(800);
  await waitIdle();
  return ids;
}

/** 場面 C（登録・ステータス更新・編集）。計測用の備品を作り、最後に論理削除する */
async function roundC(phase, k) {
  await setCache(false);
  const name = '計測用（自動削除） ' + new Date().toISOString().slice(0, 16) + ' #' + k + '-' + Math.random().toString(36).slice(2, 7);
  let itemId = null;
  let deleted = false;
  try {
    await page.click('[data-nav="new"]');
    await page.fill('#f-name', name);
    await page.click('#item-form button[type=submit]');
    await mustRecord('C 登録', 60000);
    // 画面は保存を待たずに出る（項目 6）。採番された ID が出るのは保存の確定後
    await mustRecord('C 登録確定', 60000);
    await collect(phase);
    itemId = (await page.textContent('#view-detail dd')).trim(); // 先頭の行が備品ID

    const current = (await page.textContent('#view-detail .badge')).trim();
    const next = page.locator('#view-detail [data-set-status]:not([data-set-status="' + current + '"])').first();
    await next.click();
    await mustRecord('C ステータス更新', 60000);
    await mustRecord('C ステータス確定', 60000); // 次の操作の前に保存を終わらせる
    await collect(phase);

    await page.click('#btn-edit');
    await page.fill('#f-note', '計測用の編集 #' + k);
    await page.click('#item-form button[type=submit]');
    await mustRecord('C 編集', 60000);
    await mustRecord('C 編集確定', 60000);
    await collect(phase);

    await deleteShownItem();
    deleted = true;
  } finally {
    if (!deleted) {
      try {
        // 登録の直後に失敗した場合は ID が取れていないので、一意な名前で探す
        const ids = itemId ? [itemId] : await findIdsByName(name);
        for (const id of ids) {
          await deleteById(id);
          log('途中で失敗したため計測用備品 ' + id + ' を削除した');
        }
      } catch (e) {
        leftovers.push(itemId || '（ID 不明）名前「' + name + '」');
      }
    }
    await collect(phase + '（後片付け）').catch(() => {});
  }
}

/** 基準値として認める最小の回数（PLAN.md 項目 1 の完了条件） */
const MIN_ROUNDS = 3;

/**
 * 必須の場面・キャッシュ条件ごとに、基準値として使える記録がそろっているかを確かめる（PERF.md 1.3 の採用基準）。
 * - A・B・C: rounds 回すべて有効であること
 * - D: rounds 回試行し、写真の読み込み失敗を除いた有効な回が MIN_ROUNDS 回以上あること
 *   （写真の失敗は Google 側の事象で計測の不備ではないため。除いた回は warnings に残す）
 * @return {{problems: string[], warnings: string[]}} problems が空なら基準値として使える
 */
function validate(records, rounds, scenes) {
  scenes = scenes || SCENES;
  const need = [
    ['A 起動→一覧', 'あり'], ['A 起動→一覧', 'なし'],
    ['B 一覧→詳細', 'なし'], ['B ID入力→詳細', 'なし'],
    ['C 登録', 'あり'], ['C ステータス更新', 'あり'], ['C 編集', 'あり'],
    ['D 一覧写真', 'なし'], ['D 詳細写真', 'なし']
  ].filter(([scene]) => scenes.indexOf(scene.charAt(0)) !== -1);
  const problems = [];
  const warnings = [];
  if (rounds < MIN_ROUNDS) problems.push('回数が ' + rounds + ' で、基準値に必要な ' + MIN_ROUNDS + ' 回に満たない');
  need.forEach(([scene, cache]) => {
    const recs = records.filter(r => !/（/.test(r.phase) && r.scene === scene && r.cache === cache);
    const failed = recs.filter(r => /失敗|中断/.test(r.note)).length;
    const valid = recs.length - failed;
    const label = scene + '（キャッシュ' + cache + '）';
    if (!/^D /.test(scene)) {
      if (valid < rounds) problems.push(label + ': 有効 ' + valid + ' / ' + rounds + ' 回');
      return;
    }
    if (!recs.length) {
      problems.push(label + ': 記録なし（写真付きの備品が一覧の画面内にない場合も計れない）');
    } else if (recs.length < rounds) {
      problems.push(label + ': 試行 ' + recs.length + ' / ' + rounds + ' 回');
    } else if (valid < MIN_ROUNDS) {
      problems.push(label + ': 写真の読み込み失敗・中断を除いた有効な回が ' + valid + ' 回で、' + MIN_ROUNDS + ' 回に満たない');
    } else if (failed) {
      warnings.push(label + ': 写真の読み込み失敗・中断 ' + failed + ' 回を除外し、有効 ' + valid + ' 回で基準値とする');
    }
  });
  return { problems, warnings };
}

function median(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : Math.round((s[n / 2 - 1] + s[n / 2]) / 2);
}

/** 場面・キャッシュ条件ごとの中央値の表（写真の読み込みに失敗した回は除く） */
function summary(records) {
  const groups = {};
  records.filter(r => !/（/.test(r.phase) && !/失敗|中断/.test(r.note)).forEach(r => {
    const key = r.scene + '｜キャッシュ' + r.cache;
    (groups[key] = groups[key] || []).push(r.ms);
  });
  const lines = ['| 場面 | キャッシュ | 回数 | 中央値(ms) | 各回(ms) |', '|---|---|---|---|---|'];
  Object.keys(groups).sort().forEach(k => {
    const [scene, cache] = k.split('｜キャッシュ');
    const v = groups[k];
    lines.push('| ' + scene + ' | ' + cache + ' | ' + v.length + ' | ' + median(v) + ' | ' + v.join(', ') + ' |');
  });
  return lines.join('\n');
}

/** 検証結果を表示し、基準値として使えなければ終了コードを 1 にする */
function report(records, rounds) {
  const v = validate(records, rounds);
  console.log('\n' + summary(records) + '\n');
  if (v.warnings.length) console.log('注意:\n- ' + v.warnings.join('\n- ') + '\n');
  if (v.problems.length) {
    process.exitCode = 1;
    console.log('計測が不足している（基準値として使わないこと）:\n- ' + v.problems.join('\n- '));
  } else {
    console.log('基準値として使える（PERF.md 1.3 の採用基準を満たす。判定した場面: ' + SCENES.join(',') + '）。');
  }
  return v;
}

/** --check ＜JSON＞: 保存済みの計測結果を、現在の採用基準で検証し直す（ブラウザは使わない） */
const CHECK = opt('check', null);
if (CHECK) {
  const saved = JSON.parse(fs.readFileSync(CHECK, 'utf8'));
  report(saved.results, saved.env.rounds || ROUNDS);
  return;
}

(async () => {
  const { chromium } = require('playwright'); // --check では不要なので、計測するときだけ読み込む
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  page = ctx.pages().find(p => p.url().startsWith(APP_URL.split('?')[0])) || await ctx.newPage();
  page.on('dialog', d => d.accept());
  cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', FAST_4G);
  // スキャン画面でカメラ許可のダイアログを出さない（ID 入力で代替するため）
  await cdp.send('Browser.setPermission', {
    permission: { name: 'videoCapture' }, setting: 'denied', origin: new URL(APP_URL).origin
  }).catch(() => {});

  await page.goto(APP_URL);
  const bypass = process.env.PERF_BYPASS_TOKEN || '';
  await page.evaluate((tok) => {
    localStorage.setItem('perf:log', '[]');
    if (tok) localStorage.setItem('perf:bypassToken', tok); else localStorage.removeItem('perf:bypassToken');
  }, bypass);
  seen = 0;

  const env = await page.evaluate(() => ({ ua: navigator.userAgent }));
  log('計測開始 ' + env.ua);

  try {
    if (ONLY === 'D') {
      for (let k = 1; k <= ROUNDS; k++) {
        await runA('Aキャッシュなし-' + k, true);   // D 一覧（キャッシュなし）
        await roundB('B-' + k);                     // D 詳細（キャッシュなし）
        log('第 ' + k + ' 回（D 一覧・D 詳細）完了');
      }
      return;
    }
    for (let k = 1; k <= ROUNDS; k++) {
      await runA('A通常-' + k, false);
      await roundB('B-' + k);
      await roundC('C-' + k, k);
      log('第 ' + k + ' 回（A 通常・B・C）完了');
    }
    for (let k = 1; k <= ROUNDS; k++) {
      await runA('Aキャッシュなし-' + k, true);
      log('第 ' + k + ' 回（A キャッシュなし・D 一覧）完了');
    }
  } finally {
    const items = await page.locator('#item-list [data-item-id]').count().catch(() => null);
    const photos = await page.locator('#item-list [data-item-id]:has(img)').count().catch(() => null);
    const v = validate(results, ROUNDS);
    const out = {
      env: Object.assign(env, { items, photos, rounds: ROUNDS, login: bypass ? '認証省略' : 'Google', at: new Date().toISOString() }),
      results, problems: v.problems, warnings: v.warnings, leftovers
    };
    // 計測用トークンをブラウザに残さない
    await page.evaluate(() => localStorage.removeItem('perf:bypassToken')).catch(() => {});
    if (OUT) fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
    console.log('一覧の件数: ' + items + '（写真付き ' + photos + '）');
    report(results, ROUNDS);
    if (leftovers.length) {
      process.exitCode = 1;
      console.log('\n削除できなかった計測用備品: ' + leftovers.join(', ') +
        '\nアプリのスキャン画面で ID を入力して開き「削除」するか、items シートの該当行の is_deleted を TRUE にすること。' +
        '\nID 不明のものは一覧の検索欄に表示された名前を入れて探す（名前は「計測用（自動削除）」で始まる）。');
    }
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {});
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: false }).catch(() => {});
    await browser.close().catch(() => {}); // CDP 接続を切るだけ（ブラウザは閉じない）
  }
})().catch(e => { console.error(e); process.exit(1); });
