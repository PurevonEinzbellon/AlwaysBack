const MAX_FETCH = 80;
const MAX_TEXT_PER_MESSAGE = 320;
const MAX_HISTORY_CHARS = 6000;
const MAX_AGE_SECONDS = 12 * 60 * 60;

function integer(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function messageText(parts, labelFor, botQq) {
  if (!Array.isArray(parts)) return '';
  const pieces = [];
  for (const part of parts) {
    const data = part?.data ?? {};
    if (part?.type === 'text' && typeof data.text === 'string') pieces.push(data.text);
    else if (part?.type === 'at') pieces.push(String(data.qq) === botQq ? ' [@机器人] ' : data.qq === 'all' ? ' [@全体] ' : ` [@${labelFor(String(data.qq ?? ''))}] `);
    else if (part?.type === 'image') pieces.push(' [图片] ');
    else if (part?.type === 'record') pieces.push(' [语音] ');
    else if (part?.type === 'video') pieces.push(' [视频] ');
    else if (part?.type === 'file') pieces.push(' [文件] ');
    else if (part?.type === 'reply') pieces.push(' [引用消息] ');
    else if (part?.type === 'face') pieces.push(' [表情] ');
    else if (part?.type === 'json') pieces.push(' [卡片] ');
  }
  return pieces.join('').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_PER_MESSAGE);
}

function displayName(sender) {
  const value = sender?.card || sender?.nickname;
  return typeof value === 'string' ? value.replace(/[\r\n\u0000-\u001f]/g, ' ').trim().slice(0, 24) : '';
}

export function buildGroupHistory(records, current, limit = 24) {
  if (!Array.isArray(records)) throw new Error('群聊历史格式无效');
  const currentTime = integer(current.time) ?? Math.floor(Date.now() / 1000);
  const currentSeq = integer(current.seq);
  const selected = records.filter(item => {
    if (!item || String(item.group_id) !== current.group) return false;
    if (String(item.message_id) === String(current.platformMessageId)) return false;
    const time = integer(item.time);
    if (!time || time > currentTime || currentTime - time > MAX_AGE_SECONDS) return false;
    const seq = integer(item.message_seq);
    if (currentSeq && seq) return seq < currentSeq;
    return time < currentTime;
  }).sort((a, b) => Number(a.time) - Number(b.time) || (integer(a.message_seq) ?? 0) - (integer(b.message_seq) ?? 0));
  const labels = new Map();
  const labelFor = sender => {
    if (sender === current.self) return '机器人';
    if (!/^\d{5,15}$/.test(sender)) return '未知成员';
    if (!labels.has(sender)) labels.set(sender, `成员${labels.size + 1}`);
    return labels.get(sender);
  };
  const entries = [];
  for (const item of selected) {
    const sender = String(item.user_id ?? '');
    const text = messageText(item.message, labelFor, current.self);
    if (!text) continue;
    entries.push({ speaker: labelFor(sender), displayName: displayName(item.sender),
      at: new Date(Number(item.time) * 1000).toISOString(), text,
      id: String(item.message_id ?? ''), replyTo: item.message?.find?.(part => part?.type === 'reply')?.data?.id });
  }
  const result = [];
  let used = 0;
  for (const item of entries.slice(-MAX_FETCH).reverse()) {
    const size = item.text.length + item.speaker.length + item.at.length;
    if (result.length >= limit || used + size > MAX_HISTORY_CHARS) break;
    result.push(item); used += size;
  }
  result.reverse();
  const turns = new Map(result.map((item, index) => [item.id, index + 1]));
  const items = result.map(({ id, replyTo, ...item }, index) => ({ turn: index + 1, ...item,
    ...(turns.has(String(replyTo)) ? { replyToTurn: turns.get(String(replyTo)) } : {}) }));
  return { items, currentSpeaker: labelFor(current.sender), currentDisplayName: current.displayName ?? '',
    ...(turns.has(String(current.replyTo)) ? { currentReplyToTurn: turns.get(String(current.replyTo)) } : {}) };
}

export async function loadGroupHistory(transport, current, limit = 24) {
  const params = { group_id: Number(current.group), count: Math.min(MAX_FETCH, Math.max(30, limit * 3)) };
  if (current.seq) params.message_seq = current.seq;
  const data = await transport.call('get_group_msg_history', params);
  if (!Array.isArray(data?.messages)) throw new Error('OneBot 未返回群聊历史');
  return buildGroupHistory(data.messages, current, limit);
}
