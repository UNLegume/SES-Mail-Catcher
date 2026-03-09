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
    'label:_filtered/processed -label:_filtered/bp_unreplied -label:_filtered/blocked newer_than:7d'
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
