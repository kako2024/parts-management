/**
 * perf.js — 所要時間の計測（PERF.md の手順で使う）
 * ------------------------------------------------------------------
 * URL に ?perf=1 を付けて開くと有効になり、以後はこの端末で ?perf=0 を
 * 付けて開くまで有効のまま。無効時は何もしない（app.js からの呼び出しは素通り）。
 *
 * 計測結果は localStorage の 'perf:log' に溜まり、画面左下の ⏱ ボタンから
 * 一覧・中央値の確認と Markdown でのコピーができる。
 * ------------------------------------------------------------------
 */
(function () {
  'use strict';

  var FLAG_KEY = 'perf';
  var LOG_KEY = 'perf:log';

  function storageGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function storageSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function storageDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  var param = new URLSearchParams(location.search).get('perf');
  if (param === '1') storageSet(FLAG_KEY, '1');
  if (param === '0') storageDel(FLAG_KEY);
  var enabled = storageGet(FLAG_KEY) === '1';

  var noop = function () {};
  if (!enabled) {
    window.PERF = { enabled: false, begin: noop, mark: noop, end: noop, api: noop, watchImages: noop, bypassToken: noop };
    return;
  }

  function now() { return Math.round(performance.now()); }

  /** 進行中の計測。key → { scene, t0, marks[] } */
  var open = {};

  function readLog() {
    try { return JSON.parse(storageGet(LOG_KEY) || '[]'); } catch (e) { return []; }
  }

  function writeLog(list) { storageSet(LOG_KEY, JSON.stringify(list)); }

  /**
   * 計測を始める。t0 を省略すると現在時刻。
   * 同じ key の計測が進行中なら上書きする（途中で別操作に移った場合）。
   */
  function begin(key, t0) {
    open[key] = { t0: (t0 === undefined ? now() : t0), marks: [] };
  }

  /** 進行中の計測に途中経過を刻む（内訳の把握用） */
  function mark(key, label) {
    var m = open[key];
    if (m) m.marks.push(label + '=' + (now() - m.t0));
  }

  /**
   * ページ読み込みの節目（ナビゲーション開始からの ms）。
   * ナビゲーション開始から計る計測（t0 = 0）の内訳に添える。
   */
  function navMarks() {
    var nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
    if (!nav) return [];
    return ['dcl=' + Math.round(nav.domContentLoadedEventEnd), 'load=' + Math.round(nav.loadEventEnd)];
  }

  /** 計測を終えて記録する。進行中でなければ何もしない */
  function end(key, note) {
    var m = open[key];
    if (!m) return;
    delete open[key];
    var marks = (m.t0 === 0 ? navMarks() : []).concat(m.marks);
    push({ scene: key, ms: now() - m.t0, marks: marks.join(' '), note: note || '' });
  }

  /**
   * API 1 回分を記録する。ms はブラウザから見た往復時間、
   * timing は GAS が返した処理時間の内訳（{ total, laps }。無ければ省略）。
   */
  function api(action, ms, timing) {
    push({
      scene: 'API ' + action,
      ms: ms,
      marks: timing ? 'gas=' + timing.total + ' ' + timing.laps : '',
      note: ''
    });
  }

  function push(rec) {
    rec.at = new Date().toISOString();
    var list = readLog();
    list.push(rec);
    writeLog(list);
    console.log('[perf]', rec.scene, rec.ms + 'ms', rec.marks, rec.note);
    refreshBadge(rec);
  }

  /**
   * root 内で「いま画面内にある img」がすべて読み込み終わるまでを key として計測する。
   * 画面内に画像がなければ記録しない。
   */
  function watchImages(key, root) {
    var t0 = now();
    var vh = window.innerHeight;
    var imgs = Array.prototype.slice.call(root.querySelectorAll('img')).filter(function (img) {
      // 読み込み前の img は幅 0 のことがあるので、大きさではなく「描画対象で画面内の位置にあるか」で判定する
      if (!img.getClientRects().length) return false;
      var r = img.getBoundingClientRect();
      return r.bottom >= 0 && r.top < vh;
    });
    if (!imgs.length) return;

    begin(key, t0);
    var left = imgs.length;
    var failed = 0;
    var interrupted = 0;
    imgs.forEach(function (img) {
      var done = function (ok) {
        if (!ok) failed++;
        if (--left === 0) {
          // 読み直しで表示できた枚数（app.js の onImageError。1 回目は失敗していた）
          var retried = imgs.filter(function (i) { return i.dataset.retry === '1' && i.naturalWidth > 0; }).length;
          end(key, imgs.length + '枚' + (interrupted ? '（中断 ' + interrupted + '）' : failed ? '（失敗 ' + failed + '）' : '') +
            (retried ? '（読み直し ' + retried + '）' : ''));
        }
      };
      // 読み込み済み（成功・失敗とも）ならイベントは二度と来ないので、その場で数える
      if (img.complete && (img.naturalWidth > 0 || img.dataset.retry !== '1')) return done(img.naturalWidth > 0);
      var settled = false;
      var finish = function (ok) {
        if (settled) return;
        settled = true;
        img.removeEventListener('load', onLoad);
        img.removeEventListener('error', onError);
        done(ok);
      };
      var onLoad = function () { finish(true); };
      // app.js が 1 回だけ読み直す（dataset.retry = '1'）。その結果まで待つ
      var onError = function () { if (img.dataset.retry !== '1') finish(false); };
      img.addEventListener('load', onLoad);
      img.addEventListener('error', onError);
      // 読み込み中に一覧が描き直されて img が外れたら、この回は「中断」として記録する（D の有効回数に数えない）
      var watch = setInterval(function () {
        if (settled) return clearInterval(watch);
        if (!img.isConnected) { clearInterval(watch); interrupted++; finish(false); }
      }, 200);
    });
  }

  /* ---------------- 表示（画面左下の ⏱ ） ---------------- */

  var badge, panel;

  function median(arr) {
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var n = s.length;
    if (!n) return 0;
    return n % 2 ? s[(n - 1) / 2] : Math.round((s[n / 2 - 1] + s[n / 2]) / 2);
  }

  function summaryMarkdown() {
    var list = readLog();
    var byScene = {};
    list.forEach(function (r) { (byScene[r.scene] = byScene[r.scene] || []).push(r.ms); });
    var lines = ['| 場面 | 回数 | 中央値(ms) | 各回(ms) |', '|---|---|---|---|'];
    Object.keys(byScene).sort().forEach(function (k) {
      var v = byScene[k];
      lines.push('| ' + k + ' | ' + v.length + ' | ' + median(v) + ' | ' + v.join(', ') + ' |');
    });
    lines.push('', '<details><summary>生データ</summary>', '', '```');
    list.forEach(function (r) {
      lines.push([r.at, r.scene, r.ms + 'ms', r.marks, r.note].join('\t'));
    });
    lines.push('```', '', '</details>');
    return lines.join('\n');
  }

  function refreshBadge(rec) {
    if (!badge) return;
    badge.textContent = '⏱ ' + (rec ? rec.scene + ' ' + rec.ms + 'ms' : readLog().length + '件');
  }

  function togglePanel() {
    if (panel.style.display === 'block') { panel.style.display = 'none'; return; }
    panel.querySelector('pre').textContent = summaryMarkdown();
    panel.style.display = 'block';
  }

  function buildUi() {
    badge = document.createElement('button');
    badge.type = 'button';
    badge.style.cssText = 'position:fixed;left:8px;bottom:72px;z-index:60;padding:4px 8px;' +
      'border-radius:8px;background:#0f172acc;color:#fff;font:12px/1.4 monospace;';
    badge.addEventListener('click', togglePanel);

    panel = document.createElement('div');
    panel.style.cssText = 'display:none;position:fixed;inset:8px 8px 104px 8px;z-index:61;overflow:auto;' +
      'background:#fff;border:1px solid #cbd5e1;border-radius:12px;padding:8px;font:11px/1.4 monospace;';
    panel.innerHTML =
      '<div style="display:flex;gap:6px;margin-bottom:6px">' +
      '<button type="button" data-perf="copy" style="padding:4px 8px;border:1px solid #94a3b8;border-radius:6px">コピー</button>' +
      '<button type="button" data-perf="clear" style="padding:4px 8px;border:1px solid #94a3b8;border-radius:6px">全消去</button>' +
      '<button type="button" data-perf="close" style="padding:4px 8px;border:1px solid #94a3b8;border-radius:6px">閉じる</button>' +
      '</div><pre style="white-space:pre-wrap;word-break:break-all"></pre>';
    panel.addEventListener('click', function (ev) {
      var act = ev.target.getAttribute && ev.target.getAttribute('data-perf');
      if (act === 'copy') {
        var text = summaryMarkdown();
        (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
          .then(function () { ev.target.textContent = 'コピー済み'; })
          .catch(function () { ev.target.textContent = '失敗（下を手で選択）'; });
      } else if (act === 'clear') {
        if (window.confirm('計測結果をすべて消去しますか？')) {
          writeLog([]);
          panel.querySelector('pre').textContent = summaryMarkdown();
          refreshBadge();
        }
      } else if (act === 'close') {
        panel.style.display = 'none';
      }
    });

    document.body.appendChild(badge);
    document.body.appendChild(panel);
    refreshBadge();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildUi);
  else buildUi();

  /**
   * 計測用の認証省略トークン（PERF.md 1.5）。_test/perf-measure.js が localStorage に置く。
   * GAS 側に計測用のファイルが置かれている間だけ有効で、無ければ GAS が 401 を返す。
   */
  function bypassToken() { return storageGet('perf:bypassToken'); }

  window.PERF = { enabled: true, begin: begin, mark: mark, end: end, api: api, watchImages: watchImages, bypassToken: bypassToken };
})();
