import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGroupHistory } from '../src/group-context.mjs';
import { publicPersona } from '../src/persona.mjs';
import { Store } from '../src/store.mjs';
import { App } from '../src/app.mjs';
import { normalizeEvent } from '../src/onebot.mjs';
import { loadConfig } from '../src/config.mjs';

const now = 1793156400;
const current = { group: '55555', self: '987654321', sender: '111111111', displayName: '阿明',
  platformMessageId: 100, seq: 100, time: now };
const history = [
  { group_id: 55555, message_id: 95, message_seq: 95, time: now - 60,
    user_id: 111111111, sender: { card: '阿明' }, message: [{ type: 'text', data: { text: '明天去哪' } }] },
  { group_id: 55555, message_id: 96, message_seq: 96, time: now - 45,
    user_id: 222222222, sender: { nickname: '小陈' }, message: [{ type: 'text', data: { text: '去公园吧' } }, { type: 'image', data: { file: 'private-url' } }] },
  { group_id: 55555, message_id: 97, message_seq: 97, time: now - 30,
    user_id: 987654321, sender: { nickname: '小安' }, message: [{ type: 'text', data: { text: '好呀' } }] },
  { group_id: 55555, message_id: 100, message_seq: 100, time: now,
    user_id: 111111111, message: [{ type: 'text', data: { text: '当前消息不能重复' } }] },
  { group_id: 55555, message_id: 101, message_seq: 101, time: now + 1,
    user_id: 222222222, message: [{ type: 'text', data: { text: '未来消息不能提前看到' } }] },
  { group_id: 66666, message_id: 94, message_seq: 94, time: now - 20,
    user_id: 333333333, message: [{ type: 'text', data: { text: '其他群秘密' } }] },
  { group_id: 55555, message_id: 1, message_seq: 1, time: now - 13 * 3600,
    user_id: 333333333, message: [{ type: 'text', data: { text: '过期消息' } }] }
];

test('群聊历史按群、时间、序号隔离，保留说话者和机器人回复，媒体只留占位', () => {
  const result = buildGroupHistory(history, current, 20);
  assert.equal(result.items.length, 3);
  assert.deepEqual(result.items.map(item => item.text), ['明天去哪', '去公园吧 [图片]', '好呀']);
  assert.equal(result.items[0].speaker, result.currentSpeaker);
  assert.equal(result.items[2].speaker, '机器人');
  assert.equal(result.items[0].displayName, '阿明');
  assert.doesNotMatch(JSON.stringify(result), /private-url|当前消息|未来消息|其他群秘密|过期消息|111111111/);
});

test('群聊引用可关联窗口内的消息，仅 @ 机器人也能进入对话', () => {
  const records = history.map(item => item.message_id === 97
    ? { ...item, message: [{ type: 'reply', data: { id: 96 } }, ...item.message] }
    : item);
  const result = buildGroupHistory(records, { ...current, replyTo: 97 });
  assert.equal(result.items[2].replyToTurn, 2);
  assert.equal(result.currentReplyToTurn, 3);
  assert.equal(result.items[2].text, '[引用消息] 好呀');
  const event = { post_type: 'message', message_type: 'group', group_id: 55555,
    self_id: 987654321, user_id: 111111111, sender: { user_id: 111111111 },
    message_id: 100, message_seq: 100, time: now,
    message: [{ type: 'at', data: { qq: '987654321' } }] };
  const normalized = normalizeEvent(event, { botQq: '987654321', ownerQq: '123456789',
    groupIds: ['55555'], groupCallNames: ['小安'] });
  assert.equal(normalized?.mentioned, true);
  assert.equal(normalized?.text, '');
});

test('群聊人格包含公开关系与原文示例，不带私聊原文和 QQ 号', () => {
  const active = { name: '小安', background: '18 岁学生兼魔法少女', personality: '天真烂漫',
    speechStyle: '短句', boundaries: '- 群聊里只回复 @你的消息，别自言自语。\n- 不讲道理',
    values: '阿舟 876543210 是恋人', relationshipStyle: '喜欢阿舟',
    sourceText: '# 角色：小安\n## 核心原则（最高优先级）\n每条不超过 20 字。\n## 你是谁\n天真烂漫。\n## 人物关系（记忆锚点）\n- 最喜欢的人：阿舟，QQ 号 876543210。\n  私聊时会格外亲近。\n- 朋友甲 / 朋友乙：又爱又恨的姐妹。\n## 避雷\n- 群聊里只回复 @你的消息，别自言自语。\n- 不讲道理\n## 记住\n像手机聊天。' };
  const publicCard = publicPersona(active, '阿舟是小安最喜欢的人。');
  assert.match(publicCard.sourceText, /天真烂漫|像手机聊天/);
  assert.match(publicCard.sourceText, /阿舟是小安最喜欢的人/);
  assert.match(publicCard.personality, /天真烂漫/);
  assert.doesNotMatch(JSON.stringify(publicCard), /876543210|朋友甲 \/ 朋友乙|私聊时会格外亲近|只回复 @你的消息/);
});

test('公开关系配置必须绑定显式关系且不得包含 QQ 号', t => {
  const dir = mkdtempSync(join(tmpdir(), 'alwaysback-public-relationship-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  const config = { ownerQq: '123456789', botQq: '987654321', onebotUrl: 'ws://127.0.0.1:3001/',
    modelUrl: 'http://127.0.0.1:8000/', modelName: 'test',
    groupPersona: { publicOwnerRelationship: '阿舟是小安最喜欢的人。' } };
  writeFileSync(path, JSON.stringify(config));
  assert.throws(() => loadConfig(path), /forRelationship/);
  config.groupPersona.forRelationship = 'partner';
  config.groupPersona.publicOwnerRelationship += ' QQ 号 123456789';
  writeFileSync(path, JSON.stringify(config));
  assert.throws(() => loadConfig(path), /不含 QQ 号/);
  config.groupPersona.publicOwnerRelationship = '阿舟是小安最喜欢的人。';
  writeFileSync(path, JSON.stringify(config));
  assert.equal(loadConfig(path).groupPersona.forRelationship, 'partner');
});

test('应用将群聊历史送入模型，读取失败时明确标记缺失且不混入私聊', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'alwaysback-group-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = { ownerQq: '123456789', botQq: '987654321', groupIds: ['55555'], groupCallNames: ['小安'],
    groupPersona: { publicOwnerRelationship: '阿舟是小安最喜欢的人。', forRelationship: 'partner' },
    historyLimit: 10, groupHistoryLimit: 20, analysisHourLocal: 3 };
  const store = new Store(join(dir, 'state.json'), config.ownerQq);
  store.update(state => {
    state.persona.active = { name: '小安', background: '魔法少女', personality: '天真烂漫', speechStyle: '短句',
      boundaries: '不讲道理', values: '阿舟 876543210', relationshipStyle: '恋人', sourceText: '## 你是谁\n天真烂漫\n## 人物关系（记忆锚点）\n阿舟 876543210' };
    state.relationship = 'partner';
    state.messages.push({ role: 'user', content: '私聊秘密', scope: 'private' });
    state.memories.push({ category: 'private', text: '私密记忆' });
  });
  const calls = [];
  const model = { complete: async (system, user) => { calls.push({ system, user: JSON.parse(user) }); return '好呀'; } };
  const transport = { call: async () => ({ messages: history }), send: async () => ({ message_id: 7 }), start() {}, stop() {} };
  const requestTime = new Date(now * 1000 + 90000);
  const app = new App(config, store, model, transport, () => requestTime);
  const event = id => ({ post_type: 'message', message_type: 'group', group_id: 55555, self_id: 987654321,
    user_id: 111111111, sender: { user_id: 111111111, card: '阿明' }, message_id: id,
    message_seq: id, time: now, message: [{ type: 'text', data: { text: '小安，公园怎么样？' } }] });
  assert.deepEqual(await app.receive(event(100)), { accepted: true, sent: true });
  assert.equal(calls[0].user.groupHistoryAvailable, true);
  assert.equal(calls[0].user.recentGroupMessages.length, 3);
  assert.equal(calls[0].user.currentSpeaker, calls[0].user.recentGroupMessages[0].speaker);
  assert.equal(calls[0].user.timeContext.nowUtc, requestTime.toISOString());
  assert.equal(calls[0].user.timeContext.currentMessageAt, new Date(now * 1000).toISOString());
  assert.equal(calls[0].user.timeContext.minutesSinceLastMessage, 2);
  assert.match(calls[0].system, /天真烂漫/);
  assert.match(calls[0].system, /阿舟是小安最喜欢的人/);
  assert.doesNotMatch(JSON.stringify(calls[0]), /私聊秘密|私密记忆|876543210/);
  assert.equal(store.read().messages.length, 1);
  transport.call = async () => { throw new Error('历史不可用'); };
  store.update(state => { state.relationship = 'friend'; });
  assert.deepEqual(await app.receive(event(102)), { accepted: true, sent: true });
  assert.doesNotMatch(calls[1].system, /阿舟/);
  assert.equal(calls[1].user.groupHistoryAvailable, false);
  assert.equal(calls[1].user.recentGroupMessages.length, 0);
  assert.equal(store.read().audit.some(item => item.action === 'group_context_failed'), true);
});
