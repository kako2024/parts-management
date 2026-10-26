/**
 * app/scan.js — QR スキャンと該当備品への移動
 * 読み込む順と各ファイルの役割は app/core.js の冒頭にある。
 */
'use strict';

/* ================================================================
 * QR スキャン
 * ==============================================================*/

var SCANNER_LIB_URL = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
var scannerLibPromise = null;

/**
 * html5-qrcode をスキャン画面を開いたときに初めて読み込む（起動時の読み込みを減らすため。PERF.md 3.3 #6）。
 * 成否を真偽値で返す。失敗したら次に開いたときに再試行する。
 */
function loadScannerLib() {
  if (window.Html5Qrcode) return Promise.resolve(true);
  if (!scannerLibPromise) {
    scannerLibPromise = new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = SCANNER_LIB_URL;
      // 読み込めなかった・中身が使えなかったときは、次に開いたときに読み込み直す
      var fail = function () { s.remove(); scannerLibPromise = null; resolve(false); };
      s.onload = function () { if (window.Html5Qrcode) resolve(true); else fail(); };
      s.onerror = fail;
      document.head.appendChild(s);
    });
  }
  return scannerLibPromise;
}

function startScanner() {
  if (state.scanning) return Promise.resolve();
  if (!window.Html5Qrcode) $('#scan-hint').textContent = 'スキャナを読み込んでいます…';
  return loadScannerLib().then(function (ok) {
    // 読み込みの間に画面を離れた・別の呼び出しで起動済みなら何もしない
    if (state.view !== 'scan' || state.scanning) return;
    if (!ok) {
      $('#scan-hint').textContent = 'スキャナの読み込みに失敗しました。下の入力欄から備品IDを直接開いてください。';
      return;
    }
    return startScannerNow();
  });
}

function startScannerNow() {
  if (!state.scanner) state.scanner = new Html5Qrcode('qr-reader', { verbose: false });
  state.scanning = true;
  $('#scan-hint').textContent = 'カメラを起動しています…';

  return state.scanner.start(
    { facingMode: 'environment' },
    {
      fps: 10,
      qrbox: function (vw, vh) {
        var edge = Math.floor(Math.min(vw, vh) * 0.72);
        return { width: edge, height: edge };
      },
      aspectRatio: 1.0
    },
    onScanSuccess,
    function () { /* フレームごとの読み取り失敗は無視 */ }
  ).then(function () {
    $('#scan-hint').textContent = '備品ラベルの QR コードを枠内に写してください。';
  }).catch(function (err) {
    state.scanning = false;
    $('#scan-hint').textContent =
      'カメラを起動できませんでした（' + (err && err.message ? err.message : err) + '）。' +
      'ブラウザのカメラ権限を許可するか、下の入力欄から備品IDを直接開いてください。';
  });
}

function stopScanner() {
  if (state.scanner && state.scanning) {
    state.scanning = false;
    try {
      state.scanner.stop().then(function () {
        try { state.scanner.clear(); } catch (e) {}
      }).catch(function () {});
    } catch (e) {}
  }
}

var lastScanAt = 0;
function onScanSuccess(decodedText) {
  var now = Date.now();
  if (now - lastScanAt < 1500) return; // 連続読み取りの抑制
  lastScanAt = now;

  var itemId = extractItemId(decodedText);
  if (!itemId) {
    toast('備品IDを読み取れませんでした', 'error');
    return;
  }
  if (navigator.vibrate) navigator.vibrate(40);
  stopScanner();
  PERF.begin('B QR→詳細');
  openDetail(itemId);
}

/**
 * QR の内容から備品IDを取り出す。
 * 素の "ITEM-0001" でも、"https://.../?item=ITEM-0001" 形式でも通す。
 */
function extractItemId(text) {
  var s = String(text || '').trim();
  if (!s) return '';
  var m = /[?&]item=([^&#\s]+)/i.exec(s);
  if (m) {
    try { return decodeURIComponent(m[1]).trim(); } catch (e) { return ''; }
  }
  m = /\bITEM-\d+\b/i.exec(s);
  if (m) return m[0].toUpperCase();
  if (/^https?:\/\//i.test(s)) {
    var seg = s.split(/[?#]/)[0].split('/').filter(Boolean).pop();
    try { return seg ? decodeURIComponent(seg) : ''; } catch (e) { return ''; }
  }
  return s;
}
