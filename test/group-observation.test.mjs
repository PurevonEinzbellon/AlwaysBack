import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { normalizeObservation } from '../src/onebot.mjs';
import { GroupObservation, activeThoughts, clearObservation } from '../src/group-observation.mjs';
import { setConsent } from '../src/policy.mjs';
import { App } from '../src/app.mjs';
import { Model } from '../src/model.mjs';

const now = new Date('2026-11-01T04:00:00.000Z');
const settings = { excludedGroupIds: [], maxQueue: 16, maxGroups: 10, maxMessagesPerGroup: 10,
  rawTtlHours: 24, thoughtTtlDays: 30, intervalMinutes: 30, maxGroupsPerRound: 2,
  maxMessagesPerGroupPerRound: 2, maxCharsPerRound: 2000, maxCallsPerDay: 2,
  maxInputCharsPerDay: 10000, maxEstimatedTokensPerDay: 12000, maxOutputTokens: 200 };
const config = { botQq: '987654321', ownerQq: '123456789', groupIds: ['111111111'], groupCallNames: [],
  groupObservation: settings, historyLimit: 20, proactive: { relationshipProfiles: {} } };
function event(group, sender, id, text = '今天讨论漫画结局') {
  return { post_type: 'message', message_type: 'group', self_id: config.botQq, group_id: group,
    user_id: sender, sender: { user_id: sender }, message_id: id, time: Math.floor(now.getTime() / 1000),
    message: [{ type: 'text', data: { text } }, { type: 'image', data: { file: 'unread' } }] };
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'alwaysback-observation-'));
  const store = new Store(join(dir, 'state.json'), config.ownerQq);
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('观察归一化校验身份、时间、排除群与媒体边界', () => {
  const valid = normalizeObservation(event('222222222', '333333333', 1), config, now);
  assert.equal(valid.group, '222222222');
  assert.deepEqual(valid.media, ['image']);
  assert.equal(valid.text, '今天讨论漫画结局');
  assert.equal(normalizeObservation({ ...event('222222222', '333333333', 2), sender: { user_id: '444444444' } }, config, now), null);
  assert.equal(normalizeObservation(event('222222222', config.botQq, 3), config, now), null);
  assert.equal(normalizeObservation({ ...event('222222222', '333333333', 4), time: 1 }, config, now), null);
  assert.equal(normalizeObservation(event('222222222', '333333333', 5),
    { ...config, groupObservation: { ...settings, excludedGroupIds: ['222222222'] } }, now), null);
});

test('白名单外普通消息只进入本地观察，重复 ID 不重存且不触发模型或取图', async () => {
  const { store, cleanup } = fixture();
  try {
    setConsent(store, 'groupObservation', true, true);
    let modelCalls = 0; let wireCalls = 0;
    const transport = { call: async () => { wireCalls++; }, send: async () => { wireCalls++; }, stop() {} };
    const model = { complete: async () => { modelCalls++; return 'unexpected'; } };
    const app = new App(config, store, model, transport, () => now);
    assert.deepEqual(await app.receive(event('222222222', '333333333', 1)), { accepted: false });
    await app.receive(event('222222222', '333333333', 1));
    app.observation.flush();
    assert.equal(store.read().groupObservation.messages.length, 1);
    assert.equal(modelCalls, 0); assert.equal(wireCalls, 0);
    assert.equal(store.read().messages.length, 0);
  } finally { cleanup(); }
});

test('批量分析限制群配额、验证来源并在撤销后删除派生想法', async () => {
  const { store, cleanup } = fixture();
  try {
    setConsent(store, 'groupObservation', true, true);
    setConsent(store, 'groupRemoteAnalysis', true, true);
    const inputs = [];
    const model = { completeWithUsage: async (_system, input, options) => {
      inputs.push({ input: JSON.parse(input), options });
      const first = JSON.parse(input).messages[0];
      return { value: { thoughts: [{ topic: '漫画', view: '结局值得再想想', question: '还有其他解读吗', sourceIds: [first.id] }] }, usage: null };
    } };
    const observation = new GroupObservation(settings, store, model, () => now);
    for (let index = 1; index <= 8; index++) observation.receive(normalizeObservation(event('222222222', '333333333', index), config, now));
    observation.receive(normalizeObservation(event('444444444', '555555555', 9), config, now));
    observation.receive(normalizeObservation(event('666666666', '777777777', 10), config, now));
    observation.flush();
    assert.equal((await observation.analyze(now)).status, 'analyzed');
    assert.equal(inputs[0].options.maxTokens, 200);
    assert.equal(new Set(inputs[0].input.messages.map(item => item.group)).size, 2);
    assert.ok(inputs[0].input.messages.length <= 4);
    assert.equal(inputs[0].input.messages[0].media[0], 'image');
    assert.equal(activeThoughts(store.read(), settings, now).length, 1);
    assert.equal((await observation.analyze(new Date(now.getTime() + 31 * 60000))).status, 'analyzed');
    assert.ok(inputs[1].input.messages.some(item => item.group === '666666666'));
    assert.equal((await observation.analyze(new Date(now.getTime() + 62 * 60000))).status, 'daily_calls');
    assert.equal(inputs.length, 2);
    clearObservation(store, '444444444');
    setConsent(store, 'groupRemoteAnalysis', false);
    assert.deepEqual(activeThoughts(store.read(), settings, now), []);
    assert.equal(store.read().groupObservation.thoughts.length, 0);
  } finally { cleanup(); }
});

test('无来源引用的模型想法被拒绝，调用预算仍计入', async () => {
  const { store, cleanup } = fixture();
  try {
    setConsent(store, 'groupObservation', true, true);
    setConsent(store, 'groupRemoteAnalysis', true, true);
    const model = { completeWithUsage: async () => ({ value: { thoughts: [{ topic: '虚构', view: '', question: '', sourceIds: ['not-seen'] }] }, usage: null }) };
    const observation = new GroupObservation(settings, store, model, () => now);
    observation.receive(normalizeObservation(event('222222222', '333333333', 1), config, now));
    assert.equal((await observation.analyze(now)).status, 'invalid_source');
    assert.equal(store.read().groupObservation.callsToday, 1);
    assert.equal(store.read().groupObservation.thoughts.length, 0);
  } finally { cleanup(); }
});

test('短期想法只进入私聊，群回复不见其他群想法，撤销后停止注入', async () => {
  const { store, cleanup } = fixture();
  try {
    store.update(state => { state.persona.active = { name: '小安' }; state.relationship = 'friend'; });
    setConsent(store, 'groupObservation', true, true);
    setConsent(store, 'groupRemoteAnalysis', true, true);
    store.update(state => state.groupObservation.thoughts.push({ id: 'thought-1', topic: '漫画', view: '有不同看法', question: '',
      sources: [{ id: 'source-1', group: '222222222', at: now.toISOString() }],
      observedAt: now.toISOString(), status: 'inferred', expiresAt: new Date(now.getTime() + 86400000).toISOString() }));
    const inputs = [];
    const model = { complete: async (_system, user) => { inputs.push(JSON.parse(user)); return '收到'; } };
    const transport = { call: async () => ({ messages: [] }), send: async () => ({ message_id: 1 }), stop() {} };
    const app = new App(config, store, model, transport, () => now);
    const privateEvent = id => ({ post_type: 'message', message_type: 'private', self_id: config.botQq,
      user_id: config.ownerQq, sender: { user_id: config.ownerQq }, message_id: id,
      time: Math.floor(now.getTime() / 1000), message: [{ type: 'text', data: { text: '你好' } }] });
    await app.receive(privateEvent(1));
    assert.equal(inputs[0].roleThoughts[0].topic, '漫画');
    const groupEvent = event('111111111', '333333333', 2, '小安，今天好吗');
    groupEvent.message = [{ type: 'text', data: { text: '小安，今天好吗' } }, { type: 'at', data: { qq: config.botQq } }];
    await app.receive(groupEvent);
    assert.equal(inputs[1].roleThoughts, undefined);
    assert.doesNotMatch(JSON.stringify(inputs[1]), /漫画|不同看法/);
    setConsent(store, 'groupRemoteAnalysis', false);
    await app.receive(privateEvent(3));
    assert.deepEqual(inputs[2].roleThoughts, []);
    app.observation.flush();
  } finally { cleanup(); }
});

test('模型批量请求设置输出上限并读取用量回执', async () => {
  const original = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"thoughts":[]}' } }],
      usage: { total_tokens: 27, prompt_tokens: 20, completion_tokens: 7 } }) };
  };
  try {
    const model = new Model({ modelUrl: 'http://127.0.0.1:8000/', modelName: 'test', modelApiKey: '' });
    const result = await model.completeWithUsage('system', 'user', { json: true, maxTokens: 120 });
    assert.equal(body.max_tokens, 120);
    assert.equal(result.usage.total_tokens, 27);
    assert.deepEqual(result.value, { thoughts: [] });
  } finally { globalThis.fetch = original; }
});

test('私聊生成中撤销想法后重新生成无想法回复', async () => {
  const { store, cleanup } = fixture();
  try {
    store.update(state => { state.persona.active = { name: '小安' }; state.relationship = 'friend'; });
    setConsent(store, 'groupObservation', true, true);
    setConsent(store, 'groupRemoteAnalysis', true, true);
    store.update(state => state.groupObservation.thoughts.push({ id: 'thought-1', topic: '漫画', view: '', question: '',
      sources: [{ id: 'source-1', group: '222222222', at: now.toISOString() }], observedAt: now.toISOString(),
      status: 'inferred', expiresAt: new Date(now.getTime() + 86400000).toISOString() }));
    const calls = []; const sent = [];
    const model = { complete: async (_system, user) => {
      calls.push(JSON.parse(user));
      if (calls.length === 1) { setConsent(store, 'groupRemoteAnalysis', false); return '过期内容'; }
      return '安全回复';
    } };
    const transport = { send: async (_message, text) => { sent.push(text); return { message_id: 1 }; }, stop() {} };
    const app = new App(config, store, model, transport, () => now);
    const incoming = { post_type: 'message', message_type: 'private', self_id: config.botQq,
      user_id: config.ownerQq, sender: { user_id: config.ownerQq }, message_id: 17,
      time: Math.floor(now.getTime() / 1000), message: [{ type: 'text', data: { text: '你好' } }] };
    assert.equal((await app.receive(incoming)).sent, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].roleThoughts.length, 1);
    assert.deepEqual(calls[1].roleThoughts, []);
    assert.deepEqual(sent, ['安全回复']);
  } finally { cleanup(); }
});
