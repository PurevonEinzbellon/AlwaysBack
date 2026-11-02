import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { ProactiveService, inQuietHours, settingsForRelationship } from '../src/proactive.mjs';
import { App } from '../src/app.mjs';
import { setRelationship } from '../src/policy.mjs';

const now = new Date('2026-10-28T04:00:00.000Z');
const settings = { quietStartHour: 23, quietEndHour: 8, maxUnanswered: 2, timeZone: 'Asia/Shanghai',
  relationshipProfiles: {
    stranger: { enabled: false, minIntervalMinutes: 720, maxIntervalMinutes: 1440, minIdleMinutes: 180, maxPer24Hours: 1 },
    friend: { enabled: true, minIntervalMinutes: 240, maxIntervalMinutes: 480, minIdleMinutes: 90, maxPer24Hours: 2 },
    partner: { enabled: true, minIntervalMinutes: 120, maxIntervalMinutes: 240, minIdleMinutes: 60, maxPer24Hours: 3 }
  } };
const config = { ownerQq: '123456789', botQq: '987654321', groupIds: [], groupCallNames: [],
  historyLimit: 20, proactive: settings, analysisHourLocal: 3 };

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'alwaysback-proactive-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'state.json'), config.ownerQq);
  store.update(state => {
    state.persona.active = { name: '小安', personality: '轻松自然', speechStyle: '短句',
      outputStyle: { splitMessages: true, maxCharsPerMessage: 20, maxMessages: 8 } };
    state.relationship = 'partner';
    state.messages.push({ id: 'in:1', scope: 'private', role: 'user', content: '今天去公园了', at: new Date(now.getTime() - 4 * 3600000).toISOString() });
    state.messages.push({ id: 'out:1', scope: 'private', role: 'assistant', content: '好玩吗', at: new Date(now.getTime() - 4 * 3600000 + 1000).toISOString() });
    state.proactive.enabled = true;
    state.proactive.lastOwnerAt = new Date(now.getTime() - 4 * 3600000).toISOString();
    state.proactive.nextAt = new Date(now.getTime() - 60000).toISOString();
    state.proactive.scheduledFor = 'partner';
  });
  return store;
}

test('主动私聊仅发送授权用户，记入历史与预算，未回复达到上限后停发', async t => {
  const store = fixture(t);
  const sends = [];
  const model = { complete: async (system, user, options) => {
    assert.match(system, /小安|轻松自然/);
    assert.equal(options.json, true);
    assert.match(user, /今天去公园了/);
    assert.equal(JSON.parse(user).timeContext.now, '2026-10-28 12:00');
    assert.equal(JSON.parse(user).timeContext.minutesSinceLastMessage, 239);
    return { send: true, message: '今天的公园怎么样？' };
  } };
  const transport = { sendPrivate: async (qq, text) => { sends.push({ qq, text }); return { message_id: sends.length }; } };
  const service = new ProactiveService(config, store, model, transport, () => 0, () => now);
  assert.deepEqual(await service.tick(now), { status: 'sent', sentParts: 1 });
  assert.deepEqual(sends, [{ qq: config.ownerQq, text: '今天的公园怎么样？' }]);
  assert.equal(store.read().messages.at(-1).role, 'assistant');
  assert.equal(store.read().proactive.unanswered, 1);
  assert.equal(store.read().proactive.attempts.length, 1);
  assert.equal((await service.tick(new Date(now.getTime() + 60000))).status, 'waiting');
  store.update(state => { state.proactive.unanswered = 2; state.proactive.nextAt = new Date(now.getTime() + 3600000).toISOString(); });
  assert.equal((await service.tick(new Date(now.getTime() + 3600000))).status, 'unanswered_limit');
  assert.equal(store.read().proactive.nextAt, null);
});

test('免打扰、过期机会与日上限均不会立即发消息', async t => {
  const store = fixture(t);
  const sends = [];
  const service = new ProactiveService(config, store, { complete: async () => ({ send: true, message: '你好' }) },
    { sendPrivate: async (...args) => sends.push(args) }, () => 0, () => now);
  assert.equal(inQuietHours(new Date('2026-10-28T16:00:00Z'), settings), true);
  store.update(state => { state.proactive.nextAt = new Date(now.getTime() - 3600000).toISOString(); });
  assert.equal((await service.tick(now)).status, 'missed_slot');
  store.update(state => { state.proactive.nextAt = new Date('2026-10-28T15:59:00Z').toISOString(); });
  assert.equal((await service.tick(new Date('2026-10-28T16:00:00Z'))).status, 'quiet_hours');
  assert.equal(sends.length, 0);
  store.update(state => {
    state.proactive.nextAt = new Date(now.getTime() - 60000).toISOString();
    state.proactive.attempts = [6, 4, 2].map(hours => new Date(now.getTime() - hours * 3600000).toISOString());
  });
  assert.equal((await service.tick(now)).status, 'daily_limit');
  assert.equal(sends.length, 0);
});

test('生成期间收到私聊或关闭开关时放弃发送；未知回执不重试', async t => {
  const store = fixture(t);
  let stale = false;
  let sends = 0;
  const model = { complete: async () => { stale = true; return { send: true, message: '你好' }; } };
  const service = new ProactiveService(config, store, model, { sendPrivate: async () => { sends += 1; } }, () => 0, () => now);
  assert.equal((await service.tick(now, () => stale)).status, 'stale');
  assert.equal(sends, 0);
  assert.equal(store.read().proactive.attempts.length, 0);
  store.update(state => { state.proactive.nextAt = new Date(now.getTime() - 60000).toISOString(); });
  const disabled = new ProactiveService(config, store, { complete: async () => {
    store.update(state => { state.proactive.enabled = false; });
    return { send: true, message: '你好' };
  } }, { sendPrivate: async () => { sends += 1; } }, () => 0, () => now);
  assert.equal((await disabled.tick(now)).status, 'stale');
  assert.equal(sends, 0);
  store.update(state => { state.proactive.enabled = true; state.proactive.nextAt = new Date(now.getTime() - 60000).toISOString(); });
  const failed = new ProactiveService(config, store, { complete: async () => ({ send: true, message: '你好' }) },
    { sendPrivate: async () => { sends += 1; throw new Error('回执未知'); } }, () => 0, () => now);
  await assert.rejects(failed.tick(now), /回执未知/);
  assert.equal(sends, 1);
  assert.equal(store.read().proactive.attempts.length, 1);
  assert.equal(store.read().proactive.unanswered, 1);
  assert.equal((await failed.tick(new Date(now.getTime() + 60000))).status, 'waiting');
});

test('授权用户回复会清零未回复计数并重新排期', async t => {
  const store = fixture(t);
  store.update(state => { state.proactive.unanswered = 2; state.proactive.nextAt = null; });
  const transport = { send: async () => ({ message_id: 30 }), start() {}, stop() {} };
  const model = { complete: async () => '好呀' };
  const app = new App(config, store, model, transport);
  const event = { post_type: 'message', message_type: 'private', self_id: 987654321,
    user_id: 123456789, sender: { user_id: 123456789 }, message_id: 31,
    message: [{ type: 'text', data: { text: '你好' } }] };
  assert.deepEqual(await app.receive(event), { accepted: true, sent: true });
  assert.equal(store.read().proactive.unanswered, 0);
  assert.ok(Date.parse(store.read().proactive.nextAt) > Date.now());
  store.update(state => { state.proactive.unanswered = 2; state.proactive.nextAt = null; });
  const voice = { ...event, message_id: 32, message: [{ type: 'record', data: { file: 'voice' } }] };
  assert.deepEqual(await app.receive(voice), { accepted: false });
  assert.equal(store.read().proactive.unanswered, 0);
  assert.ok(Date.parse(store.read().proactive.nextAt) > Date.now());
});

test('显式关系决定主动频率，关系切换使旧计划失效', async t => {
  const store = fixture(t);
  const sends = [];
  const service = new ProactiveService(config, store, { complete: async () => ({ send: true, message: '你好' }) },
    { sendPrivate: async (...args) => sends.push(args) }, () => 0, () => now);
  assert.equal(settingsForRelationship(settings, 'partner').minIntervalMinutes, 120);
  assert.equal(settingsForRelationship(settings, 'friend').maxPer24Hours, 2);
  assert.equal(settingsForRelationship(settings, 'stranger').enabled, false);
  setRelationship(store, 'stranger');
  assert.equal(store.read().proactive.nextAt, null);
  assert.equal((await service.tick(now)).status, 'relationship_paused');
  setRelationship(store, 'friend');
  assert.equal((await service.tick(now)).status, 'scheduled');
  assert.equal(Date.parse(store.read().proactive.nextAt) - now.getTime(), 240 * 60000);
  assert.equal(store.read().proactive.scheduledFor, 'friend');
  store.update(state => { state.proactive.nextAt = new Date(now.getTime() - 60000).toISOString();
    state.proactive.attempts = [3, 2].map(hours => new Date(now.getTime() - hours * 3600000).toISOString()); });
  assert.equal((await service.tick(now)).status, 'daily_limit');
  assert.equal(sends.length, 0);
  setRelationship(store, 'partner');
  assert.equal((await service.tick(now)).status, 'scheduled');
  assert.equal(Date.parse(store.read().proactive.nextAt) - now.getTime(), 120 * 60000);
});

test('生成期间关系变化会放弃旧档位的主动消息', async t => {
  const store = fixture(t);
  let sends = 0;
  const service = new ProactiveService(config, store, { complete: async () => {
    setRelationship(store, 'friend');
    return { send: true, message: '你好' };
  } }, { sendPrivate: async () => { sends += 1; } }, () => 0, () => now);
  assert.equal((await service.tick(now)).status, 'stale');
  assert.equal(sends, 0);
  assert.equal(store.read().proactive.attempts.length, 0);
  assert.equal(store.read().proactive.nextAt, null);
});
