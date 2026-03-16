/**
 * テストランナー + テスト関数
 *
 * GAS エディタから runAllTests() を実行してテストを行う。
 * GAS にはテストフレームワークがないため、シンプルな assert ベースで実装。
 */

/** @type {number} テスト成功数 */
let passCount_ = 0;
/** @type {number} テスト失敗数 */
let failCount_ = 0;

/**
 * テスト用アサーション
 * @param {string} testName - テスト名
 * @param {*} actual - 実際の値
 * @param {*} expected - 期待する値
 */
function assertEqual_(testName, actual, expected) {
  if (actual === expected) {
    console.log(`  ✓ ${testName}`);
    passCount_++;
  } else {
    console.error(`  ✗ ${testName}: expected "${expected}", got "${actual}"`);
    failCount_++;
  }
}

/**
 * 全テスト実行
 */
function runAllTests() {
  passCount_ = 0;
  failCount_ = 0;
  console.log('=== テスト開始 ===\n');

  // Utils テスト
  console.log('[utils.gs]');
  test_normalizeEmail();
  test_truncateText();
  test_stripHtml();
  test_formatDate();

  // Gmail Client テスト
  console.log('\n[gmailClient.gs]');
  test_buildSearchQuery();

  // Classifier テスト
  console.log('\n[classifier.gs]');
  test_buildBPClassificationPrompt();

  // Slack Notifier テスト
  console.log('\n[slackNotifier.gs]');
  test_buildNotificationMessage_empty();
  test_buildNotificationMessage_withEntries();

  // Pre-filter テスト
  console.log('\n[preFilter.gs]');
  test_preFilter_N1_companyDomain();
  test_preFilter_N2_serviceDomain();
  test_preFilter_N3_noreply();
  test_preFilter_N4_autoReply();
  test_preFilter_N5_newsletter();
  test_preFilter_N5_newsletter_withBPKeyword();
  test_preFilter_N6_sales();
  test_preFilter_N6_sales_withBPKeyword();
  test_preFilter_N7_formAutoReply();
  test_preFilter_N4_autoReply_inBody();
  test_preFilter_N7_formAutoReply_variation();
  test_preFilter_N7_partialMatch();
  test_preFilter_N4_autoSend();
  test_preFilter_N7_pastTense();
  test_preFilter_N7_extendedResponder();
  test_preFilter_N8_echoback();
  test_preFilter_N8_noSubjectMatch();
  test_preFilter_B1_sesCooperation();
  test_preFilter_B1_partialMatch();
  test_preFilter_B2_inquiryMeetingSchedule();
  test_preFilter_B2_partialMatch();
  test_preFilter_B3_scheduleLinkWithContext();
  test_preFilter_B3_scheduleLinkWithoutContext();
  test_preFilter_uncertain_fallback();
  test_preFilter_disabled();

  // サマリー
  console.log(`\n=== テスト完了: ${passCount_} passed, ${failCount_} failed ===`);
}

// ==================== Utils テスト ====================

function test_normalizeEmail() {
  assertEqual_('plain email', normalizeEmail('User@Example.COM'), 'user@example.com');
  assertEqual_('with name', normalizeEmail('John Doe <John@Example.com>'), 'john@example.com');
  assertEqual_('with spaces', normalizeEmail('  user@test.com  '), 'user@test.com');
  assertEqual_('empty string', normalizeEmail(''), '');
  assertEqual_('null', normalizeEmail(null), '');
}

function test_truncateText() {
  assertEqual_('short text', truncateText('hello', 10), 'hello');
  assertEqual_('exact length', truncateText('hello', 5), 'hello');
  assertEqual_('truncated', truncateText('hello world', 5), 'hello...');
  assertEqual_('empty', truncateText('', 10), '');
  assertEqual_('null', truncateText(null, 10), '');
}

function test_stripHtml() {
  assertEqual_('br tag', stripHtml('line1<br>line2'), 'line1 line2');
  assertEqual_('p tag', stripHtml('<p>hello</p><p>world</p>'), 'hello world');
  assertEqual_('entities', stripHtml('a&amp;b&lt;c&gt;d'), 'a&b<c>d');
  assertEqual_('empty', stripHtml(''), '');
  assertEqual_('null', stripHtml(null), '');
}

function test_formatDate() {
  // formatDate は Utilities.formatDate を使うため GAS 環境でのみ動作
  const date = new Date('2025-01-15T10:30:00+09:00');
  const result = formatDate(date);
  assertEqual_('format date', result, '2025-01-15 10:30:00');
}

// ==================== Gmail Client テスト ====================

function test_buildSearchQuery() {
  const query = buildSearchQuery_();
  assertEqual_(
    'search query',
    query,
    'label:_filtered/processed -label:_filtered/bp_unreplied -label:_filtered/blocked is:unread newer_than:2d'
  );
}

// ==================== Classifier テスト ====================

function test_buildBPClassificationPrompt() {
  const prompt = buildBPClassificationPrompt('テスト件名', 'テスト本文', 'test@example.com');
  assertEqual_('contains subject', prompt.includes('テスト件名'), true);
  assertEqual_('contains body', prompt.includes('テスト本文'), true);
  assertEqual_('contains from', prompt.includes('test@example.com'), true);
  assertEqual_('contains is_bp', prompt.includes('is_bp'), true);
}

// ==================== Slack Notifier テスト ====================

function test_buildNotificationMessage_empty() {
  const message = buildNotificationMessage([], 30);
  assertEqual_('contains check mark', message.includes(':white_check_mark:'), true);
  assertEqual_('contains count', message.includes('30'), true);
}

function test_buildNotificationMessage_withEntries() {
  const entries = [
    { from: 'User1 <user1@partner.co.jp>', subject: '件名1' },
    { from: 'user2@example.com', subject: '件名2' },
  ];
  const message = buildNotificationMessage(entries, 50);
  assertEqual_('contains alert', message.includes(':rotating_light:'), true);
  assertEqual_('contains count', message.includes('2 件'), true);
  assertEqual_('contains email1', message.includes('user1@partner.co.jp'), true);
  assertEqual_('contains email2', message.includes('user2@example.com'), true);
}

// ==================== Pre-filter テスト ====================

// --- CLEAR_NOT_BP ルール ---

function test_preFilter_N1_companyDomain() {
  const result = preFilterEmail('件名', '本文', 'user@finn.co.jp');
  assertEqual_('N1 verdict', result.verdict, PRE_FILTER_VERDICT.CLEAR_NOT_BP);
  assertEqual_('N1 rule', result.rule, 'N1');
}

function test_preFilter_N2_serviceDomain() {
  const result = preFilterEmail('通知', '本文', 'noreply@github.com');
  assertEqual_('N2 verdict', result.verdict, PRE_FILTER_VERDICT.CLEAR_NOT_BP);
  assertEqual_('N2 rule', result.rule, 'N2');
}

function test_preFilter_N3_noreply() {
  const result = preFilterEmail('お知らせ', '本文', 'noreply@unknown-service.com');
  assertEqual_('N3 verdict', result.verdict, PRE_FILTER_VERDICT.CLEAR_NOT_BP);
  assertEqual_('N3 rule', result.rule, 'N3');
}

function test_preFilter_N4_autoReply() {
  const result = preFilterEmail('Re: 自動返信: 会議について', '本文', 'user@partner.co.jp');
  assertEqual_('N4 verdict', result.verdict, PRE_FILTER_VERDICT.CLEAR_NOT_BP);
  assertEqual_('N4 rule', result.rule, 'N4');
}

function test_preFilter_N5_newsletter() {
  const result = preFilterEmail('最新ニュース', '最新情報をお届けします。配信停止はこちら', 'news@media.co.jp');
  assertEqual_('N5 verdict', result.verdict, PRE_FILTER_VERDICT.CLEAR_NOT_BP);
  assertEqual_('N5 rule', result.rule, 'N5');
}

function test_preFilter_N5_newsletter_withBPKeyword() {
  const result = preFilterEmail('SES最新情報', '協業パートナー向け配信停止はこちら', 'news@media.co.jp');
  assertEqual_('N5 guard: BP keyword present → UNCERTAIN', result.verdict, PRE_FILTER_VERDICT.UNCERTAIN);
}

function test_preFilter_N6_sales() {
  const result = preFilterEmail('セミナーのご案内', '参加をお待ちしています', 'sales@vendor.co.jp');
  assertEqual_('N6 verdict', result.verdict, PRE_FILTER_VERDICT.CLEAR_NOT_BP);
  assertEqual_('N6 rule', result.rule, 'N6');
}

function test_preFilter_N6_sales_withBPKeyword() {
  const result = preFilterEmail('パートナーセミナーのご案内', '本文', 'sales@vendor.co.jp');
  assertEqual_('N6 guard: BP keyword present → UNCERTAIN', result.verdict, PRE_FILTER_VERDICT.UNCERTAIN);
}

function test_preFilter_N7_formAutoReply() {
  const result = preFilterEmail(
    'お問い合わせありがとうございます',
    'この度はお問い合わせありがとうございます。改めて担当者よりご返信させていただきます。',
    'info@example.co.jp'
  );
  assertEqual_('N7 verdict', result.verdict, PRE_FILTER_VERDICT.CLEAR_NOT_BP);
  assertEqual_('N7 rule', result.rule, 'N7');
}

function test_preFilter_N4_autoReply_inBody() {
  const result = preFilterEmail(
    'お問い合わせについて',
    'お問い合わせありがとうございます。※このメールは自動返信されています。',
    'info@example.co.jp'
  );
  assertEqual_('N4 body verdict', result.verdict, PRE_FILTER_VERDICT.CLEAR_NOT_BP);
  assertEqual_('N4 body rule', result.rule, 'N4');
}

function test_preFilter_N7_formAutoReply_variation() {
  const result = preFilterEmail(
    'お問い合わせについて',
    'お問い合わせ頂きましてありがとうございます。担当者よりご連絡いたします。',
    'info@example.co.jp'
  );
  assertEqual_('N7 variation verdict', result.verdict, PRE_FILTER_VERDICT.CLEAR_NOT_BP);
  assertEqual_('N7 variation rule', result.rule, 'N7');
}

function test_preFilter_N7_partialMatch() {
  const result = preFilterEmail(
    'お問い合わせありがとうございます',
    'お問い合わせありがとうございます。内容を確認の上、ご回答いたします。',
    'info@example.co.jp'
  );
  assertEqual_('N7 partial: no group2 → UNCERTAIN', result.verdict, PRE_FILTER_VERDICT.UNCERTAIN);
}

function test_preFilter_N4_autoSend() {
  const result = preFilterEmail(
    'お問い合わせを受け付けました',
    'このメールは自動送信されています。',
    'info@example.co.jp'
  );
  assertEqual_('N4 自動送信 verdict', result.verdict, PRE_FILTER_VERDICT.CLEAR_NOT_BP);
  assertEqual_('N4 自動送信 rule', result.rule, 'N4');
}

function test_preFilter_N7_pastTense() {
  const result = preFilterEmail(
    'お問い合わせについて',
    'お問い合わせ頂き誠にありがとうございました。担当より改めてご連絡いたします。',
    'info@example.co.jp'
  );
  assertEqual_('N7 past tense verdict', result.verdict, PRE_FILTER_VERDICT.CLEAR_NOT_BP);
  assertEqual_('N7 past tense rule', result.rule, 'N7');
}

function test_preFilter_N7_extendedResponder() {
  const result = preFilterEmail(
    'お問い合わせについて',
    'お問い合わせありがとうございます。内容を確認の上、返信させていただきます。',
    'info@example.co.jp'
  );
  assertEqual_('N7 extended responder verdict', result.verdict, PRE_FILTER_VERDICT.CLEAR_NOT_BP);
  assertEqual_('N7 extended responder rule', result.rule, 'N7');
}

function test_preFilter_N8_echoback() {
  const result = preFilterEmail(
    'お問い合わせありがとうございます',
    'お問い合わせ内容:\n会社名: フィン株式会社\nメールアドレス: service@finn.co.jp\nSESエンジニアの協業について相談したい',
    'form@example.co.jp'
  );
  assertEqual_('N8 echoback verdict', result.verdict, PRE_FILTER_VERDICT.CLEAR_NOT_BP);
  assertEqual_('N8 echoback rule', result.rule, 'N8');
}

function test_preFilter_N8_noSubjectMatch() {
  const result = preFilterEmail(
    '普通の件名',
    '本文中に service@finn.co.jp が含まれている',
    'user@example.co.jp'
  );
  assertEqual_('N8 no subject match → not N8', result.rule !== 'N8', true);
}

// --- CLEAR_BP ルール ---

function test_preFilter_B1_sesCooperation() {
  const result = preFilterEmail('SESエンジニアの情報交換について', '本文', 'user@partner.co.jp');
  assertEqual_('B1 verdict', result.verdict, PRE_FILTER_VERDICT.CLEAR_BP);
  assertEqual_('B1 rule', result.rule, 'B1');
}

function test_preFilter_B1_partialMatch() {
  // Group1 のみ → UNCERTAIN
  const result = preFilterEmail('情報交換のお願い', '本文', 'user@partner.co.jp');
  assertEqual_('B1 partial: group1 only → UNCERTAIN', result.verdict, PRE_FILTER_VERDICT.UNCERTAIN);
}

function test_preFilter_B2_inquiryMeetingSchedule() {
  const result = preFilterEmail(
    'HPよりお問い合わせ',
    '面談のお時間をいただけないでしょうか。日程をご確認ください。',
    'user@partner.co.jp'
  );
  assertEqual_('B2 verdict', result.verdict, PRE_FILTER_VERDICT.CLEAR_BP);
  assertEqual_('B2 rule', result.rule, 'B2');
}

function test_preFilter_B2_partialMatch() {
  // 件名一致、本文に面談あるがスケジュールなし → UNCERTAIN
  const result = preFilterEmail(
    'HPよりお問い合わせ',
    '面談のお時間をいただけないでしょうか。',
    'user@partner.co.jp'
  );
  assertEqual_('B2 partial: no schedule → UNCERTAIN', result.verdict, PRE_FILTER_VERDICT.UNCERTAIN);
}

function test_preFilter_B3_scheduleLinkWithContext() {
  const result = preFilterEmail(
    '協業のご相談',
    'SESの情報交換をしたく、こちらからご予約ください https://timerex.net/xxx',
    'user@partner.co.jp'
  );
  assertEqual_('B3 verdict', result.verdict, PRE_FILTER_VERDICT.CLEAR_BP);
  assertEqual_('B3 rule', result.rule, 'B3');
}

function test_preFilter_B3_scheduleLinkWithoutContext() {
  // スケジュールリンクあるが協業文脈なし → UNCERTAIN
  const result = preFilterEmail(
    '打ち合わせ',
    'こちらからご予約ください https://timerex.net/xxx',
    'user@partner.co.jp'
  );
  assertEqual_('B3 no context → UNCERTAIN', result.verdict, PRE_FILTER_VERDICT.UNCERTAIN);
}

// --- フォールバック ---

function test_preFilter_uncertain_fallback() {
  const result = preFilterEmail('普通の件名', '普通の本文', 'user@unknown.co.jp');
  assertEqual_('fallback verdict', result.verdict, PRE_FILTER_VERDICT.UNCERTAIN);
  assertEqual_('fallback rule', result.rule, '');
}

// --- キルスイッチ ---

function test_preFilter_disabled() {
  // PRE_FILTER_ENABLED = false のとき、main.gs ではプリフィルタをスキップする。
  // preFilterEmail 自体はフラグを見ないため、ここでは main.gs の制御をシミュレート。
  const originalEnabled = CONFIG.PRE_FILTER_ENABLED;
  try {
    CONFIG.PRE_FILTER_ENABLED = false;
    // PRE_FILTER_ENABLED が false のとき、main.gs は preFilterEmail を呼ばずに
    // 直接 Gemini に委託する。ここではそのロジックをテスト。
    let classification;
    if (CONFIG.PRE_FILTER_ENABLED) {
      const pf = preFilterEmail('SESエンジニアの情報交換', '本文', 'user@partner.co.jp');
      if (pf.verdict !== PRE_FILTER_VERDICT.UNCERTAIN) {
        classification = { is_bp: pf.verdict === PRE_FILTER_VERDICT.CLEAR_BP };
      }
    }
    assertEqual_('disabled: classification is undefined', classification, undefined);
  } finally {
    CONFIG.PRE_FILTER_ENABLED = originalEnabled;
  }
}
