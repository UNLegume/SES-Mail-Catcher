# SES Mail Catcher

SES（システムエンジニアリングサービス）協業に向けた**初期アプローチメールを自動検知**し、未返信のものをSlackに通知するGoogle Apps Scriptシステム。

## 概要

finn株式会社のSES事業用メーリングリスト（service@finn.co.jp）に届くメールを Gemini AI で分析し、協業打診・面談提案・問い合わせ応答などの初期アプローチを検知します。未返信のメールがあればSlackに通知し、対応漏れを防ぎます。

### 検知対象

- 他社からのSES協業・パートナー契約・情報交換の申し入れ
- finn側のHP・フォーム問い合わせに対する先方からの返信・面談提案
- 初回の顔合わせ・協業検討を目的とした打ち合わせの提案（日程候補・予約リンク含む）

### 検知対象外

- 既存取引先との日常業務（案件紹介・要員提案・スキルシート等）
- クラウドサービス通知、一般営業メール、ニュースレター
- フォーム自動返信、社内メール

## アーキテクチャ

```
Gmail (_filtered/processed)
    ↓  GAS時間トリガー (11:30 / 20:30 JST)
getTargetMessages() ── GmailApp (組み込みサービス)
    ↓
classifyEmailAsBP() ── Gemini 2.5 Flash (JSON応答)
    ↓  is_bp: true & confidence ≥ 0.6
hasCompanyReply() ── スレッド内の自社返信チェック
    ↓  未返信のみ
sendBPUnrepliedNotification() ── Slack Webhook
```

### 上流システム

[gmail-spam-slayer](https://github.com/nobuhiro-nagata/gmail-spam-slayer)がスパムフィルタリング済みメールに`_filtered/processed`ラベルを付与。本システムはそのラベルを起点に動作します。

## ファイル構成

```
├── .clasp.json              # GASプロジェクトID・ルートディレクトリ設定
├── eml/                     # テスト用サンプルメール（実メール5件）
└── src/
    ├── appsscript.json      # GASマニフェスト（タイムゾーン・OAuthスコープ）
    ├── main.gs              # エントリポイント: processEmails, initialize, setupTriggers
    ├── config.gs            # 設定定数・シークレット取得
    ├── classifier.gs        # Gemini APIによるBP分類プロンプト・リトライロジック
    ├── gmailClient.gs       # GmailApp クライアント・ラベル管理
    ├── slackNotifier.gs     # Slack Webhook通知
    ├── utils.gs             # ユーティリティ（メール正規化・HTML除去・Base64デコード等）
    └── test.gs              # ユニットテスト
```

## セットアップ

### 前提条件

- [clasp](https://github.com/google/clasp) がインストール済み
- Google AI Studio で Gemini API キーを取得済み
- Slack Incoming Webhook URL を作成済み

### 手順

1. **claspでGASプロジェクトにリンク**
   ```bash
   clasp login
   clasp push
   ```

2. **Script Properties を設定**（GASエディタ > プロジェクトの設定）
   | プロパティ名 | 値 |
   |---|---|
   | `GEMINI_API_KEY` | Gemini APIキー |
   | `SLACK_WEBHOOK_URL` | Slack Webhook URL |

3. **初期化関数を実行**（GASエディタ）
   ```
   initialize()  → シークレット検証 & ラベル作成
   setupTriggers()  → 日次トリガー設定 (11:30 / 20:30 JST)
   ```

## 設定値

| 項目 | 値 | 説明 |
|---|---|---|
| `GEMINI_MODEL` | `gemini-2.5-flash` | 分類に使用するモデル |
| `GEMINI_TEMPERATURE` | `0` | 決定論的応答 |
| `BP_CONFIDENCE_THRESHOLD` | `0.6` | BP判定の閾値 |
| `EMAIL_BODY_MAX_LENGTH` | `2000` | 本文の最大文字数（トークン制御） |
| `API_RETRY_MAX` | `3` | APIリトライ回数（指数バックオフ） |
| `MAX_EXECUTION_MS` | `300000` | 実行時間上限（5分、GAS制限6分に対するバッファ） |
| `COMPANY_DOMAINS` | `finn.co.jp, ex.finn.co.jp` | 自社返信判定用ドメイン |

## テスト

GASエディタで `runAllTests()` を実行:

```
runAllTests()
```

Utils、GmailClient、Classifier、SlackNotifierの各モジュールのユニットテストが実行されます。

## 処理の流れ

1. **メール取得**: `_filtered/processed`ラベル付き & `_filtered/bp_unreplied`ラベルなし & 過去1日以内のメールを検索
2. **AI分類**: Gemini APIで各メールを分析、`is_bp`（真偽値）・`confidence`（0.0〜1.0）・`reason`（判定理由）を返却
3. **返信チェック**: BP判定されたメールのスレッドに自社ドメインからの返信があるか確認
4. **ラベル付与**: 処理済みメールに`_filtered/bp_unreplied`ラベルを付与（再処理防止）
5. **Slack通知**: 未返信BPメールがあれば送信元・件名をSlackに通知

## ライセンス

Private
