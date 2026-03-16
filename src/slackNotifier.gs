/**
 * Slack 通知モジュール（Incoming Webhook）
 *
 * BP 未返信メールの検出結果を Slack に通知する。
 * Incoming Webhook を使用するため、Bot Token やチャンネル ID は不要。
 */

/**
 * 未返信ありの通知メッセージを構築する
 * @param {{ from: string, subject: string }[]} unrepliedList - 未返信メール情報の配列
 * @returns {string} 通知メッセージ
 */
function buildUnrepliedMessage_(unrepliedList) {
  const senders = unrepliedList
    .map((entry) => '- ' + normalizeEmail(entry.from))
    .join('\n');

  return ':rotating_light: SES Mail Catcher: 未返信 BP メール通知\n' +
    '未返信 BP メール: ' + unrepliedList.length + ' 件\n\n' +
    '送信元一覧:\n' + senders;
}

/**
 * 未返信なしの通知メッセージを構築する
 * @param {number} processedCount - 処理した総件数
 * @returns {string} 通知メッセージ
 */
function buildNoUnrepliedMessage_(processedCount) {
  return ':white_check_mark: SES Mail Catcher: 未返信 BP メールはありませんでした\n' +
    '処理件数: ' + processedCount + ' 件';
}

/**
 * 通知メッセージを構築する（テスト用にエクスポート）
 * @param {{ from: string, subject: string }[]} unrepliedList - 未返信メール情報の配列
 * @param {number} processedCount - 処理した総件数
 * @returns {string} 通知メッセージ
 */
function buildNotificationMessage(unrepliedList, processedCount) {
  if (unrepliedList.length > 0) {
    return buildUnrepliedMessage_(unrepliedList);
  }
  return buildNoUnrepliedMessage_(processedCount);
}

/**
 * BP 未返信メールの通知を Slack に送信する
 * @param {{ from: string, subject: string }[]} unrepliedList - 未返信メール情報の配列
 * @param {number} processedCount - 処理した総件数
 * @returns {boolean} 通知成功時 true、失敗時 false
 */
function sendBPUnrepliedNotification(unrepliedList, processedCount) {
  try {
    const webhookUrl = getSlackWebhookUrl();
    const message = buildNotificationMessage(unrepliedList, processedCount);

    const options = {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ text: message }),
      muteHttpExceptions: true,
    };

    const response = UrlFetchApp.fetch(webhookUrl, options);
    const responseCode = response.getResponseCode();

    if (responseCode !== 200) {
      console.error(`Slack 通知失敗 (HTTP ${responseCode}): ${response.getContentText()}`);
      return false;
    }
    console.log('Slack 通知送信完了');
    return true;
  } catch (e) {
    console.error('Slack 通知エラー:', e.message);
    return false;
  }
}
