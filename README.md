# SES Mail Catcher

SES 協業社からのメールを Gmail から自動検知し、Gemini 2.5 Flash を使用して SES 関連メールを分類、送信元アドレスとドメイン別の件数を Slack に通知するシステム。

## なぜ Google Apps Script (GAS) か

| 項目 | GAS | Cloud Functions + Gmail API |
|---|---|---|
| Gmail アクセス | `GmailApp` でネイティブアクセス | サービスアカウント + Domain-Wide Delegation が必要 |
| 認証設定 | 不要（スクリプト所有者の権限で動作） | OAuth2 / サービスアカウント JSON の管理が必要 |
| デプロイ基盤 | 不要（GAS ランタイム上で動作） | Cloud Functions + Cloud Scheduler の構築が必要 |
| 外部依存 | なし | Python パッケージ（google-auth, requests 等） |
| コスト | 無料（Google Workspace の範囲内） | Cloud Functions / Scheduler / GCS の課金あり |

## アーキテクチャ

```
[時間ベーストリガー (0:00 / 8:00 / 16:00)]
        |
        v
    main() ── Script Properties から設定読み込み
        |
        v
  searchEmails() ── GmailApp.search("after:YYYY/MM/DD")
        |
        v
  classifyWithGemini() ── Gemini 2.5 Flash で SES 関連を判定
        |
        v
  applyLabel() ── マッチしたスレッドにラベル付与
        |
        v
  sendSlackNotification() ── UrlFetchApp で Slack Webhook に POST
```

## セットアップ手順

### 1. GAS プロジェクトの作成

1. [script.google.com](https://script.google.com/) にアクセス
2. 「新しいプロジェクト」をクリック
3. プロジェクト名を「SES Mail Catcher」に変更
4. `src/main.gs` の内容をエディタに貼り付けて保存

### 2. Script Properties の設定

プロジェクト設定 > スクリプト プロパティ から以下を設定する。

| プロパティ名 | 必須 | デフォルト値 | 説明 |
|---|---|---|---|
| `SLACK_WEBHOOK_URL` | Yes | - | Slack Incoming Webhook URL |
| `GEMINI_API_KEY` | Yes | - | Google AI Studio API key ([こちら](https://aistudio.google.com/)から取得) |
| `LABEL_NAME` | No | `SES案件` | マッチしたスレッドに付与するラベル名 |

### 3. トリガーの設定

1. GAS エディタで `setupTriggers` 関数を選択し、「実行」をクリック
2. 権限の承認を行う
3. GAS エディタ左メニューの「トリガー」(時計アイコン) で 3つのトリガー (0:00, 8:00, 16:00) が登録されていることを確認

> トリガーを再設定したい場合は `setupTriggers` を再度実行するだけでよい（既存トリガーは自動削除される）。

### 4. Slack Incoming Webhook の作成

1. [Slack API](https://api.slack.com/apps) にアクセスし、新しい App を作成
2. 「Incoming Webhooks」を有効化
3. 「Add New Webhook to Workspace」で通知先チャンネルを選択
4. 生成された Webhook URL を Script Properties の `SLACK_WEBHOOK_URL` に設定

## ローカル開発 (clasp)

[clasp](https://github.com/google/clasp) を使うことで、ローカル環境から GAS プロジェクトを管理できる。

### 初期設定

```bash
# clasp のインストール
npm install -g @google/clasp

# Google アカウントでログイン
clasp login

# .clasp.json の scriptId を GAS プロジェクトの ID に更新
# (GAS エディタの URL から取得: https://script.google.com/d/{SCRIPT_ID}/edit)
```

### 日常の操作

```bash
# ローカルのコードを GAS にプッシュ
clasp push

# GAS のコードをローカルにプル
clasp pull

# GAS エディタをブラウザで開く
clasp open
```

## テスト

GAS エディタで `main` 関数を選択し、「実行」ボタンをクリックする。
実行ログは「実行数」メニューまたは `Logger.log()` の出力で確認できる。

## ファイル構成

```
SES-Mail-Catcher/
├── src/
│   └── main.gs           # GAS メインスクリプト
├── appsscript.json        # GAS プロジェクト設定 (マニフェスト)
├── .clasp.json            # clasp 設定 (スクリプトID)
├── .gitignore
└── README.md
```
