import { randomUUID } from 'node:crypto';
import { personaPrompt } from './persona.mjs';
import { formatReply } from './reply.mjs';
import { audit } from './store.mjs';
import { TIME_INSTRUCTION, timeContext } from './time-context.mjs';
import { activeThoughts } from './group-observation.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CHAT_AGE_MS = 7 * DAY_MS;
const MISSED_SLOT_MS = 5 * 60 * 1000;
export const DEFAULT_PROACTIVE_SETTINGS = {
  quietStartHour: 23, quietEndHour: 8, maxUnanswered: 2, timeZone: 'Asia/Shanghai',
  relationshipProfiles: {
    stranger: { enabled: false, minIntervalMinutes: 720, maxIntervalMinutes: 1440, minIdleMinutes: 180, maxPer24Hours: 1 },
    friend: { enabled: true, minIntervalMinutes: 240, maxIntervalMinutes: 480, minIdleMinutes: 90, maxPer24Hours: 2 },
    partner: { enabled: true, minIntervalMinutes: 120, maxIntervalMinutes: 240, minIdleMinutes: 60, maxPer24Hours: 3 }
  }
};

export function proactiveState(state) {
  return state.proactive ?? { enabled: false, nextAt: null, scheduledFor: null, lastOwnerAt: null, unanswered: 0, attempts: [] };
}

export function settingsForRelationship(settings, relationship) {
  const { relationshipProfiles: _profiles, ...base } = { ...DEFAULT_PROACTIVE_SETTINGS, ...settings };
  const profile = settings?.relationshipProfiles?.[relationship]
    ?? (relationship === 'partner' && settings?.minIntervalMinutes
      ? { enabled: true, minIntervalMinutes: settings.minIntervalMinutes,
        maxIntervalMinutes: settings.maxIntervalMinutes, minIdleMinutes: settings.minIdleMinutes,
        maxPer24Hours: settings.maxPer24Hours }
      : DEFAULT_PROACTIVE_SETTINGS.relationshipProfiles[relationship]);
  return { ...base, ...profile };
}

function positiveTime(value) {
  const time = Date.parse(value ?? '');
  return Number.isFinite(time) ? time : null;
}

function nextDate(now, minMinutes, maxMinutes, random) {
  const minutes = minMinutes + Math.floor(random() * (maxMinutes - minMinutes + 1));
  return new Date(now + minutes * 60000).toISOString();
}

function hourInZone(time, zone) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: '2-digit', hourCycle: 'h23' }).format(time));
}

export function inQuietHours(time, settings) {
  const hour = hourInZone(time, settings.timeZone);
  const { quietStartHour: start, quietEndHour: end } = settings;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

function afterQuietHours(now, settings, random) {
  let candidate = now;
  for (let index = 0; index < 25; index++) {
    if (!inQuietHours(new Date(candidate), settings)) return nextDate(candidate, 30, 120, random);
    candidate += 60 * 60 * 1000;
  }
  return nextDate(now, settings.minIntervalMinutes, settings.maxIntervalMinutes, random);
}

function latestOwnerAt(state) {
  const stored = positiveTime(proactiveState(state).lastOwnerAt);
  if (stored) return stored;
  const last = state.messages.filter(item => item.scope === 'private' && item.role === 'user').at(-1);
  return positiveTime(last?.at);
}

export class ProactiveService {
  constructor(config, store, model, transport, random = Math.random, clock = () => new Date()) {
    this.config = config;
    this.settings = config.proactive ?? DEFAULT_PROACTIVE_SETTINGS;
    this.store = store;
    this.model = model;
    this.transport = transport;
    this.random = random;
    this.clock = clock;
  }

  noteOwnerMessage(now = new Date()) {
    this.store.update(state => {
      const proactive = state.proactive ??= proactiveState(state);
      const settings = settingsForRelationship(this.settings, state.relationship);
      proactive.lastOwnerAt = now.toISOString();
      proactive.unanswered = 0;
      proactive.nextAt = proactive.enabled && settings.enabled
        ? nextDate(now.getTime(), settings.minIntervalMinutes, settings.maxIntervalMinutes, this.random)
        : null;
      proactive.scheduledFor = proactive.nextAt ? state.relationship : null;
      audit(state, 'proactive_owner_replied');
    });
  }

  async tick(now = new Date(), isStale = () => false) {
    if (isStale()) return { status: 'stale' };
    const nowMs = now.getTime();
    let state = this.store.read();
    let proactive = proactiveState(state);
    if (!proactive.enabled || !state.persona.active || !state.relationship) return { status: 'disabled' };
    const settings = settingsForRelationship(this.settings, state.relationship);
    if (!settings.enabled) {
      if (proactive.nextAt) this.store.update(next => { next.proactive.nextAt = null; next.proactive.scheduledFor = null; audit(next, 'proactive_paused', 'relationship'); });
      return { status: 'relationship_paused' };
    }
    const ownerAt = latestOwnerAt(state);
    if (!ownerAt || nowMs - ownerAt > MAX_CHAT_AGE_MS) {
      if (proactive.nextAt) this.store.update(next => { next.proactive.nextAt = null; audit(next, 'proactive_paused', 'no_recent_private_chat'); });
      return { status: 'no_recent_private_chat' };
    }
    if (proactive.unanswered >= settings.maxUnanswered) {
      if (proactive.nextAt) this.store.update(next => { next.proactive.nextAt = null; audit(next, 'proactive_paused', 'unanswered_limit'); });
      return { status: 'unanswered_limit' };
    }
    const due = positiveTime(proactive.nextAt);
    if (due && proactive.scheduledFor !== state.relationship) {
      this.store.update(next => {
        next.proactive.nextAt = nextDate(nowMs, settings.minIntervalMinutes, settings.maxIntervalMinutes, this.random);
        next.proactive.scheduledFor = state.relationship;
        audit(next, 'proactive_rescheduled', 'relationship_changed');
      });
      return { status: 'relationship_changed' };
    }
    if (!due || nowMs - due > MISSED_SLOT_MS) {
      this.store.update(next => {
        const slot = next.proactive ??= proactiveState(next);
        slot.nextAt = nextDate(nowMs, settings.minIntervalMinutes, settings.maxIntervalMinutes, this.random);
        slot.scheduledFor = state.relationship;
        audit(next, 'proactive_scheduled', due ? 'missed_slot' : 'new_slot');
      });
      return { status: due ? 'missed_slot' : 'scheduled' };
    }
    if (nowMs < due) return { status: 'waiting' };
    if (inQuietHours(now, settings)) {
      this.store.update(next => { next.proactive.nextAt = afterQuietHours(nowMs, settings, this.random); audit(next, 'proactive_deferred', 'quiet_hours'); });
      return { status: 'quiet_hours' };
    }
    if (nowMs - ownerAt < settings.minIdleMinutes * 60000) {
      this.store.update(next => { next.proactive.nextAt = nextDate(ownerAt + settings.minIdleMinutes * 60000, 1, 30, this.random); audit(next, 'proactive_deferred', 'owner_active'); });
      return { status: 'owner_active' };
    }
    const attempts = proactive.attempts.map(positiveTime).filter(time => time && nowMs - time < DAY_MS);
    if (attempts.length >= settings.maxPer24Hours) {
      this.store.update(next => { next.proactive.nextAt = nextDate(Math.min(...attempts) + DAY_MS, 30, 120, this.random); audit(next, 'proactive_deferred', 'daily_limit'); });
      return { status: 'daily_limit' };
    }
    if (attempts.length && nowMs - Math.max(...attempts) < settings.minIntervalMinutes * 60000) {
      this.store.update(next => { next.proactive.nextAt = nextDate(Math.max(...attempts) + settings.minIntervalMinutes * 60000, 1, 60, this.random); audit(next, 'proactive_deferred', 'interval'); });
      return { status: 'interval' };
    }
    // Move the slot before calling the model. A restart must never replay an uncertain send.
    this.store.update(next => { next.proactive.nextAt = nextDate(nowMs, settings.minIntervalMinutes, settings.maxIntervalMinutes, this.random); audit(next, 'proactive_started'); });
    state = this.store.read();
    const history = state.messages.filter(item => item.scope === 'private').slice(-12)
      .map(({ role, content, at }) => ({ role, content, at }));
    const memories = state.memories.slice(-8).map(({ category, text }) => ({ category, text }));
    const profile = state.consent.userProfile ? state.profile.slice(-8).map(({ category, text }) => ({ category, text })) : [];
    const usedThoughtIds = new Set(state.proactive?.usedThoughtIds ?? []);
    const roleThoughts = activeThoughts(state, this.config.groupObservation ?? { excludedGroupIds: [] }, now)
      .filter(item => !usedThoughtIds.has(item.id));
    const system = personaPrompt(state.persona.active) + TIME_INSTRUCTION
      + '\n你正考虑主动给唯一授权用户发一条私聊。保持角色语气，结合真实的近期互动；roleThoughts 仅是角色对群内讨论的短期想法，群内说法未经外部证实，不复述成员昵称、QQ号、群名、原话或私密细节。不要编造刚刚发生的事、现实活动或共同经历，不催回复，不用内疚、依赖或嫉妒施压。若没有自然的开场理由，可以不发送。只返回 JSON：{"send":true|false,"message":"短句"}；发送时 message 尽量不超过 40 字。';
    let proposal;
    try { proposal = await this.model.complete(system, JSON.stringify({ relationship: state.relationship, timeContext: timeContext(now, {
      lastMessageAt: history.at(-1)?.at
    }), history, memories, profile, roleThoughts }), { json: true }); }
    catch (error) { this.store.update(next => audit(next, 'proactive_model_failed', error.message)); throw error; }
    const fresh = this.store.read();
    if (isStale() || !fresh.proactive?.enabled || fresh.relationship !== state.relationship || latestOwnerAt(fresh) !== ownerAt) {
      this.store.update(next => audit(next, 'proactive_skipped', 'new_owner_message_or_disabled'));
      return { status: 'stale' };
    }
    if (roleThoughts.length) {
      const currentThoughts = activeThoughts(fresh, this.config.groupObservation ?? { excludedGroupIds: [] }, this.clock());
      if (roleThoughts.some(item => !currentThoughts.some(current => current.id === item.id))) {
        this.store.update(next => audit(next, 'proactive_skipped', 'group_thought_revoked'));
        return { status: 'group_thought_revoked' };
      }
    }
    if (inQuietHours(this.clock(), settings)) {
      this.store.update(next => { next.proactive.nextAt = afterQuietHours(this.clock().getTime(), settings, this.random); audit(next, 'proactive_deferred', 'quiet_hours_during_generation'); });
      return { status: 'quiet_hours' };
    }
    if (proposal?.send === false) {
      this.store.update(next => audit(next, 'proactive_skipped', 'model_skip'));
      return { status: 'model_skip' };
    }
    if (proposal?.send !== true || typeof proposal.message !== 'string' || !proposal.message.trim()) {
      this.store.update(next => audit(next, 'proactive_model_failed', 'invalid_json'));
      return { status: 'invalid_model_output' };
    }
    const outputStyle = state.persona.active.outputStyle;
    let parts, truncated;
    try {
      ({ parts, truncated } = formatReply(proposal.message.trim(), { splitMessages: true,
        maxCharsPerMessage: outputStyle?.maxCharsPerMessage ?? 40, maxMessages: 3 }));
    } catch (error) {
      this.store.update(next => audit(next, 'proactive_model_failed', error.message));
      throw error;
    }
    const contactId = randomUUID();
    this.store.update(next => {
      next.proactive.attempts = [...next.proactive.attempts.filter(value => {
        const time = positiveTime(value); return time && nowMs - time < DAY_MS;
      }), now.toISOString()];
      next.proactive.unanswered += 1;
      audit(next, 'proactive_send_attempt', contactId);
      if (truncated) audit(next, 'proactive_truncated', contactId);
    });
    let sent = 0;
    try {
      for (const part of parts) {
        const current = this.store.read();
        if (isStale() || !current.proactive?.enabled || current.relationship !== state.relationship || inQuietHours(this.clock(), settings)
          || (roleThoughts.length && roleThoughts.some(item => !activeThoughts(current, this.config.groupObservation ?? { excludedGroupIds: [] }, this.clock()).some(thought => thought.id === item.id)))) break;
        const receipt = await this.transport.sendPrivate(this.config.ownerQq, part);
        sent += 1;
        this.store.update(next => {
          next.proactive.usedThoughtIds = [...new Set([...(next.proactive.usedThoughtIds ?? []), ...roleThoughts.map(item => item.id)])].slice(-100);
          next.messages.push({ id: `proactive:${contactId}:${sent}`, role: 'assistant', content: part, scope: 'private', at: new Date().toISOString() });
          next.messages = next.messages.slice(-this.config.historyLimit * 4);
          audit(next, 'proactive_part_sent', `${contactId}:${sent}/${parts.length}:${receipt?.message_id ?? 'ack'}`);
        });
      }
    } catch (error) {
      this.store.update(next => audit(next, 'proactive_send_failed_or_unknown', `${contactId}:${error.message}`));
      throw error;
    }
    return { status: sent ? 'sent' : 'stale', sentParts: sent };
  }
}
