/**
 * ルールベース プリフィルター
 *
 * メールを簡易ルールで事前分類し、明確なケースは Gemini API をスキップする。
 * 判定に迷う場合は UNCERTAIN を返し、従来通り Gemini に委託する。
 */

const PRE_FILTER_VERDICT = {
  CLEAR_BP: 'CLEAR_BP',
  CLEAR_NOT_BP: 'CLEAR_NOT_BP',
  UNCERTAIN: 'UNCERTAIN',
};

/**
 * メールをルールベースで事前分類する
 * @param {string} subject - メール件名
 * @param {string} body - メール本文（プレーンテキスト）
 * @param {string} from - 送信者（"Name <email>" 形式可）
 * @returns {{ verdict: string, reason: string, rule: string }}
 */
function preFilterEmail(subject, body, from) {
  const email = normalizeEmail(from);
  const domain = email.split('@')[1] || '';
  const subjectLower = (subject || '').toLowerCase();
  const bodyLower = (body || '').toLowerCase();

  // --- CLEAR_NOT_BP ルール ---

  // N1: 社内メール
  if (CONFIG.COMPANY_DOMAINS.some(d => domain === d)) {
    return { verdict: PRE_FILTER_VERDICT.CLEAR_NOT_BP, reason: '社内ドメイン: ' + domain, rule: 'N1' };
  }

  // N2: サービス通知ドメイン
  if (CONFIG.SERVICE_DOMAINS.some(d => domain === d || domain.endsWith('.' + d))) {
    return { verdict: PRE_FILTER_VERDICT.CLEAR_NOT_BP, reason: 'サービス通知: ' + domain, rule: 'N2' };
  }

  // N3: noreply 送信者
  if (CONFIG.NOREPLY_PREFIXES.some(p => email.startsWith(p))) {
    return { verdict: PRE_FILTER_VERDICT.CLEAR_NOT_BP, reason: 'noreply送信者: ' + email, rule: 'N3' };
  }

  // N4: 自動返信
  const autoReplyPatterns = ['自動返信', '自動応答', '自動送信', 'auto-reply', 'out of office', '不在'];
  if (autoReplyPatterns.some(p => subjectLower.includes(p) || bodyLower.includes(p))) {
    return { verdict: PRE_FILTER_VERDICT.CLEAR_NOT_BP, reason: '自動返信メール', rule: 'N4' };
  }

  // BP キーワード（N5, N6 のガード句で使用）
  const bpGuardKeywords = ['ses', '協業', 'パートナー'];

  // N5: ニュースレター（ただし BP キーワードがない場合のみ）
  const newsletterPatterns = ['配信停止', 'unsubscribe', 'メルマガ'];
  if (newsletterPatterns.some(p => bodyLower.includes(p))) {
    if (!bpGuardKeywords.some(k => subjectLower.includes(k) || bodyLower.includes(k))) {
      return { verdict: PRE_FILTER_VERDICT.CLEAR_NOT_BP, reason: 'ニュースレター', rule: 'N5' };
    }
  }

  // N6: 一般営業（ただし SES/協業/パートナー がない場合のみ）
  const salesPatterns = ['セミナー', 'ウェビナー', '採用', '求人'];
  if (salesPatterns.some(p => subjectLower.includes(p))) {
    if (!bpGuardKeywords.some(k => subjectLower.includes(k) || bodyLower.includes(k))) {
      return { verdict: PRE_FILTER_VERDICT.CLEAR_NOT_BP, reason: '一般営業メール', rule: 'N6' };
    }
  }

  // N7: フォーム自動受付確認
  const n7Regex1 = /お問い?合わ?せ.{0,40}ありがとうございま(す|した)/;
  const n7Regex2 = /担当(者)?より|確認.{0,10}(ご連絡|返信|ご返答)|折り返し/;
  if (n7Regex1.test(bodyLower) && n7Regex2.test(bodyLower)) {
    return { verdict: PRE_FILTER_VERDICT.CLEAR_NOT_BP, reason: 'フォーム自動受付確認', rule: 'N7' };
  }

  // N8: 自社メアドのエコーバック（フォーム自動受付で送信内容が反映される）
  const companyEmails = ['service@finn.co.jp', 'info@finn.co.jp'];
  const n8SubjectPatterns = /お問い?合わ?せ|ありがとう/;
  if (
    companyEmails.some(e => bodyLower.includes(e)) &&
    n8SubjectPatterns.test(subjectLower)
  ) {
    return { verdict: PRE_FILTER_VERDICT.CLEAR_NOT_BP, reason: '自社メアドエコーバック（フォーム自動受付）', rule: 'N8' };
  }

  // --- CLEAR_BP ルール（複数シグナルの AND 条件で保守的に） ---

  // B1: SES 協業キーワード
  const b1Group1 = ['情報交換', '協業', 'パートナー提携', '業務提携'];
  const b1Group2 = ['ses', 'エンジニア', 'it人材', 'web', '開発'];
  if (b1Group1.some(k => subjectLower.includes(k)) && b1Group2.some(k => subjectLower.includes(k))) {
    return { verdict: PRE_FILTER_VERDICT.CLEAR_BP, reason: 'SES協業キーワード一致', rule: 'B1' };
  }

  // B2: 問い合わせ + 面談 + 日程
  const b2SubjectPatterns = ['お問い合わせ', 'hpより', 'ホームページより'];
  const b2BodyMeeting = ['面談', '打ち合わせ'];
  const b2BodySchedule = ['日程', 'スケジュール', 'timerex', 'calendly', 'eeasy'];
  if (
    b2SubjectPatterns.some(k => subjectLower.includes(k)) &&
    b2BodyMeeting.some(k => bodyLower.includes(k)) &&
    b2BodySchedule.some(k => bodyLower.includes(k))
  ) {
    return { verdict: PRE_FILTER_VERDICT.CLEAR_BP, reason: '問い合わせ+面談+日程', rule: 'B2' };
  }

  // B3: スケジュールリンク + 協業文脈
  const b3ScheduleLinks = ['timerex.net', 'calendly.com', 'eeasy.jp'];
  const b3Context = ['協業', 'パートナー', '情報交換', 'ses', 'お問い合わせ'];
  if (
    b3ScheduleLinks.some(k => bodyLower.includes(k)) &&
    b3Context.some(k => bodyLower.includes(k))
  ) {
    return { verdict: PRE_FILTER_VERDICT.CLEAR_BP, reason: 'スケジュールリンク+協業文脈', rule: 'B3' };
  }

  // --- フォールバック ---
  return { verdict: PRE_FILTER_VERDICT.UNCERTAIN, reason: 'ルール該当なし', rule: '' };
}
