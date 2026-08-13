/**
 * Setup.gs
 * ------------------------------------------------------------------
 * 初回セットアップ用。エディタから手動で 1 度ずつ実行する。
 * ------------------------------------------------------------------
 */

/**
 * ステップ 1: スクリプトプロパティを登録する。
 * 下の 4 つの値を自分の環境のものに書き換えてから実行すること。
 * 実行後、この関数内の値はコードから消してもよい（プロパティ側に保存される）。
 */
function initProperties() {
  var props = {
    // 備品管理用スプレッドシートの ID（URL の /d/ と /edit の間）
    SPREADSHEET_ID: 'ここにスプレッドシートIDを貼る',

    // Google Cloud で発行した OAuth 2.0 クライアント ID（ウェブアプリケーション）
    GOOGLE_CLIENT_ID: 'xxxxxxxxxxxx.apps.googleusercontent.com',

    // 利用を許可する Google グループのアドレス
    ALLOWED_GROUP_EMAIL: 'parts-members@example.com',

    // 備品写真を保存する Google Drive フォルダの ID
    PHOTO_FOLDER_ID: 'ここにDriveフォルダIDを貼る'

    // 任意: グループに入れられない人を個別に許可する場合
    // EXTRA_ALLOWED_EMAILS: 'a@example.com,b@example.com'
  };

  Object.keys(props).forEach(function (k) {
    if (/ここに|xxxxxxxxxxxx|example\.com/.test(props[k])) {
      throw new Error('プレースホルダのままの項目があります: ' + k);
    }
  });

  PropertiesService.getScriptProperties().setProperties(props, false);
  console.log('スクリプトプロパティを登録しました: ' + Object.keys(props).join(', '));
}

/**
 * ステップ 2: スプレッドシートに items / logs シートとヘッダーを作る。
 * 既にシートがある場合はヘッダーの過不足だけ確認する（データは消さない）。
 */
function initSpreadsheet() {
  var book = SpreadsheetApp.openById(cfgSpreadsheetId_());

  ensureSheet_(book, CONST.SHEET_ITEMS, CONST.ITEM_HEADERS);
  ensureSheet_(book, CONST.SHEET_LOGS, CONST.LOG_HEADERS);

  // items シートに入力規則（在庫ステータス）を付ける
  var items = book.getSheetByName(CONST.SHEET_ITEMS);
  var idx = headerIndex_(items.getRange(1, 1, 1, items.getLastColumn()).getValues()[0]);
  var statusCol = idx.stock_status + 1;
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(CONST.STOCK_STATUSES, true)
    .setAllowInvalid(false)
    .build();
  items.getRange(2, statusCol, Math.max(items.getMaxRows() - 1, 1), 1).setDataValidation(rule);

  console.log('シートを初期化しました。');
}

function ensureSheet_(book, name, headers) {
  var sh = book.getSheetByName(name);
  if (!sh) {
    sh = book.insertSheet(name);
  }
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var current = sh.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(function (v) { return toStr_(v).trim(); })
    .filter(function (v) { return !!v; });

  if (current.length === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.getRange(1, 1, 1, headers.length)
      .setFontWeight('bold')
      .setBackground('#e8eaed');
    sh.setFrozenRows(1);
    console.log(name + ': ヘッダーを作成しました。');
    return;
  }

  var missing = headers.filter(function (h) { return current.indexOf(h) === -1; });
  if (missing.length) {
    sh.getRange(1, current.length + 1, 1, missing.length).setValues([missing]);
    console.log(name + ': 不足していた列を追加しました -> ' + missing.join(', '));
  } else {
    console.log(name + ': ヘッダーは正常です。');
  }
}

/**
 * ステップ 3: 設定が正しいか自己診断する。
 * デプロイ前にこれを実行して、全項目 OK になることを確認する。
 */
function diagnose() {
  var results = [];
  var check = function (label, fn) {
    try {
      var msg = fn();
      results.push('[OK]   ' + label + (msg ? ' : ' + msg : ''));
    } catch (e) {
      results.push('[NG]   ' + label + ' : ' + e.message);
    }
  };

  check('SPREADSHEET_ID', function () {
    return SpreadsheetApp.openById(cfgSpreadsheetId_()).getName();
  });
  check('items シート', function () {
    var d = readItems_();
    return d.rows.length + ' 件';
  });
  check('logs シート', function () {
    return readLogs_(null, 1).length + ' 件（直近1件取得）';
  });
  // Drive 関連は「Drive 自体が使えない」のか「ID が違う」のかで対処が変わるため、
  // ルートフォルダへの到達確認を先に置いて切り分ける。
  check('Drive へのアクセス', function () {
    return DriveApp.getRootFolder().getName();
  });
  check('PHOTO_FOLDER_ID', function () {
    var id = cfgPhotoFolderId_();
    assertLooksLikeDriveId_(id);
    return DriveApp.getFolderById(id).getName();
  });
  check('ALLOWED_GROUP_EMAIL', function () {
    var g = GroupsApp.getGroupByEmail(cfgGroupEmail_());
    return g.getEmail();
  });
  check('自分自身のグループ所属', function () {
    var me = Session.getEffectiveUser().getEmail();
    if (!me) {
      throw new Error('実行アカウントのメールアドレスを取得できませんでした。appsscript.json に userinfo.email スコープがあるか確認してください');
    }
    return me + ' -> ' + (isGroupMember_(me) ? 'メンバー' : '非メンバー(!)');
  });
  check('GOOGLE_CLIENT_ID の形式', function () {
    var id = cfgClientId_();
    if (!/\.apps\.googleusercontent\.com$/.test(id)) throw new Error('形式が不正です: ' + id);
    return id;
  });

  console.log(results.join('\n'));
  return results.join('\n');
}

/**
 * Drive フォルダ ID の貼り間違いを、Drive を叩く前に弾く。
 * DriveApp 側のエラーは原因が読み取れないことが多いため、
 * 前後の空白・URL 丸ごとの貼り付けはここで具体的に指摘する。
 */
function assertLooksLikeDriveId_(id) {
  if (id !== id.trim()) {
    throw new Error('前後に空白が入っています: ' + JSON.stringify(id));
  }
  if (/^https?:\/\//.test(id) || id.indexOf('/') !== -1) {
    throw new Error('URL が丸ごと入っています。/folders/ より後ろだけを貼ってください: ' + id);
  }
  if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) {
    throw new Error('ID の形式が不正です: ' + JSON.stringify(id));
  }
}

/**
 * 動作確認用のサンプルデータを 3 件投入する。
 * 本番運用前に items シートから手動で消してよい。
 */
function seedSampleItems() {
  var me = Session.getEffectiveUser().getEmail();
  var samples = [
    { name: 'コピー用紙 A4', category: '事務用品', location: '本館-3F-A棚-2段', stock_status: '余裕あり', quantity: 12 },
    { name: 'HDMIケーブル 2m', category: 'IT機器', location: '本館-3F-B棚-1段', stock_status: '残りわずか', quantity: 2 },
    { name: '乾電池 単3', category: '消耗品', location: '本館-1F-倉庫', stock_status: '在庫なし', quantity: 0 }
  ];
  samples.forEach(function (s) {
    var created = insertItem_(s, me);
    appendLog_(created.item_id, me, CONST.ACTION_CREATE, '', s);
  });
  console.log('サンプルを投入しました。');
}
