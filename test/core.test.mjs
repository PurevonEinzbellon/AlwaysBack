import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { normalizeEvent } from '../src/onebot.mjs';
import { DISCLOSURES, setConsent, setRelationship } from '../src/policy.mjs';
import { App, quietGroupMessage } from '../src/app.mjs';
import { runAnalysis, runProfileAnalysis, reviewProposal } from '../src/analysis.mjs';
import { startOnboarding, finalizeOnboarding, importMarkdownPersona, personaPrompt } from '../src/persona.mjs';
import { Model } from '../src/model.mjs';
import { formatReply } from '../src/reply.mjs';

const config = { ownerQq: '123456789', botQq: '987654321', groupIds: ['55555'], groupCallNames: ['小安'], historyLimit: 10, analysisHourLocal: 3 };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'alwaysback-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new Store(join(dir, 'state.json'), config.ownerQq);
}
function event(overrides = {}) {
  return { post_type: 'message', message_type: 'private', user_id: 123456789,
    self_id: 987654321, sender: { user_id: 123456789, nickname: '原昵称' },
    message_id: 1, message: [{ type: 'text', data: { text: '你好' } }], ...overrides };
}

test('身份只看 QQ ID；昵称、群名片和伪造 sender 不可越权', () => {
  assert.equal(normalizeEvent(event({ user_id: 111111111, sender: { user_id: 111111111, nickname: '原昵称' } }), config), null);
  assert.equal(normalizeEvent(event({ sender: { user_id: 111111111, nickname: '原昵称' } }), config), null);
  assert.equal(normalizeEvent(event({ self_id: 111111111 }), config), null);
  assert.equal(normalizeEvent(event({ sender: { user_id: 123456789, nickname: '新昵称' } }), config)?.sender, '123456789');
  const group = event({ message_type: 'group', group_id: 55555, sender: { user_id: 123456789, card: '别人的昵称' },
    message: [{ type: 'at', data: { qq: '987654321' } }, { type: 'text', data: { text: '你好' } }] });
  assert.equal(normalizeEvent(group, config)?.isGroup, true);
  const otherMember = { ...group, user_id: 111111111, sender: { user_id: 111111111, card: '群成员' } };
  assert.equal(normalizeEvent(otherMember, config)?.sender, '111111111');
  assert.equal(normalizeEvent({ ...otherMember, sender: { user_id: 123456789 } }, config), null);
  assert.equal(normalizeEvent({ ...group, group_id: 55556 }, config), null);
  assert.equal(normalizeEvent({ ...group, message: [{ type: 'text', data: { text: '你好' } }] }, config), null);
  assert.equal(normalizeEvent({ ...otherMember, message: [{ type: 'text', data: { text: '小安，在吗？' } }] }, config)?.sender, '111111111');
  assert.equal(normalizeEvent({ ...otherMember, message: [{ type: 'at', data: { qq: '123456789' } }, { type: 'text', data: { text: '你好' } }] }, config), null);
  assert.equal(normalizeEvent({ ...otherMember, group_id: 55556, message: [{ type: 'text', data: { text: '小安' } }] }, config), null);
  assert.equal(normalizeEvent(event({ user_id: 111111111, sender: { user_id: 111111111 }, message: [{ type: 'text', data: { text: '小安' } }] }), config), null);
});

test('角色卡追问、补全和初始关系各有明确状态', async t => {
  const store = fixture(t);
  const model = { complete: async (_system, _user) => model.answers.shift() };
  model.answers = [{ questions: ['她怎样表达关心？'], missingFields: ['relationshipStyle'], conflicts: [] },
    { name: '小安（模型添加的说明）', background: '虚构世界', personality: '温和', speechStyle: '简短', values: '诚实', boundaries: '不强迫', relationshipStyle: '尊重边界' }];
  const draft = await startOnboarding(store, model, { name: '小安' });
  assert.equal(draft.questions.length, 1);
  assert.deepEqual(draft.missingFields, ['relationshipStyle']);
  assert.equal(store.read().persona.active, null);
  await finalizeOnboarding(store, model, { '她怎样表达关心？': '直接询问' });
  setRelationship(store, 'friend');
  assert.equal(store.read().persona.active.name, '小安');
  assert.equal(store.read().relationship, 'friend');
});

test('两项分析默认关闭且必须显式确认告知', async t => {
  const store = fixture(t);
  assert.deepEqual(store.read().consent, { conversationAnalysis: false, userProfile: false });
  assert.match(DISCLOSURES.userProfile, /称呼/);
  assert.throws(() => setConsent(store, 'userProfile', true), /明确确认/);
  let called = 0;
  const model = { complete: async () => { called++; return { items: [] }; } };
  await assert.rejects(runProfileAnalysis(store, model), /未授权/);
  assert.equal(called, 0);
  setConsent(store, 'userProfile', true, true);
  setConsent(store, 'userProfile', false);
  assert.equal(store.read().consent.userProfile, false);
});

test('私聊可回复并留回执；群聊不带私密上下文；重复事件不重发', async t => {
  const store = fixture(t);
  store.update(state => {
    state.persona.active = { name: '小安' }; state.relationship = 'partner';
    state.messages.push({ role: 'user', content: '秘密', scope: 'private', at: '2026-01-01T00:00:00Z' });
    state.memories.push({ category: 'event', text: '隐私记忆' });
  });
  const calls = [];
  const model = { complete: async (system, user) => { calls.push({ system, user }); return '收到'; } };
  const transport = { send: async () => ({ message_id: 100 }), start() {}, stop() {} };
  const app = new App(config, store, model, transport);
  assert.deepEqual(await app.receive(event()), { accepted: true, sent: true });
  assert.deepEqual(await app.receive(event()), { accepted: false });
  const group = event({ message_type: 'group', group_id: 55555, message_id: 2,
    user_id: 111111111, sender: { user_id: 111111111, card: '群成员' },
    message: [{ type: 'at', data: { qq: '987654321' } }, { type: 'text', data: { text: '今天好吗' } }] });
  assert.deepEqual(await app.receive(group), { accepted: true, sent: true });
  assert.deepEqual(await app.receive(event({ message_id: 3, user_id: 111111111, sender: { user_id: 111111111 } })), { accepted: false });
  assert.deepEqual(await app.receive({ ...group, message_id: 4, message: [{ type: 'text', data: { text: '小安，今天好吗' } }] }), { accepted: true, sent: true });
  assert.equal(calls.length, 3);
  for (const call of calls.slice(1)) assert.doesNotMatch(call.system + call.user, /隐私记忆|秘密|partner/);
  assert.equal(store.read().messages.length, 3);
});

test('普通私聊提供北京时间、星期和距上次消息间隔，保留可信平台时间', async t => {
  const store = fixture(t);
  const now = new Date('2026-10-29T16:05:00.000Z');
  store.update(state => {
    state.persona.active = { name: '小安' }; state.relationship = 'friend';
    state.messages.push({ role: 'assistant', content: '晚安', scope: 'private', at: '2026-10-29T15:35:00.000Z' });
  });
  const calls = [];
  const model = { complete: async (system, user) => { calls.push({ system, user: JSON.parse(user) }); return '现在是周五凌晨。'; } };
  const transport = { send: async () => ({ message_id: 100 }), start() {}, stop() {} };
  const app = new App(config, store, model, transport, () => now);
  await app.receive(event({ time: Math.floor(now.getTime() / 1000) - 60 }));
  assert.match(calls[0].system, /时间依据/);
  assert.deepEqual(calls[0].user.timeContext, {
    timeZone: 'Asia/Shanghai', now: '2026-10-30 00:05', weekday: '星期五',
    nowUtc: now.toISOString(), currentMessageAt: '2026-10-29T16:04:00.000Z', minutesSinceLastMessage: 30
  });
  assert.equal(store.read().messages.at(-2).at, '2026-10-29T16:04:00.000Z');
});

test('分析结果只能成为待审核建议；撤销画像许可后不能批准', async t => {
  const store = fixture(t);
  store.update(state => state.messages.push({ id: 'msg-1', role: 'user', content: '请叫我小王', scope: 'private', at: '2026-01-01T00:00:00Z' }));
  setConsent(store, 'conversationAnalysis', true, true);
  setConsent(store, 'userProfile', true, true);
  const model = { complete: async system => system.includes('对话整理器')
    ? { personaSuggestions: [{ field: 'speechStyle', value: '简短', reason: '用户要求', sourceId: 'msg-1' }], memories: [{ category: 'preference', text: '喜欢简短', sourceId: 'msg-1' }] }
    : { items: [{ category: 'preferredName', text: '小王', sourceId: 'msg-1' }] } };
  const analysis = await runAnalysis(store, model);
  const profile = await runProfileAnalysis(store, model);
  assert.equal(store.read().memories.length, 0);
  assert.equal(store.read().profile.length, 0);
  reviewProposal(store, analysis.find(x => x.type === 'memory').id, 'approve');
  assert.equal(store.read().memories.length, 1);
  setConsent(store, 'userProfile', false);
  assert.throws(() => reviewProposal(store, profile[0].id, 'approve'), /授权已撤销/);
});

test('纯图片和图文消息传给视觉模型；只保存图片标记，读取失败不假装识图', async t => {
  const store = fixture(t);
  store.update(state => { state.persona.active = { name: '小安' }; state.relationship = 'friend'; });
  const imagePath = join(tmpdir(), `alwaysback-image-${process.pid}-${Date.now()}.png`);
  writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lN8AAAAASUVORK5CYII=', 'base64'));
  t.after(() => rmSync(imagePath, { force: true }));
  const inputs = []; const replies = [];
  const model = { complete: async (_system, user) => { inputs.push(user); return '看到了'; } };
  const transport = { call: async () => ({ file: imagePath }), send: async (_message, text) => { replies.push(text); return { message_id: 9 }; }, start() {}, stop() {} };
  const app = new App(config, store, model, transport);
  const image = { type: 'image', data: { file: 'image.png' } };
  assert.deepEqual(await app.receive(event({ message_id: 11, message: [image] })), { accepted: true, sent: true });
  assert.equal(inputs[0][0].type, 'text');
  assert.equal(inputs[0][1].type, 'image_url');
  assert.match(inputs[0][1].image_url.url, /^data:image\/png;base64,/);
  assert.deepEqual(await app.receive(event({ message_id: 12, message: [{ type: 'text', data: { text: '这是什么' } }, image] })), { accepted: true, sent: true });
  assert.match(inputs[1][0].text, /这是什么/);
  assert.match(store.read().messages.at(-4).content, /\[图片×1\]/);
  transport.call = async () => { throw new Error('找不到图片'); };
  assert.deepEqual(await app.receive(event({ message_id: 13, message: [image] })), { accepted: true, sent: true, imageFailed: true });
  assert.equal(inputs.length, 2);
  assert.match(replies.at(-1), /没能读取/);
});

test('Chat Completions 保留图片内容段', async t => {
  const originalFetch = globalThis.fetch;
  let payload;
  globalThis.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '一张图片' } }] }) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const parts = [{ type: 'text', text: '看看' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }];
  const model = new Model({ modelUrl: 'https://example.com/chat/completions', modelName: 'deepseek-flash' });
  assert.equal(await model.complete('系统', parts), '一张图片');
  assert.deepEqual(payload.messages[1].content, parts);
});

test('Markdown 角色卡原文入库，短句按 QQ 消息发送，凌晨群聊按设定静默', async t => {
  const store = fixture(t);
  const source = '# 角色：小安\n\n## 核心原则（最高优先级）\n- 每条不超过 20 字。\n\n## 你是谁\n你是小安。\n\n## 避雷\n- 凌晨 0-6 点群聊装死。';
  const imported = importMarkdownPersona(store, source);
  const active = store.read().persona.active;
  assert.equal(imported.name, '小安');
  assert.match(active.background, /你是小安/);
  assert.match(personaPrompt(active), /原始角色卡/);
  assert.equal(active.sourceText, source);
  setRelationship(store, 'partner');
  const sent = [];
  const model = { complete: async () => '啊\n等下让我想想\n这句话稍微有一点点长但是我会拆开来说给你听！' };
  const transport = { send: async (_message, part) => { sent.push(part); return { message_id: sent.length }; }, start() {}, stop() {} };
  const app = new App(config, store, model, transport);
  await app.receive(event({ message_id: 101 }));
  assert.ok(sent.length >= 3);
  assert.ok(sent.every(part => Array.from(new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(part)).length <= 20));
  assert.equal(store.read().audit.filter(item => item.action === 'message_part_sent').length, sent.length);
  const group = { isGroup: true, mentionCount: 1 };
  assert.equal(quietGroupMessage(group, active, new Date('2026-10-27T17:00:00Z')), true);
  assert.equal(quietGroupMessage({ ...group, mentionCount: 6 }, active, new Date('2026-10-27T17:00:00Z')), false);
  assert.equal(quietGroupMessage(group, active, new Date('2026-10-27T23:00:00Z')), false);
  assert.deepEqual(formatReply('「你好呀」', active.outputStyle).parts, ['你好呀']);
});
