/**
 * Gmail REST API クライアント
 *
 * Gmail REST API を UrlFetchApp 経由で直接呼び出す。
 * 認証は ScriptApp.getOAuthToken() で取得した OAuth トークンを使用。
 */

/** @type {Object<string, string>} ラベル名 → ラベルID のキャッシュ */
const labelIdCache_ = {};

/**
 * Gmail REST API への共通リクエスト関数
 * @param {string} endpoint - CONFIG.GMAIL_API_BASE からの相対パス
 * @param {Object} [options={}] - UrlFetchApp.fetch に渡すオプション
 * @returns {Object} パース済みレスポンス
 */
function gmailApiRequest(endpoint, options = {}) {
  const url = CONFIG.GMAIL_API_BASE + endpoint;
  const token = ScriptApp.getOAuthToken();

  const defaultOptions = {
    method: 'get',
    headers: {
      Authorization: 'Bearer ' + token,
    },
    muteHttpExceptions: true,
  };

  const mergedOptions = Object.assign({}, defaultOptions, options);
  mergedOptions.headers = Object.assign({}, defaultOptions.headers, options.headers || {});

  const response = UrlFetchApp.fetch(url, mergedOptions);
  const responseCode = response.getResponseCode();

  if (responseCode < 200 || responseCode >= 300) {
    throw new Error(
      `Gmail API エラー: ${responseCode} ${response.getContentText()} (endpoint: ${endpoint})`
    );
  }

  const content = response.getContentText();
  return content ? JSON.parse(content) : {};
}

/**
 * 検索クエリを構築する
 * @returns {string} Gmail 検索クエリ
 */
function buildSearchQuery_() {
  return `label:${CONFIG.LABEL_SOURCE} -label:${CONFIG.LABEL_BP_UNREPLIED} newer_than:1d`;
}

/**
 * 対象メールのメッセージ情報一覧を取得する
 * label:_filtered/processed かつ label:_filtered/bp_unreplied が付いていない、直近1日のメール
 * @returns {{ id: string, threadId: string }[]} メッセージ情報の配列
 */
function getTargetMessages() {
  const query = buildSearchQuery_();
  const endpoint = `/messages?q=${encodeURIComponent(query)}&maxResults=500`;

  try {
    const data = gmailApiRequest(endpoint);
    if (!data.messages || data.messages.length === 0) {
      return [];
    }
    return data.messages.map((msg) => ({ id: msg.id, threadId: msg.threadId }));
  } catch (e) {
    console.error('対象メール取得に失敗:', e.message);
    return [];
  }
}

/**
 * メールの詳細情報を取得する
 * @param {string} messageId - Gmail メッセージID
 * @returns {{ id: string, threadId: string, from: string, subject: string, body: string, date: string }}
 */
function getMessageDetail(messageId) {
  const data = gmailApiRequest(`/messages/${messageId}?format=full`);
  const headers = data.payload.headers || [];

  const getHeader = (name) => {
    const header = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
    return header ? header.value : '';
  };

  const subject = getHeader('Subject');
  const from = getHeader('From');
  const date = getHeader('Date');

  const body = extractBody_(data.payload);

  return {
    id: messageId,
    threadId: data.threadId || '',
    from: from,
    subject: subject,
    body: truncateText(body, CONFIG.EMAIL_BODY_MAX_LENGTH),
    date: date,
  };
}

/**
 * スレッド内に自社ドメインからの返信があるか確認する
 * @param {string} threadId - Gmail スレッドID
 * @returns {boolean} 自社からの返信があれば true
 */
function hasCompanyReply(threadId) {
  try {
    const data = gmailApiRequest(
      `/threads/${threadId}?format=metadata&metadataHeaders=From`
    );
    const messages = data.messages || [];

    for (const message of messages) {
      const headers = (message.payload && message.payload.headers) || [];
      const fromHeader = headers.find(
        (h) => h.name.toLowerCase() === 'from'
      );
      if (!fromHeader) continue;

      const fromValue = fromHeader.value || '';
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
 * メールの payload から本文を抽出する（multipart 対応）
 * @param {Object} payload - Gmail API のメッセージ payload
 * @returns {string} メール本文
 * @private
 */
function extractBody_(payload) {
  if (payload.body && payload.body.data) {
    const mimeType = payload.mimeType || '';
    const decoded = base64UrlDecode(payload.body.data);
    if (mimeType === 'text/html') {
      return stripHtml(decoded);
    }
    return decoded;
  }

  if (payload.parts && payload.parts.length > 0) {
    let plainText = '';
    let htmlText = '';

    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        plainText = base64UrlDecode(part.body.data);
      } else if (part.mimeType === 'text/html' && part.body && part.body.data) {
        htmlText = base64UrlDecode(part.body.data);
      } else if (part.parts) {
        const nested = extractBody_(part);
        if (nested) {
          if (!plainText && part.mimeType !== 'text/html') {
            plainText = nested;
          }
          if (!htmlText) {
            htmlText = nested;
          }
        }
      }
    }

    if (plainText) return plainText;
    if (htmlText) return stripHtml(htmlText);
  }

  return '';
}

/**
 * ラベルが存在することを確認し、なければ作成する
 * @param {string} labelName - ラベル名
 * @returns {string} ラベルID
 */
function ensureLabelExists(labelName) {
  const cachedId = getLabelId(labelName);
  if (cachedId) {
    return cachedId;
  }

  try {
    const data = gmailApiRequest('/labels', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        name: labelName,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
      }),
    });

    labelIdCache_[labelName] = data.id;
    return data.id;
  } catch (e) {
    console.error(`ラベル "${labelName}" の作成に失敗:`, e.message);
    throw e;
  }
}

/**
 * ラベル名からラベルIDを取得する（キャッシュ付き）
 * @param {string} labelName - ラベル名
 * @returns {string|null} ラベルID
 */
function getLabelId(labelName) {
  if (labelIdCache_[labelName]) {
    return labelIdCache_[labelName];
  }

  try {
    const data = gmailApiRequest('/labels');
    const labels = data.labels || [];

    for (const label of labels) {
      labelIdCache_[label.name] = label.id;
    }

    return labelIdCache_[labelName] || null;
  } catch (e) {
    console.error('ラベル一覧の取得に失敗:', e.message);
    return null;
  }
}

/**
 * メッセージにラベルを付与する
 * @param {string} messageId - Gmail メッセージID
 * @param {string} labelName - 付与するラベル名
 */
function addLabel(messageId, labelName) {
  const labelId = ensureLabelExists(labelName);

  try {
    gmailApiRequest(`/messages/${messageId}/modify`, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        addLabelIds: [labelId],
      }),
    });
  } catch (e) {
    console.error(`ラベル "${labelName}" の付与に失敗 (messageId: ${messageId}):`, e.message);
    throw e;
  }
}
