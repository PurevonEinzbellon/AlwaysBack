import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { audit } from './store.mjs';

function recentPrivate(state) {
  return state.messages.filter(x => x.scope === 'private').slice(-40)
    .map(({ id, role, content, at }) => ({ id, role, content, at }));
}

function digest(messages) { return createHash('sha256').update(JSON.stringify(messages)).digest('hex'); }

export async function runAnalysis(store, model) {
  const state = store.read();
  if (!state.consent.conversationAnalysis) throw new Error('对话分析未授权');
  const messages = recentPrivate(state);
  if (!messages.length) return [];
  const currentDigest = digest(messages);
  if (state.lastAnalysisDigest === currentDigest) return [];
  const result = await model.complete(
    '你是对话整理器。返回 JSON：{"personaSuggestions":[{"field":"personality|speechStyle|values|boundaries|relationshipStyle","value":"建议文本","reason":"依据","sourceId":"原消息 id"}],"memories":[{"category":"preference|event|promise|boundary|relationship","text":"事实或待确认描述","sourceId":"原消息 id"}]}。只根据输入证据提出建议，不自动改写人设；不得诊断用户或推断其心理缺陷。每类最多 5 条。',
    JSON.stringify(messages), { json: true });
  if (!Array.isArray(result.personaSuggestions) || !Array.isArray(result.memories)) throw new Error('对话分析格式无效');
  const proposals = [];
  for (const item of result.personaSuggestions.slice(0, 5)) {
    if (!['personality', 'speechStyle', 'values', 'boundaries', 'relationshipStyle'].includes(item?.field) || typeof item.value !== 'string' || !item.value.trim()) continue;
    const source = messages.find(m => m.id === item.sourceId && m.role === 'user');
    if (!source) continue;
    proposals.push({ id: randomUUID(), type: 'persona', field: item.field, value: item.value.slice(0, 1000), reason: String(item.reason ?? '').slice(0, 500), sourceId: source.id, sourceAt: source.at, sourceExcerpt: source.content.slice(0, 500), status: 'pending', createdAt: new Date().toISOString() });
  }
  for (const item of result.memories.slice(0, 5)) {
    if (!['preference', 'event', 'promise', 'boundary', 'relationship'].includes(item?.category) || typeof item.text !== 'string' || !item.text.trim()) continue;
    const source = messages.find(m => m.id === item.sourceId);
    if (!source) continue;
    proposals.push({ id: randomUUID(), type: 'memory', category: item.category, text: item.text.slice(0, 1000), sourceId: source.id, sourceAt: source.at, sourceExcerpt: source.content.slice(0, 500), status: 'pending', createdAt: new Date().toISOString() });
  }
  store.update(next => { if (!next.consent.conversationAnalysis) throw new Error('授权已撤销'); next.proposals.push(...proposals); next.lastAnalysisDigest = currentDigest; audit(next, 'analysis_proposed', String(proposals.length)); });
  return proposals;
}

export async function runProfileAnalysis(store, model) {
  const state = store.read();
  if (!state.consent.userProfile) throw new Error('用户画像未授权');
  const messages = recentPrivate(state);
  if (!messages.length) return [];
  const currentDigest = digest(messages);
  if (state.lastProfileDigest === currentDigest) return [];
  const result = await model.complete(
    '仅提取用户明确表达的信息。返回 JSON：{"items":[{"category":"preferredName|communication|interest|boundary|support","text":"用户明确说过的内容","sourceId":"原消息 id"}]}。不得做心理诊断、推断心理缺失/脆弱性、预测可被说服的方式，不能把模型猜测写成事实。最多 8 条。',
    JSON.stringify(messages), { json: true });
  if (!Array.isArray(result.items)) throw new Error('用户画像格式无效');
  const proposals = result.items.slice(0, 8).flatMap(item => {
    if (!['preferredName', 'communication', 'interest', 'boundary', 'support'].includes(item?.category) || typeof item.text !== 'string' || !item.text.trim()) return [];
    const source = messages.find(m => m.id === item.sourceId && m.role === 'user');
    if (!source) return [];
    return [{ id: randomUUID(), type: 'profile', category: item.category, text: item.text.slice(0, 1000), sourceId: source.id, sourceAt: source.at, sourceExcerpt: source.content.slice(0, 500), status: 'pending', createdAt: new Date().toISOString() }];
  });
  store.update(next => { if (!next.consent.userProfile) throw new Error('授权已撤销'); next.proposals.push(...proposals); next.lastProfileDigest = currentDigest; audit(next, 'profile_proposed', String(proposals.length)); });
  return proposals;
}

export function reviewProposal(store, id, decision) {
  if (!['approve', 'reject'].includes(decision)) throw new Error('审核结果必须为 approve/reject');
  store.update(state => {
    const proposal = state.proposals.find(x => x.id === id);
    if (!proposal || proposal.status !== 'pending') throw new Error('找不到待审核建议');
    if (decision === 'approve') {
      if (proposal.type === 'persona') {
        if (!state.persona.active) throw new Error('尚未完成角色卡');
        state.persona.active[proposal.field] = proposal.value; state.persona.revision += 1;
      }
      if (proposal.type === 'memory' && !state.memories.some(x => x.category === proposal.category && x.text === proposal.text)) state.memories.push({ ...proposal, status: 'active', approvedAt: new Date().toISOString() });
      if (proposal.type === 'profile') {
        if (!state.consent.userProfile) throw new Error('用户画像授权已撤销');
        if (!state.profile.some(x => x.category === proposal.category && x.text === proposal.text)) state.profile.push({ ...proposal, status: 'active', approvedAt: new Date().toISOString() });
      }
    }
    proposal.status = decision === 'approve' ? 'approved' : 'rejected';
    audit(state, 'proposal_review', `${id}:${decision}`);
  });
}
