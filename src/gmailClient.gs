/**
 * Gmail クライアント（GmailApp サービス版）
 *
 * GAS 組み込みの GmailApp サービスを使用してメールを操作する。
 * GCP コンソールでの Gmail API 有効化は不要。
 */

/** @type {Object<string, GmailApp.GmailLabel>} ラベル名 → GmailLabel オブジェクトのキャッシュ */
const labelCache_ = {};

/**
 * 検索クエリを構築する
 * @returns {string} Gmail 検索クエリ
 */
function buildSearchQuery_() {
  return `label:${CONFIG.LABEL_SOURCE} -label:${CONFIG.LABEL_BP_UNREPLIED} newer_than:7d`;
}

/**
 * 対象メールのメッセージ情報一覧を取得する
 * label:_filtered/processed かつ label:_filtered/bp_unreplied が付いていない、直近7日のメール
 * @returns {{ id: string, threadId: string, gmailMessage: GmailApp.GmailMessage, gmailThread: GmailApp.GmailThread }[]} メッセージ情報の配列
 */
function getTargetMessages() {
  const query = buildSearchQuery_();

  try {
    const threads = GmailApp.search(query, 0, 500);
    if (!threads || threads.length === 0) {
      return [];
    }

    const results = [];
    for (const thread of threads) {
      const messages = thread.getMessages();
      // スレッド内の最初のメッセージを対象とする
      if (messages && messages.length > 0) {
        const msg = messages[0];
        results.push({
          id: msg.getId(),
          threadId: thread.getId(),
          gmailMessage: msg,
          gmailThread: thread,
        });
      }
    }
    return results;
  } catch (e) {
    console.error('対象メール取得に失敗:', e.message);
    return [];
  }
}

/**
 * メールの詳細情報を取得する
 * @param {GmailApp.GmailMessage} gmailMessage - GmailMessage オブジェクト
 * @returns {{ id: string, threadId: string, from: string, subject: string, body: string, date: string }}
 */
function getMessageDetail(gmailMessage) {
  const from = gmailMessage.getFrom();
  const subject = gmailMessage.getSubject();
  const date = gmailMessage.getDate();

  // プレーンテキストを優先、なければ HTML からテキスト抽出
  let body = gmailMessage.getPlainBody();
  if (!body) {
    body = stripHtml(gmailMessage.getBody());
  }

  return {
    id: gmailMessage.getId(),
    threadId: gmailMessage.getThread().getId(),
    from: from,
    subject: subject,
    body: truncateText(body, CONFIG.EMAIL_BODY_MAX_LENGTH),
    date: date ? formatDate(date) : '',
  };
}

/**
 * スレッド内に自社ドメインからの返信があるか確認する
 * @param {string} threadId - Gmail スレッドID
 * @returns {boolean} 自社からの返信があれば true
 */
function hasCompanyReply(threadId) {
  try {
    const thread = GmailApp.getThreadById(threadId);
    if (!thread) return false;

    const messages = thread.getMessages();
    for (const message of messages) {
      const fromValue = message.getFrom() || '';
      const match = fromValue.match(/<([^>]+)>/) || fromValue.match(/(\S+@\S+)/);
      const emailAddress = match ? match[1].toLowerCase() : fromValue.toLowerCase();

      for (const domain of CONFIG.COMPANY_DOMAINS) {
        if (emailAddress.endsWith('@' + domain)) {
          return true;
        }
      }
    }

    return false;
  } catch (e) {
    console.error(`スレッド取得に失敗 (threadId: ${threadId}):`, e.message);
    return false;
  }
}

/**
 * ラベルが存在することを確認し、なければ作成する
 * @param {string} labelName - ラベル名
 * @returns {GmailApp.GmailLabel} GmailLabel オブジェクト
 */
function ensureLabelExists(labelName) {
  if (labelCache_[labelName]) {
    return labelCache_[labelName];
  }

  let label = GmailApp.getUserLabelByName(labelName);
  if (!label) {
    try {
      label = GmailApp.createLabel(labelName);
    } catch (e) {
      console.error(`ラベル "${labelName}" の作成に失敗:`, e.message);
      throw e;
    }
  }

  labelCache_[labelName] = label;
  return label;
}

/**
 * スレッドにラベルを付与する
 * @param {GmailApp.GmailThread} gmailThread - GmailThread オブジェクト
 * @param {string} labelName - 付与するラベル名
 */
function addLabel(gmailThread, labelName) {
  const label = ensureLabelExists(labelName);

  try {
    label.addToThread(gmailThread);
  } catch (e) {
    console.error(`ラベル "${labelName}" の付与に失敗 (threadId: ${gmailThread.getId()}):`, e.message);
    throw e;
  }
}
