/**
 * アプリケーション設定
 * 秘匿情報は Script Properties から取得する
 */

const CONFIG = {
  // Gemini API
  GEMINI_API_BASE: 'https://generativelanguage.googleapis.com/v1beta/models',
  GEMINI_MODEL: 'gemini-2.5-flash',
  GEMINI_TEMPERATURE: 0,
  GEMINI_MAX_TOKENS: 512,

  // レートリミット対策
  API_CALL_DELAY_MS: 500,
  API_RETRY_MAX: 3,
  API_RETRY_BASE_DELAY_MS: 1000,

  // メール処理
  MAX_EXECUTION_MS: 5 * 60 * 1000, // 5分（GAS 6分制限に対して1分のバッファ）
  EMAIL_BODY_MAX_LENGTH: 2000,

  // Gmail ラベル
  LABEL_SOURCE: '_filtered/processed',
  LABEL_BP_UNREPLIED: '_filtered/bp_unreplied',
  LABEL_BP_SLACK_NOTIFIED: '_filtered/bp_slack_notified',
  LABEL_BLOCKED: '_filtered/blocked',

  // 自社ドメイン（これらからの返信があれば「返信済み」とみなす）
  COMPANY_DOMAINS: ['finn.co.jp', 'ex.finn.co.jp'],

  // BP 判定閾値
  BP_CONFIDENCE_THRESHOLD: 0.6,

  // プリフィルター設定
  PRE_FILTER_ENABLED: true,  // false で即時ロールバック可能

  SERVICE_DOMAINS: [
    'amazonaws.com', 'amazon.com', 'google.com', 'googlemail.com',
    'slack.com', 'github.com', 'atlassian.com', 'zoom.us',
    'microsoft.com', 'office365.com', 'backlog.com', 'chatwork.com',
  ],

  NOREPLY_PREFIXES: [
    'noreply@', 'no-reply@', 'mailer-daemon@', 'postmaster@',
  ],
};

/**
 * Script Properties から機密情報を取得するヘルパー
 * @param {string} key - プロパティキー
 * @returns {string} プロパティ値
 */
function getSecretProperty(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) {
    throw new Error(`Script Property "${key}" が設定されていません`);
  }
  return value;
}

/**
 * Gemini API キーを取得
 * @returns {string}
 */
function getGeminiApiKey() {
  return getSecretProperty('GEMINI_API_KEY');
}

/**
 * Slack Webhook URL を取得
 * @returns {string}
 */
function getSlackWebhookUrl() {
  return getSecretProperty('SLACK_WEBHOOK_URL');
}
