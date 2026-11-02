import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function qq(value) {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof id !== 'string' || !/^[1-9]\d{4,14}$/.test(id)) throw new Error('QQ 号必须是 5 至 15 位正整数');
  return id;
}

export function loadConfig(path = resolve('config.json')) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const url = new URL(raw.onebotUrl);
  if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('onebotUrl 必须是 ws/wss 地址');
  const modelUrl = new URL(raw.modelUrl);
  if (!['http:', 'https:'].includes(modelUrl.protocol)) throw new Error('modelUrl 必须是 http/https 地址');
  const loopback = host => ['localhost', '127.0.0.1', '[::1]'].includes(host);
  if (url.protocol === 'ws:' && !loopback(url.hostname)) throw new Error('远程 OneBot 地址必须使用 wss');
  if (modelUrl.protocol === 'http:' && !loopback(modelUrl.hostname)) throw new Error('远程模型地址必须使用 https');
  const groupIds = (raw.groupIds ?? []).map(qq);
  if (!Array.isArray(raw.groupCallNames ?? []) || (raw.groupCallNames ?? []).length > 10) throw new Error('groupCallNames 必须是最多 10 项的数组');
  const groupCallNames = (raw.groupCallNames ?? []).map(name => {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 32) throw new Error('群聊点名词必须是 1 至 32 字符的字符串');
    return name.trim();
  });
  if (typeof raw.modelName !== 'string' || !raw.modelName.trim()) throw new Error('modelName 不能为空');
  const proactive = raw.proactive ?? {};
  const number = (value, fallback, min, max) => Number.isInteger(value) && value >= min && value <= max ? value : fallback;
  const minIntervalMinutes = number(proactive.minIntervalMinutes, 120, 30, 1440);
  const partnerDefaults = { enabled: true, minIntervalMinutes,
    maxIntervalMinutes: number(proactive.maxIntervalMinutes, Math.max(240, minIntervalMinutes), minIntervalMinutes, 2880),
    minIdleMinutes: number(proactive.minIdleMinutes, 60, 15, 1440),
    maxPer24Hours: number(proactive.maxPer24Hours, 3, 1, 10) };
  const profile = (source, fallback) => {
    const min = number(source?.minIntervalMinutes, fallback.minIntervalMinutes, 30, 1440);
    return { enabled: typeof source?.enabled === 'boolean' ? source.enabled : fallback.enabled,
      minIntervalMinutes: min,
      maxIntervalMinutes: number(source?.maxIntervalMinutes, Math.max(fallback.maxIntervalMinutes, min), min, 2880),
      minIdleMinutes: number(source?.minIdleMinutes, fallback.minIdleMinutes, 15, 1440),
      maxPer24Hours: number(source?.maxPer24Hours, fallback.maxPer24Hours, 1, 10) };
  };
  const profiles = proactive.relationshipProfiles ?? {};
  const observation = raw.groupObservation ?? {};
  if (typeof observation !== 'object' || Array.isArray(observation)) throw new Error('groupObservation 必须是对象');
  if (!Array.isArray(observation.excludedGroupIds ?? [])) throw new Error('excludedGroupIds 必须是数组');
  const excludedGroupIds = (observation.excludedGroupIds ?? []).map(qq);
  const groupPersona = raw.groupPersona ?? {};
  if (typeof groupPersona !== 'object' || Array.isArray(groupPersona)) throw new Error('groupPersona 必须是对象');
  const publicOwnerRelationship = groupPersona.publicOwnerRelationship ?? '';
  if (typeof publicOwnerRelationship !== 'string' || publicOwnerRelationship.length > 300
    || /[\u0000-\u001f]|[1-9]\d{4,14}|QQ\s*号/i.test(publicOwnerRelationship)) {
    throw new Error('groupPersona.publicOwnerRelationship 必须是不含 QQ 号、控制字符且不超过 300 字的文本');
  }
  if (publicOwnerRelationship.trim() && !['stranger', 'friend', 'partner'].includes(groupPersona.forRelationship)) {
    throw new Error('公开关系须指定 groupPersona.forRelationship');
  }
  return {
    ownerQq: qq(raw.ownerQq), botQq: qq(raw.botQq),
    onebotUrl: url.toString(), groupIds, groupCallNames,
    groupPersona: { publicOwnerRelationship: publicOwnerRelationship.trim(), forRelationship: groupPersona.forRelationship ?? null },
    modelUrl: modelUrl.toString(), modelName: String(raw.modelName ?? ''),
    analysisHourLocal: Number.isInteger(raw.analysisHourLocal) && raw.analysisHourLocal >= 0 && raw.analysisHourLocal <= 23 ? raw.analysisHourLocal : 3,
    groupObservation: {
      excludedGroupIds,
      maxQueue: number(observation.maxQueue, 256, 16, 4096),
      maxGroups: number(observation.maxGroups, 100, 1, 1000),
      maxMessagesPerGroup: number(observation.maxMessagesPerGroup, 100, 10, 500),
      rawTtlHours: number(observation.rawTtlHours, 24, 1, 24),
      thoughtTtlDays: number(observation.thoughtTtlDays, 30, 1, 30),
      intervalMinutes: number(observation.intervalMinutes, 30, 30, 60),
      maxGroupsPerRound: number(observation.maxGroupsPerRound, 4, 1, 20),
      maxMessagesPerGroupPerRound: number(observation.maxMessagesPerGroupPerRound, 5, 1, 20),
      maxCharsPerRound: number(observation.maxCharsPerRound, 6000, 500, 30000),
      maxCallsPerDay: number(observation.maxCallsPerDay, 12, 1, 48),
      maxInputCharsPerDay: number(observation.maxInputCharsPerDay, 50000, 1000, 300000),
      maxEstimatedTokensPerDay: number(observation.maxEstimatedTokensPerDay, 60000, 2000, 500000),
      maxOutputTokens: number(observation.maxOutputTokens, 500, 100, 2000)
    },
    historyLimit: Number.isInteger(raw.historyLimit) && raw.historyLimit >= 2 && raw.historyLimit <= 50 ? raw.historyLimit : 20,
    groupHistoryLimit: Number.isInteger(raw.groupHistoryLimit) && raw.groupHistoryLimit >= 1 && raw.groupHistoryLimit <= 40 ? raw.groupHistoryLimit : 24,
    proactive: {
      quietStartHour: number(proactive.quietStartHour, 23, 0, 23),
      quietEndHour: number(proactive.quietEndHour, 8, 0, 23),
      maxUnanswered: number(proactive.maxUnanswered, 2, 1, 10),
      timeZone: 'Asia/Shanghai',
      relationshipProfiles: {
        stranger: profile(profiles.stranger, { enabled: false, minIntervalMinutes: 720, maxIntervalMinutes: 1440, minIdleMinutes: 180, maxPer24Hours: 1 }),
        friend: profile(profiles.friend, { enabled: true, minIntervalMinutes: 240, maxIntervalMinutes: 480, minIdleMinutes: 90, maxPer24Hours: 2 }),
        partner: profile(profiles.partner, partnerDefaults)
      }
    },
    onebotToken: process.env.ALWAYSBACK_ONEBOT_TOKEN ?? '',
    modelApiKey: process.env.ALWAYSBACK_MODEL_API_KEY ?? ''
  };
}
