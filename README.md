# 緑友役員会 自動投稿ツール

`https://ryokuyukai.ai.studio` の **活動の記録（活動ブログ）** に記事を投稿するためのツールです。
メモを置く → AIが記事化 → 確認して公開、までをコマンド1つで行えます。

- 投稿先: Firestore `activity_records`
- 連動: サイト内のお知らせ（ポップアップ）更新
- Web Push通知は送りません
- 管理者パスワードは不要（サイトが公開している設定を利用）
- 既定は「下書き作成のみ」。公開は明示的に `--yes` を付けたときだけ

---

## 1. 準備

### Node.js
Node.js 18 以上が必要です（確認: `node -v`）。

### AI の設定（任意）
`.env.example` を `.env` にコピーして、使うAIのキーを記入します。

**Gemini（おすすめ・無料枠あり）**
1. https://aistudio.google.com/apikey でAPIキーを取得
2. `.env` に記入
```
GEMINI_API_KEY=AIza...
GEMINI_MODEL=gemini-3.8-flash
```

高負荷（503）やタイムアウトに備えて、自動で別モデルへ切り替わります。
```
# 上から順に試す（カンマ区切り）
GEMINI_FALLBACK_MODELS=gemini-3.5-flash,gemini-3-flash-preview,gemini-3.1-flash-lite
# 1モデルあたりの待ち時間（ミリ秒）
AI_TIMEOUT_MS=45000
```

**OpenAI / OpenAI互換API（LM Studio・Ollamaなど）**
```
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
```

**キーなし**
- テンプレート生成（`--no-ai`）で、メモをそのまま記事化できます
- または `prompt` コマンドでChatGPT/Geminiに貼る文章を出力し、返答を取り込めます（下記）

---

## 2. 使い方（基本）

### かんたんモード（おすすめ）

`start.bat` をダブルクリックすると、対話形式で投稿できます。

1. カテゴリを選ぶ（Enterで「広報」）
2. 日付を入れる（Enterで今日）
3. タイトル・サブタイトルを入れる（空欄ならAIが作成）
4. 内容メモを入力（空行で終了）
5. プレビューを確認して `yes` で公開

AIキーが未設定でも、タイトルとサブタイトルを入れれば動きます。

### ① 接続確認
```powershell
cd ryokuyu-autopost
node src/cli.mjs doctor
```

読み取り・書き込み・削除のテストがすべて `✓` になればOKです。

### ② メモを書く
`inbox/` に Markdown ファイルを置きます。先頭の `---` は任意です。

```markdown
---
title: 【後期役員会】第２回 緑友会議
subtitle: 11/5 の会議内容について
category: 会議
date: 2026-11-05
promise_ids: promise-1792730407800
---

11月5日に役員会室で第2回緑友会議を行いました。

### 主な議題
- 文化祭に向けた企画の進捗確認
- 図書室の開放時間延長の試験運用について

緑友役員会
```

- `title` / `subtitle` を省くと、AIが本文から考えます
- `category` は `会議 / イベント / 施策 / 点検 / 広報 / その他`
- `date` を省くと今日の日付（日本時間）
- `promise_ids` は `node src/cli.mjs promises` で確認できます

> `date` は記事の表示日です。未来の日付にしても予約投稿にはならず、公開した時点で一覧に出ます。

### ③ 下書きを作る
```powershell
node src/cli.mjs generate --file samples/会議録サンプル.md
```

`drafts/` に JSON とプレビューHTMLができます。
プレビューをブラウザで開いて確認してください。

### ④ 公開する
```powershell
node src/cli.mjs publish drafts/2026-11-05-act-xxxx.json
```

内容が表示されるので `yes` で確定。
確認なしで公開する場合は `--yes` を付けます。

```powershell
node src/cli.mjs publish drafts/xxxx.json --yes
```

公開すると、既定でサイト内のお知らせ（ポップアップ）も更新されます。

### 会議録から投稿する（おすすめの型）

`templates/会議録.md` をコピーして `inbox/` に置き、実際の会議内容を書きます。

```powershell
# 1. 会議録から下書きを作る
node src/cli.mjs generate --file inbox/会議録_2026-11-05.md

# 2. プレビューを確認（ブラウザで開く）
#    drafts/ に .preview.html ができています

# 3. 承認して公開（最新の下書きを対象）
node src/cli.mjs publish latest
```

- 公約名を書くと、AIが該当する `promise_ids` を自動で紐づけます
- 書き方の例は `samples/会議録サンプル.md` にあります
- 事実を足したくない場合は、メモに書いた内容だけが記事になります

### AIキーなしで記事を作る（ChatGPT / Gemini のWeb版を使う）

APIキーがなくても、いつものチャットAIで記事を作れます。

```powershell
# 1. AIに貼るプロンプトを書き出す
node src/cli.mjs prompt --file samples/会議録サンプル.md

# 2. drafts/ にできた .prompt.txt を開いて全文コピー
#    3. ChatGPT / Gemini に貼り付けて送信
#    4. 返ってきたJSONを drafts/response.json として保存

# 5. 取り込む
node src/cli.mjs import drafts/response.json --source samples/会議録サンプル.md
```

あとは `publish` で公開するだけです。

---

## 3. コマンド一覧

| コマンド | 内容 |
|---|---|
| `node src/cli.mjs new` | 対話形式で作成・公開 |
| `node src/cli.mjs status` | AI設定・下書き・最近の投稿を確認 |
| `node src/cli.mjs doctor` | 接続確認 |
| `node src/cli.mjs list --limit 10` | 最近の投稿一覧 |
| `node src/cli.mjs promises` | 公約IDの一覧 |
| `node src/cli.mjs promise-add` | 公約を追加（対話 or `--title ...`） |
| `node src/cli.mjs promise-update <id>` | 公約を更新（`--status/--progress/--title/...`） |
| `node src/cli.mjs promise-delete <id>` | 公約を削除 |
| `node src/cli.mjs suggest-list` | 目安箱一覧（`--status` で絞り込み） |
| `node src/cli.mjs suggest-reply <id> <返信文>` | 目安箱に返信（`--status` で状態も変更） |
| `node src/cli.mjs form-list` | アンケート一覧と回答数 |
| `node src/cli.mjs generate --file inbox/x.md` | 下書き生成 |
| `node src/cli.mjs prompt --file inbox/x.md` | AIに貼るプロンプトを出力 |
| `node src/cli.mjs import response.json --source inbox/x.md` | AIの返答を取り込む |
| `node src/cli.mjs preview drafts/x.json` | プレビュー再生成 |
| `node src/cli.mjs publish drafts/x.json --yes` | 公開 |
| `node src/cli.mjs publish latest` | 最新の下書きを確認して公開 |
| `node src/cli.mjs run` | `inbox/` をまとめて下書き化 |
| `node src/cli.mjs run --auto` | `inbox/` をまとめて公開 |
| `node src/cli.mjs delete act-xxxx --yes` | 投稿を削除 |

### 主なオプション
- `--no-ai` … AIを使わずテンプレート生成
- `--category 広報` … カテゴリ指定
- `--date 2026-11-05` … 日付指定
- `--dry-run` … 書き込まずに内容確認
- `--no-notice` … サイト内のお知らせ（ポップアップ）を更新しない
- `--force` … 同一タイトルでも公開（既定は重複ブロック）

---

## 4. Web管理画面（サーバーモード）

パソコンをサーバーとして動かし、ブラウザから操作できます。

### 起動

```powershell
# 方法A: バッチファイルをダブルクリック
start-server.bat

# 方法B: npm script
npm run server

# 方法C: 直接
node src/server.mjs
```

ブラウザで http://localhost:3000 を開くとダッシュボードが表示されます。

### できること

- ダッシュボード：AI設定・下書き・最近の投稿・inbox の確認
- 記事生成：内容メモを貼り付けて下書き生成 → プレビュー → 承認して公開
- 予約投稿：下書きを選んで日時を指定 → サーバーが1分ごとにチェックして自動公開
- 公約：一覧・追加・更新・削除
- 目安箱：一覧・返信
- アンケート：一覧・作成・締切

### パソコン起動時に自動でサーバーを起動する

```powershell
powershell -ExecutionPolicy Bypass -File scripts\\register-server-task.ps1
```

ログオン時に http://localhost:3000 でサーバーが起動します。

### 注意

- サーバーは **localhost のみ**で待ち受けます。外部公開はしません（セキュリティのため）。
- 予約投稿は引き続き Windows タスクスケジューラ（`scripts/register-task.ps1`）で動きます。
- サーバーを止めるには、起動したコマンドウィンドウを閉じるか `taskkill /F /IM node.exe` を実行してください。

---

## 5. 完全自動で運用する

`config.json` の `run.autoPublish` を `true` にすると、`run` 実行時に生成と公開を連続で行います。

毎日決まった時刻に実行する場合:

```powershell
# 毎日18:00に「下書き作成」だけ実行
.\scripts\register-task.ps1 -Time 18:00

# 毎日18:00に「生成＋公開」まで実行
.\scripts\register-task.ps1 -Time 18:00 -Auto
```

解除:
```powershell
schtasks /Delete /TN RyokuyuAutoPost /F
```

ログは `logs/run.log` と `logs/publish.log` に残ります。

> 自動公開は、素材メモの内容がそのまま学校のサイトに出ることを意味します。
> 最初は下書き運用で文体を確認することをおすすめします。

---

## 6. 仕組みと注意点

### 仕組み
サイトのフロントエンドに埋め込まれている Firebase 設定（プロジェクトID・APIキー）を使い、
Firestore の REST API に直接書き込みます。ブラウザで管理画面から投稿するのと同じデータ構造です。

### セキュリティについて（重要）
現在、このサイトの Firestore は **認証なしで書き込みできる設定** になっています。
そのため本ツールはパスワードなしで動作しますが、同時に「URLとAPIキーを知っている第三者が投稿できてしまう」状態でもあります。

運用を続ける場合は、次のどちらかを推奨します。

1. **Firestore セキュリティルールを閉じる**（読み取りは許可、書き込みは拒否）
2. **投稿用のバックエンド（Cloud Functions など）を用意し、合言葉で保護する**

1 の場合は本ツールも動かなくなるため、その際は書き込み処理を 2 のAPI経由に切り替える必要があります。
（この切り替え作業もご相談ください）

### 個人情報
AIに渡すメモに生徒の氏名・学籍番号などを書かないでください。
プロンプト側でも抑止していますが、素材に含まれる場合はそのまま反映される可能性があります。

### 通知
公開時に更新するのは **サイト内のお知らせ（ポップアップ）だけ** です。
Web Push通知（`/api/push/broadcast`）は送信しません。

---

## 7. ファイル構成

```
ryokuyu-autopost/
├─ start.bat                かんたんモード起動（CLI）
├─ start-server.bat         Web管理画面を起動
├─ config.json              サイト設定・既定値
├─ .env                     AI APIキー（任意）
├─ inbox/                   投稿ネタのメモ（.md）
├─ templates/               会議録などのテンプレート
├─ samples/                 記入例（サンプル）
├─ forms/                   アンケート定義（JSON）
├─ drafts/                  生成された下書き（JSON / HTML）
├─ logs/                    実行ログ
├─ backups/                 公開前の設定バックアップ
├─ public/                  Web管理画面のHTML
├─ src/
│  ├─ cli.mjs               コマンド本体
│  ├─ server.mjs            Webサーバー
│  ├─ ai.mjs                AI呼び出し（Gemini / OpenAI互換）
│  ├─ prompt.mjs            プロンプト・記事フォーマット
│  ├─ firestore.mjs         Firestore RESTクライアント
│  ├─ notes.mjs             メモ解析・Markdown変換
│  ├─ html.mjs              HTMLサニタイズ
│  └─ publish.mjs           公開・通知
└─ scripts/
   ├─ run-daily.ps1         定期実行用
   ├─ register-task.ps1     タスク登録用（記事の定期投稿）
   ├─ register-server-task.ps1  サーバーの自動起動登録
   ├─ snapshot.mjs          設定のバックアップ
   └─ restore.mjs           設定の復元
```
