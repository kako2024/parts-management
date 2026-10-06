/**
 * config.js
 * ------------------------------------------------------------------
 * 環境ごとの設定。デプロイ後にこの 2 つを書き換える。
 * ここに秘密情報は置かない（GitHub Pages で公開されるファイル）。
 * ------------------------------------------------------------------
 */
window.APP_CONFIG = {
  /** GAS ウェブアプリのデプロイ URL（末尾が /exec） */
  GAS_API_URL: 'https://script.google.com/macros/s/AKfycbxf-iD2c7zNRCdxIXaRRzS42QDMka_sJRafXWbZ-s4rTmHTbLl9-xK3Z0faUlTB9JHHAQ/exec',

  /** Google Cloud で発行した OAuth 2.0 クライアント ID（ウェブアプリケーション） */
  GOOGLE_CLIENT_ID: '13198717551-lgnpnuo8gk66iejqf2homgerlvs4q473.apps.googleusercontent.com',

  /** アプリ表示名 */
  APP_NAME: '備品管理',

  /** 写真アップロード時の長辺リサイズ上限(px)と JPEG 品質 */
  PHOTO_MAX_EDGE: 1280,
  PHOTO_QUALITY: 0.82,

  /** 1備品の写真の上限（GASのMAX_PHOTOSと同じ） */
  MAX_PHOTOS: 4,

  /** 応答待ちの期限。保存はGASの実行上限6分と通信の余裕を確保する */
  API_READ_TIMEOUT_MS: 60000,
  API_WRITE_TIMEOUT_MS: 420000
};
