/**
 * SES Mail Catcher メインモジュール
 *
 * gmail-spam-slayer が処理済み(_filtered/processed)としたメールの中から、
 * BP（ビジネスパートナー）協業関連で未返信のメールを検出し、
 * ラベル付与 + Slack 通知する。
 */

/**
 * メイン処理: BP 未返信メールの検出・ラベル付与・Slack 通知
 * GAS トリガーから呼び出される。
 */
function processEmails() {
  const startTime = Date.now();
  console.log('=== SES Mail Catcher 処理開始 ===');

  // ラベルの存在を確認・作成
  ensureLabelExists(CONFIG.LABEL_BP_UNREPLIED);
  ensureLabelExists(CONFIG.LABEL_BP_SLACK_NOTIFIED);

  // 対象メール取得
  const messages = getTargetMessages();
  const total = messages.length;
  console.log(`対象メール: ${total} 件`);

  if (total === 0) {
    console.log('処理対象なし');
    sendBPUnrepliedNotification([], 0);
    return;
  }

  const unrepliedList = [];
  let processedCount = 0;
  let preFilterBPCount = 0;
  let preFilterNotBPCount = 0;
  let geminiCount = 0;

  for (let i = 0; i < total; i++) {
    // 実行時間チェック
    const elapsed = Date.now() - startTime;
    if (elapsed > CONFIG.MAX_EXECUTION_MS) {
      console.warn(`実行時間制限に到達 (${Math.round(elapsed / 1000)}秒)。${i}/${total} 件で中断`);
      break;
    }

    const msg = messages[i];
    let usedGemini = false;

    try {
      // メール詳細取得
      const detail = getMessageDetail(msg.gmailMessage);
      console.log(`処理中 ${i + 1}/${total}: ${detail.from} - ${detail.subject}`);

      // プリフィルター + Gemini 分類
      let classification;

      if (CONFIG.PRE_FILTER_ENABLED) {
        const pf = preFilterEmail(detail.subject, detail.body, detail.from);
        if (pf.verdict === PRE_FILTER_VERDICT.CLEAR_NOT_BP) {
          classification = { is_bp: false, confidence: 0.0, reason: 'プリフィルタ: ' + pf.reason };
          preFilterNotBPCount++;
          console.log(`  → プリフィルタ: 非BP [${pf.rule}]`);
        } else if (pf.verdict === PRE_FILTER_VERDICT.CLEAR_BP) {
          classification = { is_bp: true, confidence: 1.0, reason: 'プリフィルタ: ' + pf.reason };
          preFilterBPCount++;
          console.log(`  → プリフィルタ: BP [${pf.rule}]`);
        }
      }

      if (!classification) {
        classification = classifyEmailAsBP(detail.subject, detail.body, detail.from, startTime);
        usedGemini = true;
        geminiCount++;
      }

      if (classification.is_bp && classification.confidence >= CONFIG.BP_CONFIDENCE_THRESHOLD) {
        const replied = hasCompanyReply(msg.threadId);
        if (!replied) {
          addLabel(msg.gmailThread, CONFIG.LABEL_BP_UNREPLIED);
          unrepliedList.push({ from: detail.from, subject: detail.subject, gmailThread: msg.gmailThread });
          console.log(`  → BP未返信: ラベル付与`);
        } else {
          console.log(`  → BP返信済み: スキップ`);
        }
      } else {
        console.log(`  → 非BP (confidence: ${classification.confidence}): スキップ`);
      }

      processedCount++;
    } catch (e) {
      console.error(`メッセージ処理エラー (id: ${msg.id}):`, e.message);
    }

    // Gemini 呼び出し時のみ sleep（プリフィルタ判定時は不要）
    if (usedGemini) {
      Utilities.sleep(CONFIG.API_CALL_DELAY_MS);
    }
  }

  // サマリーログ
  const totalElapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`=== 処理完了: ${processedCount}/${total} 件処理, 未返信 BP: ${unrepliedList.length} 件, 所要時間: ${totalElapsed}秒 ===`);
  console.log(`  プリフィルタBP: ${preFilterBPCount} 件, プリフィルタ非BP: ${preFilterNotBPCount} 件, Gemini判定: ${geminiCount} 件`);

  // Slack 通知
  if (sendBPUnrepliedNotification(unrepliedList, processedCount)) {
    // 通知成功時にラベル付与
    for (const entry of unrepliedList) {
      try {
        addLabel(entry.gmailThread, CONFIG.LABEL_BP_SLACK_NOTIFIED);
      } catch (e) {
        console.error(`Slack通知済みラベル付与エラー: ${e.message}`);
      }
    }
  }
}

/**
 * 初期セットアップ: Script Properties の検証 + ラベル作成
 * 手動で1回実行する。
 */
function initialize() {
  console.log('=== SES Mail Catcher 初期化 ===');

  // Script Properties 検証
  const requiredProps = ['GEMINI_API_KEY', 'SLACK_WEBHOOK_URL'];
  for (const key of requiredProps) {
    try {
      getSecretProperty(key);
      console.log(`✓ ${key}: 設定済み`);
    } catch (e) {
      console.error(`✗ ${key}: ${e.message}`);
    }
  }

  // ラベル作成
  try {
    ensureLabelExists(CONFIG.LABEL_BP_UNREPLIED);
    console.log(`✓ ラベル "${CONFIG.LABEL_BP_UNREPLIED}": 準備完了`);
  } catch (e) {
    console.error(`✗ ラベル作成失敗: ${e.message}`);
  }
  try {
    ensureLabelExists(CONFIG.LABEL_BP_SLACK_NOTIFIED);
    console.log(`✓ ラベル "${CONFIG.LABEL_BP_SLACK_NOTIFIED}": 準備完了`);
  } catch (e) {
    console.error(`✗ ラベル作成失敗: ${e.message}`);
  }

  console.log('=== 初期化完了 ===');
}

/**
 * トリガーを設定する（11:30, 20:30 JST）
 * 手動で1回実行する。既存トリガーは削除してから再設定する。
 * gmail-spam-slayer（10:00〜11:04）との競合を避けるため1時間後ろにずらしている。
 */
function setupTriggers() {
  // 既存の processEmails トリガーを削除
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === 'processEmails') {
      ScriptApp.deleteTrigger(trigger);
    }
  }

  // 11:30 JST（gmail-spam-slayer の最遅完了 11:04 から十分なマージン確保）
  ScriptApp.newTrigger('processEmails')
    .timeBased()
    .atHour(11)
    .nearMinute(30)
    .everyDays(1)
    .inTimezone('Asia/Tokyo')
    .create();

  // 20:30 JST
  ScriptApp.newTrigger('processEmails')
    .timeBased()
    .atHour(20)
    .nearMinute(30)
    .everyDays(1)
    .inTimezone('Asia/Tokyo')
    .create();

  console.log('トリガー設定完了: 11:30, 20:30 JST');
}
