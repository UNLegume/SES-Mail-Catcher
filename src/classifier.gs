/**
 * Gemini API を使用した SES 協業初期アプローチ検知
 *
 * メールの送信元・件名・本文を Gemini で分析し、
 * SES 協業に向けた初期アプローチ（協業打診・面談提案・問い合わせ応答）に
 * 該当するかどうかを判定する。
 *
 * 戻り値の形式:
 * {
 *   "is_bp": true | false,
 *   "confidence": 0.0 - 1.0,
 *   "reason": "判定理由"
 * }
 */

/**
 * SES 協業初期アプローチ検知用のプロンプトを構築する
 * @param {string} subject - メールの件名
 * @param {string} body - メールの本文
 * @param {string} from - 送信元アドレス
 * @returns {string} 結合されたプロンプト
 */
function buildBPClassificationPrompt(subject, body, from) {
  const truncatedBody = body && body.length > CONFIG.EMAIL_BODY_MAX_LENGTH
    ? body.substring(0, CONFIG.EMAIL_BODY_MAX_LENGTH) + '...(以下省略)'
    : body || '';

  return `あなたはビジネスメールの分類エキスパートです。

## 受信者の背景
受信者はSES（システムエンジニアリングサービス）事業を運営するfinn株式会社です。
このメールアドレス（service@finn.co.jp）はSES案件のやり取り用メーリングリストです。
このメールはスパムフィルター通過済みのため、スパム判定は不要です。

## タスク
以下のメールが「SES協業に向けた初期アプローチ」に該当するかを判定してください。

## 判定基準（is_bp: true）
以下のいずれかに該当するメールが対象です:

1. 協業打診・提案: 他社からSES事業での協業・パートナー契約・情報交換を申し入れるメール
2. 問い合わせへの応答: finn側のHP・フォーム問い合わせに対する先方からの返信・お礼・面談提案
3. 打ち合わせ・面談の申し込み: 初回の顔合わせ・情報交換・協業検討を目的とした面談や打ち合わせの提案（日程候補の提示や予約リンクの共有を含む）

共通する特徴:
- まだ取引関係が成立していない段階のやり取り
- 「お打ち合わせ」「面談」「情報交換」「協業」「パートナー」等のキーワード
- 日程候補の提示や日程調整ツール（timerex, calendly等）のリンク共有
- 「お問い合わせ頂き」「HPより」「フォームより」等、初回接触を示す表現

## 対象外（is_bp: false）
以下は協業の初期アプローチではないため対象外:
- 既存取引先との日常業務: 案件紹介・要員提案・スキルシート・単価交渉・稼働中案件の連絡
- サービス通知: AWS・Google・Slack等のクラウドサービスからの通知
- 一般営業: DXコンサル・BPO・ツール販売・セミナー案内・採用媒体営業
- ニュースレター・メールマガジン
- フォーム自動返信（人が書いた返信ではない機械的な受付確認）
- 自社ドメイン（finn.co.jp）からの社内メール

## confidenceの基準
- 0.9〜1.0: 「面談」「打ち合わせ」「情報交換」+「協業」「パートナー」が明示的。日程候補や予約リンクあり
- 0.7〜0.89: 面談・打ち合わせの提案があるが協業目的か曖昧、または「お問い合わせ頂き」で初回接触は明確だが具体的な面談提案なし
- 0.5〜0.69: 会社紹介・挨拶メールだが面談や協業への言及が弱い
- 0.3以下: 明らかに初期アプローチではない（既存取引・通知・営業等）

## 回答形式
以下のJSON形式で回答:
{
  "is_bp": true または false,
  "confidence": 0.0〜1.0の数値,
  "reason": "日本語で30字以内の判定理由"
}

## 分類対象のメール

送信元: ${from || '(不明)'}
件名: ${subject || '(件名なし)'}

本文:
${truncatedBody || '(本文なし)'}`;
}

/**
 * Gemini API を使用してメールを BP 分類する
 * @param {string} subject - メールの件名
 * @param {string} body - メールの本文
 * @param {string} from - 送信元アドレス
 * @param {number} [startTime] - 処理開始時刻（Date.now()）。リトライ中の実行時間チェックに使用
 * @returns {{ is_bp: boolean, confidence: number, reason: string }}
 */
function classifyEmailAsBP(subject, body, from, startTime) {
  try {
    const prompt = buildBPClassificationPrompt(subject, body, from);
    const apiKey = getGeminiApiKey();

    const url = `${CONFIG.GEMINI_API_BASE}/${CONFIG.GEMINI_MODEL}:generateContent?key=${apiKey}`;

    const payload = {
      contents: [
        {
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature: CONFIG.GEMINI_TEMPERATURE,
        maxOutputTokens: CONFIG.GEMINI_MAX_TOKENS,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            is_bp: { type: 'BOOLEAN' },
            confidence: { type: 'NUMBER' },
            reason: { type: 'STRING' },
          },
          required: ['is_bp', 'confidence', 'reason'],
        },
        thinkingConfig: { thinkingBudget: 0 },
      },
    };

    const options = {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    };

    let response;
    let statusCode;

    const retryableStatuses = [429, 500, 502, 503, 504];

    for (let attempt = 0; attempt <= CONFIG.API_RETRY_MAX; attempt++) {
      response = UrlFetchApp.fetch(url, options);
      statusCode = response.getResponseCode();

      if (!retryableStatuses.includes(statusCode)) break;

      if (attempt === CONFIG.API_RETRY_MAX) {
        console.error(`Gemini API エラー (HTTP ${statusCode}): ${CONFIG.API_RETRY_MAX}回リトライ後も失敗`);
        return {
          is_bp: false,
          confidence: 0.0,
          reason: `APIエラー: HTTP ${statusCode} リトライ超過`,
        };
      }

      // リトライsleep前に実行時間チェック
      if (startTime && (Date.now() - startTime > CONFIG.MAX_EXECUTION_MS)) {
        console.warn('リトライ中止: 実行時間制限に到達');
        return {
          is_bp: false,
          confidence: 0.0,
          reason: 'リトライ中止: 実行時間制限',
        };
      }

      const delayMs = CONFIG.API_RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
      console.warn(`Gemini API ${statusCode}: ${delayMs / 1000}秒待機してリトライ (${attempt + 1}/${CONFIG.API_RETRY_MAX})`);
      Utilities.sleep(delayMs);
    }

    if (statusCode !== 200) {
      const errorBody = response.getContentText();
      console.error(`Gemini API エラー (HTTP ${statusCode}): ${errorBody}`);
      return {
        is_bp: false,
        confidence: 0.0,
        reason: `APIエラー: HTTP ${statusCode}`,
      };
    }

    const responseData = JSON.parse(response.getContentText());
    const parts = responseData.candidates[0].content.parts;
    const content = parts[parts.length - 1].text;
    const result = JSON.parse(content);

    if (typeof result.is_bp !== 'boolean') {
      console.warn(`不正な is_bp 値: ${result.is_bp}`);
      return {
        is_bp: false,
        confidence: 0.0,
        reason: `不正な分類結果: ${result.is_bp}`,
      };
    }

    const confidence = Number(result.confidence);
    if (isNaN(confidence) || confidence < 0 || confidence > 1) {
      console.warn(`不正な confidence 値: ${result.confidence}`);
      return {
        is_bp: false,
        confidence: 0.0,
        reason: `不正な確信度: ${result.confidence}`,
      };
    }

    return {
      is_bp: result.is_bp,
      confidence: confidence,
      reason: result.reason || '理由なし',
    };
  } catch (e) {
    console.error(`classifyEmailAsBP エラー: ${e.message}`);
    return {
      is_bp: false,
      confidence: 0.0,
      reason: `APIエラー: ${e.message}`,
    };
  }
}
