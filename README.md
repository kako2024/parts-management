# 備品管理 Web アプリケーション

スマートフォンでの操作を前提にした備品管理アプリです。
QR コードを読み取って在庫ステータスをワンタップで更新することを主な用途としています。

サーバーは用意しません。GitHub Pages（静的配信）、Google Apps Script（API）、Google スプレッドシート（DB）だけで動きます。

---

## できること

- Google アカウントでログイン。**指定した Google グループのメンバーだけ**が利用可能
- 備品一覧（キーワード検索 / カテゴリ・場所・在庫ステータスでの絞り込み）
- QR コードをスキャンして該当備品を即座に表示
- 在庫ステータス（余裕あり / 残りわずか / 在庫なし）をワンタップで更新
- 備品の新規登録・編集・論理削除
- スマホカメラで撮った写真を自動縮小して Google Drive に保存
- 全操作を `logs` シートに記録（誰が・いつ・何を・どう変えたか）
- 貼り付け用 QR ラベルの生成と印刷（`docs/qr.html`）

---

## 構成

```
parts-management/
├── README.md            この文書
├── SETUP.md             セットアップ手順（最初に読む）
├── _test/               ローカル検証用のテストハーネス（配信対象外）
├── docs/                GitHub Pages で公開するディレクトリ（ルート直下に置くこと）
│   ├── index.html       画面の骨格
│   ├── style.css        繰り返し使う部品のスタイル
│   ├── app.js           画面遷移・API 通信・ログイン・スキャン
│   ├── config.js        GAS の URL とクライアント ID（環境ごとに書き換える）
│   └── qr.html          QR ラベル生成ツール
└── gas/                 Google Apps Script に貼り付けるファイル
    ├── appsscript.json  マニフェスト（スコープ・デプロイ設定）
    ├── Config.gs        設定値の取り出し
    ├── Util.gs          共通処理・エラー型・レスポンス整形
    ├── Auth.gs          ID トークン検証とグループ所属判定
    ├── Repository.gs    スプレッドシートの読み書き
    ├── Photo.gs         Drive への写真保存
    ├── Api.gs           doPost ルーター（API 本体）
    └── Setup.gs         初期化・自己診断（手動実行用）
```

技術スタックは Tailwind CSS（CDN）、Google Identity Services、html5-qrcode。
ビルドツールは使っていないので、`docs/` を編集して push すればそのまま反映されます。

---

## データ構造

### `items` シート

| 列 | 型 | 内容 |
|---|---|---|
| `item_id` | 文字列 (PK) | 備品 ID（`ITEM-0001`）。QR の内容と一致 |
| `name` | 文字列 | 備品名 |
| `category` | 文字列 | カテゴリ |
| `location` | 文字列 | 固定保管場所 |
| `stock_status` | 文字列 | `余裕あり` / `残りわずか` / `在庫なし` |
| `quantity` | 数値 | 個数（任意） |
| `photo_url` | 文字列 | `https://lh3.googleusercontent.com/d/FILE_ID` |
| `note` | 文字列 | 備考 |
| `updated_at` | 日時 | `YYYY-MM-DD HH:mm:ss` |
| `updated_by` | 文字列 | 最終更新者のメールアドレス |
| `is_deleted` | 論理値 | 論理削除フラグ |

### `logs` シート

| 列 | 内容 |
|---|---|
| `log_id` | `LOG-YYYYMMDD-001` |
| `timestamp` | 操作日時 |
| `item_id` | 対象備品 ID |
| `user_email` | 操作者 |
| `action_type` | `CREATE` / `UPDATE_STATUS` / `UPDATE` / `DELETE` |
| `before_state` | 変更前（JSON 文字列） |
| `after_state` | 変更後（JSON 文字列） |

---

## API 仕様

すべて `POST` の 1 エンドポイントで、ボディの `action` で処理を分岐します。

### リクエスト

```json
{
  "action": "getItems",
  "idToken": "＜Google ログインで取得した ID トークン(JWT)＞",
  "payload": { "keyword": "ケーブル" }
}
```

`Content-Type` は `text/plain;charset=utf-8` を使います。
`application/json` にするとブラウザが CORS プリフライト（OPTIONS）を送りますが、GAS はこれに応答しないためリクエストが失敗します。

### レスポンス

```json
{ "ok": true,  "data": { "items": [ ... ], "total": 12 } }
{ "ok": false, "error": { "code": "ITEM_NOT_FOUND", "message": "...", "status": 404 } }
```

GAS は常に HTTP 200 を返すため、成否は `ok`、種別は `error.status` で判断します。

### アクション一覧

| action | payload | 返すもの |
|---|---|---|
| `loginCheck` | — | ユーザー情報、カテゴリ・場所の候補、在庫ステータスの選択肢 |
| `getItems` | `keyword?`, `category?`, `location?`, `stock_status?` | `items[]`, `total` |
| `getItem` | `item_id`, `withLogs?` | `item`, `logs[]` |
| `createItem` | `name`, `category?`, `location?`, `stock_status?`, `quantity?`, `note?`, `item_id?`, `photo?` | `item` |
| `updateStatus` | `item_id`, `stock_status`, `quantity?`, `note?` | `item` |
| `updateItem` | `item_id` と更新したい項目 | `item` |
| `deleteItem` | `item_id` | `item`（`is_deleted: true`） |
| `getLogs` | `item_id?`, `limit?` | `logs[]` |

`photo` は `{ "data": "＜base64＞", "mimeType": "image/jpeg", "filename": "..." }` の形式です。

### 主なエラーコード

| code | status | 意味 |
|---|---|---|
| `AUTH_REQUIRED` / `AUTH_INVALID_TOKEN` / `AUTH_TOKEN_EXPIRED` | 401 | 再ログインが必要 |
| `AUTH_AUD_MISMATCH` | 401 | クライアント ID の不一致 |
| `FORBIDDEN_NOT_MEMBER` | 403 | グループのメンバーではない |
| `ITEM_NOT_FOUND` | 404 | 備品が未登録 |
| `ITEM_ID_DUPLICATED` | 409 | 手入力した備品 ID の重複 |
| `VALIDATION_ERROR` | 400 | 入力値が不正 |
| `BUSY` | 503 | 他の更新と競合（再試行で解消） |
| `GROUP_LOOKUP_FAILED` / `CONFIG_MISSING` | 500 | 設定不備 |

---

## セキュリティ設計

- **ID トークンは毎リクエスト検証する。** GAS 側は Google の tokeninfo エンドポイントに問い合わせ、`aud`（自分のクライアント ID か）、`iss`、`exp`、`email_verified` を確認します。フロントから送られてきたメールアドレスは信用しません。
- **認可はサーバー側だけで判断する。** 画面を隠すことはアクセス制御になりません。`doPost` はすべての `action` で `authenticate_()` を通ります。
- **秘匿値はコードに埋めない。** スプレッドシート ID・グループアドレス・Drive フォルダ ID はスクリプトプロパティに置きます。リポジトリが公開されても漏れません。
- **ID トークンをブラウザに永続化しない。** メモリ上にのみ保持し、再訪時は Google Identity Services の自動サインインで取り直します。
- **書き込みは `LockService` で直列化する。** 同時更新による行ズレと ID 採番の衝突を防ぎます。

なお、クライアント ID と GAS の URL は公開されても問題ありません。これらを知っていても、グループのメンバーでなければ API は 403 を返します。

---

## 運用上の目安

スプレッドシートを DB として使うため、規模が大きくなると読み込みが遅くなります。
一覧取得はシート全体を読むので、**備品 1,000 件程度までが快適に使える範囲**です。
それを超える場合は `getItems` にページングを入れるか、`items` をキャッシュ（`CacheService`）する改修を検討してください。

`logs` は追記のみで際限なく増えます。年に一度など、古い行を別シートに退避させる運用にしておくと安心です。

---

## はじめかた

**[SETUP.md](SETUP.md)** を上から順に実行してください。
