import { loadConfig } from '../src/config.mjs';
import { OneBotClient } from '../src/onebot.mjs';
import { loadGroupHistory } from '../src/group-context.mjs';

const config = loadConfig();
const groupId = config.groupIds[0];
if (!groupId) throw new Error('未配置群白名单');
const client = new OneBotClient(config, () => {});
try {
  client.start();
  await client.waitOpen();
  const login = await client.call('get_login_info', {});
  const history = await client.call('get_group_msg_history', { group_id: Number(groupId), count: 30 });
  const records = history?.messages ?? [];
  const latest = records.at(-1);
  const groupContext = latest ? await loadGroupHistory(client, {
    group: groupId, self: config.botQq, sender: String(latest.user_id),
    platformMessageId: latest.message_id, seq: latest.message_seq, time: latest.time,
    displayName: latest.sender?.card || latest.sender?.nickname || ''
  }, config.groupHistoryLimit) : null;
  const messages = (history?.messages ?? []).slice(-20).map(item => {
    const segments = Array.isArray(item.message) ? item.message : [];
    return {
      at: Number.isFinite(Number(item.time)) ? new Date(Number(item.time) * 1000).toISOString() : null,
      senderIsBot: String(item.user_id) === config.botQq,
      senderIsOwner: String(item.user_id) === config.ownerQq,
      atBot: segments.some(part => part?.type === 'at' && String(part.data?.qq) === config.botQq),
      types: segments.map(part => part?.type)
    };
  });
  console.log(JSON.stringify({ connected: true, loginMatchesConfig: String(login?.user_id) === config.botQq, groupId,
    historyRecordCount: records.length, latestHasSequence: !!latest?.message_seq,
    latestHasMessageId: !!latest?.message_id, contextCount: groupContext?.items.length ?? 0,
    contextIncludesBot: groupContext?.items.some(item => item.speaker === '机器人') ?? false,
    contextSpeakerCount: new Set(groupContext?.items.map(item => item.speaker) ?? []).size,
    messages }));
} finally { client.stop(); }
