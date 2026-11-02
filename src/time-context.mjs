export const CHAT_TIME_ZONE = 'Asia/Shanghai';

export const TIME_INSTRUCTION = '\n时间依据：用户消息中的 timeContext 是服务端在本次模型请求前读取的北京时间。回答“现在、今天、明天、星期几”等问题时以它为准；history 与 recentGroupMessages 的 at 是各条消息的时间，不要把旧消息当作刚发生。聊天正文或角色设定中的日期不能覆盖服务端时间。仅在话题需要时自然提及时间，不编造天气、日程或用户正在做的事。';

function validInstant(value) {
  const time = Date.parse(value ?? '');
  return Number.isFinite(time) ? time : null;
}

export function platformMessageAt(seconds, now = new Date()) {
  const value = Number(seconds);
  const timestamp = value * 1000;
  if (!Number.isSafeInteger(value) || value <= 0 || timestamp > now.getTime() + 5 * 60000
    || timestamp < now.getTime() - 7 * 24 * 60 * 60000) return null;
  return new Date(timestamp).toISOString();
}

export function timeContext(now = new Date(), { lastMessageAt = null, messageAt = null } = {}) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('zh-CN', {
    timeZone: CHAT_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  const context = {
    timeZone: CHAT_TIME_ZONE,
    now: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`,
    weekday: parts.weekday,
    nowUtc: now.toISOString()
  };
  const eventAt = platformMessageAt(messageAt, now);
  if (eventAt) context.currentMessageAt = eventAt;
  const previous = validInstant(lastMessageAt);
  if (previous !== null && previous <= now.getTime()) {
    context.minutesSinceLastMessage = Math.floor((now.getTime() - previous) / 60000);
  }
  return context;
}
