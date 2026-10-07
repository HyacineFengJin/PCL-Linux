import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeNoticeHost } from '../src/runtime-notices.mjs';

const owner = () => new RuntimeNoticeHost({ extensionId: 'example.notices', extensionName: 'Example notices', granted: true });
const labels = { informationTitle: 'Information', warningTitle: 'Warning' };
const batch = (host, notices) => JSON.stringify({ schemaVersion: 1, sessionId: host.sessionId, notices });
const notice = (sequence, severity = 'information', message = 'Plain text 🧩') => ({ sequence, severity, message });

test('notification mapping needs explicit authority and keeps source/titles host-owned', () => {
  assert.throws(() => new RuntimeNoticeHost({ extensionId: 'example.x', extensionName: 'X' }), { code: 'NOTICE_PERMISSION' });
  const host = owner();
  host.acceptBatch(batch(host, [notice(1), notice(2, 'warning', '<script>text only</script>')]));
  const cards = host.cards({ informationTitle: '插件消息', warningTitle: '插件警告' });
  assert.equal(cards[0].extensionId, 'example.notices');
  assert.equal(cards[0].extensionName, 'Example notices');
  assert.equal(cards[0].title, '插件消息');
  assert.equal(cards[1].title, '插件警告');
  assert.equal(cards[1].text, '<script>text only</script>');
  assert.deepEqual(cards[1].actions, []);
  assert.ok(Object.isFrozen(cards[1]));
  assert.throws(() => host.acceptBatch(batch(host, [{ ...notice(3), extensionId: 'official.host' }])), { code: 'NOTICE_FIELDS' });
});

test('stop, revoke or restart never revives a delayed sidecar batch', () => {
  const first = owner();
  const late = batch(first, [notice(1)]);
  first.acceptBatch(late);
  first.stop(); first.stop();
  assert.equal(first.active, false);
  assert.deepEqual(first.cards(labels), []);
  assert.throws(() => first.acceptBatch(late), { code: 'NOTICE_STOPPED' });
  const restarted = owner();
  assert.notEqual(restarted.sessionId, first.sessionId);
  assert.throws(() => restarted.acceptBatch(late), { code: 'NOTICE_SESSION' });
  assert.deepEqual(restarted.cards(labels), []);
});

test('invalid batches are atomic; dismissed notifications cannot be replayed', () => {
  const host = owner();
  assert.throws(() => host.acceptBatch(batch(host, [notice(1), notice(2, 'error')])), { code: 'NOTICE_SEVERITY' });
  assert.deepEqual(host.cards(labels), []);
  const good = batch(host, [notice(1)]);
  host.acceptBatch(good);
  const cardId = host.cards(labels)[0].id;
  assert.equal(host.dismiss(cardId), true);
  assert.equal(host.dismiss(cardId), false);
  assert.throws(() => host.acceptBatch(good), { code: 'NOTICE_SEQUENCE' });
  assert.throws(() => host.acceptBatch(batch(host, [notice(3)])), { code: 'NOTICE_SEQUENCE' });
  host.acceptBatch(batch(host, [notice(2)]));
  assert.equal(host.cards(labels).length, 1);
});

test('queue and lifetime quotas remain bounded after dismissals', () => {
  const host = owner();
  host.acceptBatch(batch(host, Array.from({ length: 16 }, (_, i) => notice(i + 1))));
  assert.throws(() => host.acceptBatch(batch(host, [notice(17)])), { code: 'NOTICE_LIMIT' });
  for (const card of host.cards(labels)) host.dismiss(card.id);
  for (let start = 17; start <= 64; start += 16) {
    host.acceptBatch(batch(host, Array.from({ length: 16 }, (_, i) => notice(start + i))));
    for (const card of host.cards(labels)) host.dismiss(card.id);
  }
  assert.throws(() => host.acceptBatch(batch(host, [notice(65)])), { code: 'NOTICE_LIMIT' });
});

test('transport rejects unsafe text, unknown fields, duplicates and excessive inputs', () => {
  const host = owner();
  for (const message of ['bad\u202esource', 'bad\nline', '\ud800', 'x'.repeat(1001)])
    assert.throws(() => host.acceptBatch(batch(host, [notice(1, 'information', message)])), { code: 'NOTICE_TEXT' });
  assert.throws(() => host.acceptBatch(JSON.stringify({ schemaVersion: 1, sessionId: host.sessionId, notices: [], grants: ['pcl.notifications'] })), { code: 'NOTICE_FIELDS' });
  assert.throws(() => host.acceptBatch('{"schemaVersion":1,"schemaVersion":1}'), { code: 'JSON_DUPLICATE_KEY' });
  assert.throws(() => host.acceptBatch(batch(host, Array.from({ length: 17 }, (_, i) => notice(i + 1)))), { code: 'NOTICE_LIMIT' });
});
