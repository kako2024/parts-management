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
  PHOTO_QUALITY: 0.82
};
