/**
 * SES Mail Catcher - Google Apps Script
 *
 * SES 協業社からのメールを Gmail から自動検知し、
 * 送信元アドレスとドメイン別の件数を Slack に通知する。
 */

// ============================================================
// Constants
// ============================================================

var DEFAULTS = {
  GMAIL_PAGE_SIZE: 100,
  GMAIL_MAX_THREADS: 500,
  GEMINI_BATCH_SIZE: 50,
  GEMINI_MAX_RETRIES: 3,
  GEMINI_TEMPERATURE: 0.1,
  GEMINI_MAX_TOKENS: 1024,
  EXECUTION_TIME_LIMIT_SEC: 300,
  SLACK_MAX_RETRIES: 2,
  SLACK_RETRY_WAIT_MS: 2000,
  SLACK_TEXT_MAX_LENGTH: 2900,
  SENDER_DISPLAY_LIMIT: 10
};

// ============================================================
// Configuration helpers
// ============================================================

/**
 * Script Properties から設定値を読み込む。
 * @return {Object} config
 */
function loadConfig() {
  var props = PropertiesService.getScriptProperties();
  return {
    slackWebhookUrl: props.getProperty("SLACK_WEBHOOK_URL") || "",
    labelName: props.getProperty("LABEL_NAME") || "SES案件",
    geminiApiKey: props.getProperty("GEMINI_API_KEY") || ""
  };
}

// ============================================================
// Utility
// ============================================================

/**
 * テキストを指定文字数で切り詰める。
 * @param {string} text
 * @param {number} maxLength
 * @return {string}
 */
function truncateText(text, maxLength) {
  if (text.length > maxLength) {
    return text.substring(0, maxLength) + "\n_...省略_";
  }
  return text;
}

/**
 * 前日の日付を YYYY/MM/DD 形式で返す。
 * @return {string} 前日の日付文字列
 */
function getYesterdayDateString() {
  var today = new Date();
  var yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  var y = yesterday.getFullYear();
  var m = ("0" + (yesterday.getMonth() + 1)).slice(-2);
  var d = ("0" + yesterday.getDate()).slice(-2);
  return y + "/" + m + "/" + d;
}

// ============================================================
// Entry point
// ============================================================

/**
 * メインエントリポイント。時間ベーストリガーから呼び出される。
 */
function main() {
  var startTime = new Date();
  var config = loadConfig();

  // Slack Webhook URL の検証
  if (!config.slackWebhookUrl) {
    Logger.log("ERROR: SLACK_WEBHOOK_URL が Script Properties に設定されていません。");
    return;
  }

  // Gemini API Key の検証
  if (!config.geminiApiKey) {
    Logger.log("ERROR: GEMINI_API_KEY が Script Properties に設定されていません。");
    return;
  }

  Logger.log("=== SES Mail Catcher 開始 ===");
  Logger.log("Label: " + config.labelName);

  // 1. メール検索
  var threads = searchEmails(config.labelName);
  Logger.log("検索結果: " + threads.length + " スレッド");

  // 2. Gemini API で分類
  var result = classifyWithGemini(threads, config.geminiApiKey, startTime);
  Logger.log("マッチ: " + result.matchedThreads.length + " スレッド, " + result.matchedCount + " 件");

  // 3. ラベル付与
  if (result.matchedThreads.length > 0) {
    applyLabel(result.matchedThreads, config.labelName);
  }

  // 4. Slack 通知
  var payload = formatSlackPayload(result, threads.length);
  sendSlackNotification(config.slackWebhookUrl, payload);

  Logger.log("=== SES Mail Catcher 完了 ===");
}

// ============================================================
// Gmail search
// ============================================================

/**
 * 当日＋前日のメールスレッドを検索する。
 * 100件ずつページネーションし、最大500件まで取得する。
 * @param {string} labelName - 除外するラベル名
 * @return {GmailThread[]} threads
 */
function searchEmails(labelName) {
  var query = "after:" + getYesterdayDateString() + " -label:\"" + labelName + "\"";
  Logger.log("検索クエリ: " + query);

  var allThreads = [];
  var pageSize = DEFAULTS.GMAIL_PAGE_SIZE;
  var maxThreads = DEFAULTS.GMAIL_MAX_THREADS;

  for (var start = 0; start < maxThreads; start += pageSize) {
    var threads = GmailApp.search(query, start, pageSize);
    if (threads.length === 0) {
      break;
    }
    Array.prototype.push.apply(allThreads, threads);
    if (threads.length < pageSize) {
      break;
    }
  }

  return allThreads;
}

/**
 * "Name <email@domain.com>" 形式からメールアドレスを抽出する。
 * @param {string} from
 * @return {string} email
 */
function parseEmail(from) {
  var match = from.match(/<([^>]+)>/);
  if (match) {
    return match[1].toLowerCase();
  }
  // <> がない場合はそのまま返す
  return from.trim().toLowerCase();
}

/**
 * メールアドレスからドメインを抽出する。
 * @param {string} email
 * @return {string} domain
 */
function parseDomain(email) {
  var parts = email.split("@");
  return parts.length > 1 ? parts[1] : email;
}

// ============================================================
// Gemini API classification
// ============================================================

/**
 * 経過秒数を返す。
 * @param {Date} startTime - 処理開始時刻
 * @return {number} 経過秒数
 */
function getElapsedSeconds(startTime) {
  return (new Date() - startTime) / 1000;
}

/**
 * Gemini API を使用してメールを SES 関連かどうか分類する。
 * 50 件ずつバッチ処理し、API 失敗時は最大3回リトライ（指数バックオフ）する。
 * 5分（300秒）を超えた場合は安全に中断する。
 *
 * @param {GmailThread[]} threads - 検索結果スレッド
 * @param {string} geminiApiKey - Gemini API キー
 * @param {Date} startTime - main() の開始時刻
 * @return {Object} result
 *   - matchedThreads: GmailThread[]
 *   - matchedCount: number
 *   - senderCounts: Object<string, number>
 *   - domainCounts: Object<string, number>
 *   - timedOut: boolean
 */
function classifyWithGemini(threads, geminiApiKey, startTime) {
  // 全メッセージをフラット配列に展開
  var entries = [];
  var allMessages = GmailApp.getMessagesForThreads(threads);
  for (var i = 0; i < allMessages.length; i++) {
    for (var j = 0; j < allMessages[i].length; j++) {
      var msg = allMessages[i][j];
      entries.push({
        threadIndex: i,
        subject: msg.getSubject() || "",
        from: msg.getFrom() || ""
      });
    }
  }

  Logger.log("Gemini 分類対象: " + entries.length + " メッセージ");

  if (entries.length === 0) {
    return { matchedThreads: [], matchedCount: 0, senderCounts: {}, domainCounts: {}, timedOut: false };
  }

  // バッチ分割
  var batchSize = DEFAULTS.GEMINI_BATCH_SIZE;
  var matchedIndicesSet = {};
  var timedOut = false;
  var timeLimitSeconds = DEFAULTS.EXECUTION_TIME_LIMIT_SEC;
  var maxRetries = DEFAULTS.GEMINI_MAX_RETRIES;

  for (var batchStart = 0; batchStart < entries.length; batchStart += batchSize) {
    // GAS 6分制限への対応: 5分を超えたら安全に中断
    if (getElapsedSeconds(startTime) > timeLimitSeconds) {
      Logger.log("実行時間が " + timeLimitSeconds + " 秒を超えたため処理を中断します");
      timedOut = true;
      break;
    }

    var batchEnd = Math.min(batchStart + batchSize, entries.length);
    var batchEntries = entries.slice(batchStart, batchEnd);

    // 最大3回のリトライ（指数バックオフ付き）
    var batchResult = null;
    for (var attempt = 0; attempt < maxRetries; attempt++) {
      if (attempt > 0) {
        var waitMs = Math.pow(2, attempt) * 1000; // 2秒, 4秒
        Logger.log("Gemini API リトライ " + attempt + "/" + maxRetries + " (" + waitMs + "ms 待機)");
        Utilities.sleep(waitMs);
      }

      batchResult = callGeminiForBatch(batchEntries, batchStart, geminiApiKey);
      if (batchResult !== null) {
        break;
      }
    }

    if (batchResult === null) {
      Logger.log("Gemini API バッチ " + batchStart + "-" + batchEnd + " は " + maxRetries + " 回リトライ後も失敗。このバッチをスキップして次へ進みます");
      continue;
    }

    for (var k = 0; k < batchResult.length; k++) {
      var idx = batchResult[k];
      if (idx >= 0 && idx < entries.length) {
        matchedIndicesSet[idx] = true;
      }
    }
  }

  // マッチしたメッセージから結果を構築
  var matchedThreads = [];
  var matchedCount = 0;
  var senderCounts = {};
  var domainCounts = {};
  var matchedThreadIds = {};

  for (var idx = 0; idx < entries.length; idx++) {
    if (!matchedIndicesSet[idx]) {
      continue;
    }

    matchedCount++;
    var entry = entries[idx];
    var email = parseEmail(entry.from);
    var domain = parseDomain(email);

    senderCounts[email] = (senderCounts[email] || 0) + 1;
    domainCounts[domain] = (domainCounts[domain] || 0) + 1;

    var thread = threads[entry.threadIndex];
    var threadId = thread.getId();
    if (!matchedThreadIds[threadId]) {
      matchedThreadIds[threadId] = true;
      matchedThreads.push(thread);
    }
  }

  return {
    matchedThreads: matchedThreads,
    matchedCount: matchedCount,
    senderCounts: senderCounts,
    domainCounts: domainCounts,
    timedOut: timedOut
  };
}

/**
 * バッチ単位で Gemini API を呼び出し、SES 関連メールのインデックスを返す。
 *
 * @param {Array} batchEntries - エントリ配列 (subject, from, snippet)
 * @param {number} globalOffset - グローバルインデックスのオフセット
 * @param {string} apiKey - Gemini API キー
 * @return {number[]|null} マッチしたグローバルインデックス配列。失敗時は null
 */
function callGeminiForBatch(batchEntries, globalOffset, apiKey) {
  var prompt = "あなたはメール分類アシスタントです。\n"
    + "以下のメール一覧から、SES（システムエンジニアリングサービス）の協業・案件に関連するメールを判定してください。\n\n"
    + "SES関連メールの特徴:\n"
    + "- エンジニアの派遣・常駐・業務委託の案件紹介\n"
    + "- スキルシートの送付や要員の提案\n"
    + "- 単価・稼働条件の提示\n"
    + "- SES企業間のパートナー提携や協業の案内\n\n"
    + "以下のメール一覧について、各メールがSES関連かどうかを判定し、JSON配列で返してください。\n"
    + "SES関連のメールのインデックス番号のみを配列で返してください。\n"
    + "該当なしの場合は空配列 [] を返してください。\n\n"
    + "必ず JSON 配列のみを返してください（例: [0, 2, 5]）。\n\n"
    + "メール一覧:\n";

  for (var i = 0; i < batchEntries.length; i++) {
    var e = batchEntries[i];
    var localIndex = globalOffset + i;
    prompt += "[" + localIndex + "] 件名: " + e.subject + " | 送信元: " + e.from + "\n";
  }

  var endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + apiKey;

  var body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: DEFAULTS.GEMINI_TEMPERATURE,
      maxOutputTokens: DEFAULTS.GEMINI_MAX_TOKENS
    }
  };

  var options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  };

  try {
    var response = UrlFetchApp.fetch(endpoint, options);
    var statusCode = response.getResponseCode();

    if (statusCode !== 200) {
      Logger.log("Gemini API エラー: HTTP " + statusCode + " - " + response.getContentText());
      return null;
    }

    var json = JSON.parse(response.getContentText());
    var text = json.candidates[0].content.parts[0].text;
    Logger.log("Gemini 応答: " + text);

    // JSON 配列を抽出 (余計なテキストがある場合に対応)
    var arrayMatch = text.match(/\[[\d,\s]*\]/);
    if (!arrayMatch) {
      Logger.log("Gemini 応答から JSON 配列を抽出できませんでした");
      return null;
    }

    var indices = JSON.parse(arrayMatch[0]);

    // 配列の各要素が数値であることを検証
    for (var i = 0; i < indices.length; i++) {
      if (typeof indices[i] !== "number") {
        Logger.log("Gemini 応答に不正なインデックスが含まれています: " + indices[i]);
        return null;
      }
    }

    return indices;
  } catch (e) {
    Logger.log("Gemini API 呼び出し例外: " + e.message);
    return null;
  }
}

// ============================================================
// Label management
// ============================================================

/**
 * マッチしたスレッドにラベルを付与する。
 * ラベルが存在しない場合は自動作成する。
 *
 * @param {GmailThread[]} threads - ラベルを付与するスレッド
 * @param {string} labelName - ラベル名
 */
function applyLabel(threads, labelName) {
  var label = GmailApp.getUserLabelByName(labelName);

  if (!label) {
    Logger.log("ラベル '" + labelName + "' を作成します。");
    label = GmailApp.createLabel(labelName);
  }

  label.addToThreads(threads);

  Logger.log("ラベル '" + labelName + "' を " + threads.length + " スレッドに付与しました。");
}

// ============================================================
// Slack notification
// ============================================================

/**
 * Slack に Webhook 経由で通知を送信する。
 * 失敗時は 2秒待機して 1回だけリトライする。
 *
 * @param {string} webhookUrl - Slack Incoming Webhook URL
 * @param {Object} payload - Slack Block Kit ペイロード
 */
function sendSlackNotification(webhookUrl, payload) {
  var options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var maxAttempts = DEFAULTS.SLACK_MAX_RETRIES;
  for (var attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      Logger.log("Slack 通知リトライ (" + DEFAULTS.SLACK_RETRY_WAIT_MS + "ms 待機)");
      Utilities.sleep(DEFAULTS.SLACK_RETRY_WAIT_MS);
    }

    var response = UrlFetchApp.fetch(webhookUrl, options);
    var statusCode = response.getResponseCode();

    if (statusCode === 200) {
      Logger.log("Slack 通知送信成功");
      return;
    }

    Logger.log("Slack 通知送信失敗: HTTP " + statusCode + " - " + response.getContentText());
  }

  Logger.log("Slack 通知: " + maxAttempts + " 回試行後も失敗しました");
}

/**
 * Slack Block Kit メッセージペイロードを構築する。
 *
 * @param {Object} result - classifyWithGemini() の戻り値
 * @param {number} totalScanned - スキャンしたスレッド総数
 * @return {Object} Slack payload
 */
function formatSlackPayload(result, totalScanned) {
  var blocks = [];

  // Header
  blocks.push({
    type: "header",
    text: {
      type: "plain_text",
      text: "SES Mail Catcher Report"
    }
  });

  // 時間制限による部分処理の注意表示
  if (result.timedOut) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: ":warning: *時間制限により一部のメールのみ処理されました*"
      }
    });
  }

  // マッチなしの場合
  if (result.matchedCount === 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "スキャン: *" + totalScanned + "* スレッド\n\n該当メールはありませんでした"
      }
    });

    return { blocks: blocks };
  }

  // Summary
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: "マッチ: *" + result.matchedCount + "* 件 / スキャン: *" + totalScanned + "* スレッド"
    }
  });

  blocks.push({ type: "divider" });

  // Domain breakdown
  blocks.push(formatCountSection(result.domainCounts, "Domain 別集計"));

  blocks.push({ type: "divider" });

  // Sender breakdown
  blocks.push(formatCountSection(result.senderCounts, "送信元アドレス別集計", DEFAULTS.SENDER_DISPLAY_LIMIT));

  return { blocks: blocks };
}

/**
 * カウントマップを Slack 用の箇条書きセクションに変換する。
 * @param {Object<string, number>} counts
 * @param {string} title
 * @param {number} [limit] - 表示件数上限（省略時は全件）
 * @return {Object} Slack section block
 */
function formatCountSection(counts, title, limit) {
  var lines = sortByCountDesc(counts);
  var top = limit ? Math.min(lines.length, limit) : lines.length;
  var suffix = (limit && lines.length > limit) ? " (上位" + limit + "件)" : "";
  var text = "*" + title + suffix + ":*\n";
  for (var i = 0; i < top; i++) {
    text += "\u2022 `" + lines[i].key + "` : " + lines[i].count + " 件\n";
  }
  text = truncateText(text, DEFAULTS.SLACK_TEXT_MAX_LENGTH);
  return { type: "section", text: { type: "mrkdwn", text: text } };
}

/**
 * { key: count } オブジェクトを count 降順でソートし配列にする。
 * @param {Object<string, number>} counts
 * @return {Array<{key: string, count: number}>}
 */
function sortByCountDesc(counts) {
  var arr = [];
  for (var key in counts) {
    if (counts.hasOwnProperty(key)) {
      arr.push({ key: key, count: counts[key] });
    }
  }
  arr.sort(function (a, b) { return b.count - a.count; });
  return arr;
}

// ============================================================
// Trigger management
// ============================================================

/**
 * main() 用の時間ベーストリガーを設定する。
 * 既存の main トリガーを削除してから 0:00, 8:00, 16:00 の3つを新規作成する。
 * GAS エディタから手動で1回実行すること。
 */
function setupTriggers() {
  deleteTriggers();

  var hours = [0, 8, 16];
  for (var i = 0; i < hours.length; i++) {
    ScriptApp.newTrigger("main")
      .timeBased()
      .atHour(hours[i])
      .everyDays(1)
      .create();
    Logger.log("トリガー作成: main() at " + hours[i] + ":00");
  }

  Logger.log("トリガー設定完了: " + hours.length + " 個のトリガーを作成しました");
}

/**
 * main() 用の時間ベーストリガーを全て削除する。
 */
function deleteTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  var count = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "main") {
      ScriptApp.deleteTrigger(triggers[i]);
      count++;
    }
  }
  Logger.log("既存トリガー削除: " + count + " 個");
}
