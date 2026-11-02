import { qq } from './config.mjs';
import { randomUUID } from 'node:crypto';

function textParts(message) {
  if (typeof message === 'string') return message.slice(0, 4000).trim();
  if (!Array.isArray(message)) return '';
  return message.filter(part => part?.type === 'text' && typeof part.data?.text === 'string')
    .map(part => part.data.text).join('').slice(0, 4000).trim();
}

export function isOwnerPrivateEvent(event, config) {
  if (event?.post_type !== 'message' || event.message_type !== 'private') return false;
  try {
    return qq(event.user_id) === config.ownerQq && qq(event.self_id) === config.botQq
      && (event.sender?.user_id === undefined || qq(event.sender.user_id) === config.ownerQq);
  } catch { return false; }
}

export function normalizeEvent(event, config) {
  if (!event || event.post_type !== 'message' || !['private', 'group'].includes(event.message_type)) return null;
  let sender, self, group;
  try {
    sender = qq(event.user_id); self = qq(event.self_id);
    if (event.sender?.user_id !== undefined && qq(event.sender.user_id) !== sender) return null;
    if (event.message_type === 'group') group = qq(event.group_id);
  } catch { return null; }
  const isGroup = event.message_type === 'group';
  if (self !== config.botQq || sender === self || (!isGroup && sender !== config.ownerQq)) return null;
  const text = textParts(event.message);
  let mentioned = false;
  if (isGroup) {
    if (!config.groupIds.includes(group) || !Array.isArray(event.message)) return null;
    mentioned = event.message.some(part => part?.type === 'at' && String(part.data?.qq) === self);
    const calledByName = (config.groupCallNames ?? []).some(name => text.includes(name));
    if (!mentioned && !calledByName) return null;
  }
  const images = Array.isArray(event.message) ? event.message
    .filter(part => part?.type === 'image')
    .map(part => ({ file: part.data?.file, fileSize: part.data?.file_size })) : [];
  if (!text && images.length === 0 && !mentioned) return null;
  const id = event.message_id;
  if (!((typeof id === 'string' && id.length > 0 && id.length <= 80) || Number.isSafeInteger(id))) return null;
  const mentionCount = isGroup ? event.message.filter(part => part?.type === 'at' && String(part.data?.qq) === self).length : 0;
  const seq = Number.isSafeInteger(Number(event.message_seq)) && Number(event.message_seq) > 0 ? Number(event.message_seq) : null;
  const time = Number.isSafeInteger(Number(event.time)) && Number(event.time) > 0 ? Number(event.time) : null;
  const displayName = isGroup && typeof (event.sender?.card || event.sender?.nickname) === 'string'
    ? (event.sender.card || event.sender.nickname).replace(/[\r\n\u0000-\u001f]/g, ' ').trim().slice(0, 24) : '';
  return { id: `${self}:${isGroup ? group : 'private'}:${id}`, platformMessageId: id,
    sender, self, group, isGroup, text, images, mentionCount, mentioned, seq, time, displayName,
    replyTo: isGroup ? event.message.find(part => part?.type === 'reply')?.data?.id ?? null : null };
}

export function normalizeObservation(event, config, now = new Date()) {
  if (event?.post_type !== 'message' || event.message_type !== 'group' || !Array.isArray(event.message)) return null;
  let self, group, sender;
  try {
    self = qq(event.self_id); group = qq(event.group_id); sender = qq(event.user_id);
    if (event.sender?.user_id !== undefined && qq(event.sender.user_id) !== sender) return null;
  } catch { return null; }
  if (self !== config.botQq || sender === self || config.groupObservation?.excludedGroupIds?.includes(group)) return null;
  const id = event.message_id;
  if (!((typeof id === 'string' && id.length > 0 && id.length <= 80) || Number.isSafeInteger(id))) return null;
  const seconds = Number(event.time);
  const at = seconds * 1000;
  if (!Number.isSafeInteger(seconds) || at > now.getTime() + 5 * 60000 || at < now.getTime() - 24 * 3600000) return null;
  const text = event.message.filter(part => part?.type === 'text' && typeof part.data?.text === 'string')
    .map(part => part.data.text).join(' ').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 500);
  const media = [...new Set(event.message.filter(part => ['image', 'record', 'video', 'file'].includes(part?.type)).map(part => part.type))];
  if (!text || /^[/!#！][^\s]{1,40}(?:\s|$)/.test(text) || /^[\p{Emoji_Presentation}\s]+$/u.test(text)) return null;
  return { id: `${self}:${group}:${id}`, group, sender, at: new Date(at).toISOString(), text, media };
}

export class OneBotClient {
  constructor(config, onEvent) {
    this.config = config; this.onEvent = onEvent; this.pending = new Map(); this.stopped = false; this.delay = 1000;
  }

  start() { this.#connect(); }
  stop() { this.stopped = true; clearTimeout(this.retry); this.ws?.close(); }

  waitOpen(timeoutMs = 5000) {
    const ws = this.ws;
    if (!ws) throw new Error('OneBot 尚未开始连接');
    if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer);
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('close', onClose);
        error ? reject(error) : resolve();
      };
      const onOpen = () => finish();
      const onClose = () => finish(new Error('OneBot 连接在就绪前关闭'));
      const timer = setTimeout(() => finish(new Error('OneBot 连接超时')), timeoutMs);
      ws.addEventListener('open', onOpen, { once: true });
      ws.addEventListener('close', onClose, { once: true });
    });
  }

  #connect() {
    if (this.stopped) return;
    const headers = this.config.onebotToken ? { Authorization: `Bearer ${this.config.onebotToken}` } : {};
    const ws = new WebSocket(this.config.onebotUrl, { headers });
    this.ws = ws;
    ws.addEventListener('open', () => { this.delay = 1000; console.log('OneBot 已连接'); });
    ws.addEventListener('message', event => {
      let payload;
      try { payload = JSON.parse(String(event.data)); } catch { return; }
      if (payload.echo && this.pending.has(payload.echo)) {
        const task = this.pending.get(payload.echo); this.pending.delete(payload.echo); clearTimeout(task.timer);
        payload.status === 'ok' && payload.retcode === 0 ? task.resolve(payload.data) : task.reject(new Error(`OneBot ${payload.retcode}: ${payload.wording ?? payload.msg ?? '发送失败'}`));
      } else if (payload.post_type) Promise.resolve(this.onEvent(payload)).catch(error => console.error('消息处理失败:', error.message));
    });
    const lost = () => {
      if (this.ws !== ws) return;
      for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(new Error('OneBot 连接中断，发送结果未知')); }
      this.pending.clear(); this.ws = null;
      if (!this.stopped) { this.retry = setTimeout(() => this.#connect(), this.delay); this.delay = Math.min(this.delay * 2, 30000); }
    };
    ws.addEventListener('close', lost);
    ws.addEventListener('error', () => {});
  }

  call(action, params) {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error('OneBot 未连接');
    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(echo); reject(new Error('OneBot 回执超时，结果未知')); }, 15000);
      this.pending.set(echo, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ action, params, echo })); }
      catch (error) { clearTimeout(timer); this.pending.delete(echo); reject(error); }
    });
  }

  send(message, text) {
    return message.isGroup
      ? this.call('send_group_msg', { group_id: Number(message.group), message: text })
      : this.sendPrivate(message.sender, text);
  }
  sendPrivate(userId, text) { return this.call('send_private_msg', { user_id: Number(userId), message: text }); }
}
