# テスト

デプロイ前にロジックを確認するためのものです。本番動作には不要なので、不要なら `_test/` ごと削除して構いません。

## `harness.js` — GAS の結合テスト

Apps Script の各サービス（`SpreadsheetApp` / `DriveApp` / `GroupsApp` など）をモックし、
`gas/` のコードを素の Node.js で走らせます。**依存パッケージなし**で動きます。

```bash
node _test/harness.js
```

認証・認可（トークン検証、`aud` 不一致、期限切れ、グループ外の拒否）、
CRUD、採番、論理削除、履歴記録の 27 項目を検証します。

`gas/` を編集したらこれを流してからデプロイすると、GAS エディタでの試行錯誤が減ります。

## `ui.js` — フロントエンドのスモークテスト

Playwright で実ブラウザ（iPhone 相当のビューポート）を起動し、
疑似 GAS API と疑似 Google ログインを相手に画面を操作します。
各画面のスクリーンショットが `_test/shot-*.png` に出力されます。

```bash
npm i playwright && npx playwright install chromium
node _test/ui.js
```

ログイン → 一覧 → 検索 → 詳細 → ステータス更新 → 新規登録 → スキャン画面 → QRラベル生成 まで通します。
