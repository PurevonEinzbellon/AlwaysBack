import { createHash, randomUUID } from 'node:crypto';
import { audit } from './store.mjs';

const FIELDS = ['name', 'background', 'personality', 'speechStyle', 'values', 'boundaries', 'relationshipStyle'];

function card(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('角色卡必须是对象');
  const out = {};
  for (const field of FIELDS) {
    const item = value[field];
    out[field] = typeof item === 'string' ? item.trim().slice(0, 2000) : '';
  }
  if (!out.name) throw new Error('角色卡至少需要 name');
  return out;
}

export async function startOnboarding(store, model, input) {
  const basic = card(input);
  const result = await model.complete(
    `你是角色卡整理助手。只使用用户给出的设定，不补造事实。检查字段 ${FIELDS.join(', ')} 的完整度。返回 JSON：{"missingFields":["缺失字段名"],"conflicts":["冲突说明"],"questions":["追问"]}。问题最多 7 条，聚焦会实际影响对话的空白与冲突。`,
    JSON.stringify(basic), { json: true });
  if (!Array.isArray(result.questions) || !Array.isArray(result.missingFields) || !Array.isArray(result.conflicts)) throw new Error('角色卡分析格式无效');
  const draft = { id: randomUUID(), basic, questions: result.questions.filter(x => typeof x === 'string').slice(0, 7),
    missingFields: result.missingFields.filter(x => FIELDS.includes(x)),
    conflicts: result.conflicts.filter(x => typeof x === 'string').slice(0, 10), createdAt: new Date().toISOString() };
  store.update(state => { state.persona.draft = draft; audit(state, 'persona_draft', draft.id); });
  return draft;
}

export async function finalizeOnboarding(store, model, answers) {
  const draft = store.read().persona.draft;
  if (!draft) throw new Error('尚无待完成的角色卡草稿');
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('回答必须是 JSON 对象');
  const result = await model.complete(
    `根据原始角色卡和用户对追问的回答，整理字段 ${FIELDS.join(', ')}。只写有依据的内容，不得根据刻板印象补造。返回 JSON 对象，键名必须为上述字段。`,
    JSON.stringify({ basic: draft.basic, questions: draft.questions, answers }), { json: true });
  const active = card(result);
  // 角色姓名由用户给定；模型只能补全描述，不能改写姓名。
  active.name = draft.basic.name;
  store.update(state => { state.persona.active = active; state.persona.draft = null; state.persona.revision += 1; audit(state, 'persona_finalized', `revision=${state.persona.revision}`); });
  return active;
}

export function personaPrompt(card) {
  const { sourceText, sourceHash, outputStyle, groupQuietHours, ...fields } = card;
  return `你在扮演由用户设定的虚构角色。保持设定一致，不虚构与用户共同经历；遇到不确定的经历可以询问。尊重用户边界，不以依赖、嫉妒或内疚施压。角色资料：\n${JSON.stringify(fields)}`
    + (sourceText ? `\n以下是用户提供的原始角色卡，以此为准，不把示例原样复述给用户：\n${sourceText}` : '');
}

const PUBLIC_SECTIONS = new Set(['核心原则（最高优先级）', '你是谁', '说话风格',
  '聊天习惯（更像真人）', '你常说的话（自然流露，别硬塞）', '反例 → 正例', '避雷', '记住']);

export function publicPersona(card, publicOwnerRelationship = '') {
  const source = card.sourceText ?? '';
  const headings = [...source.matchAll(/^##\s+(.+)$/gm)];
  const selected = headings.flatMap((match, index) => {
    const title = match[1].trim();
    const end = headings[index + 1]?.index ?? source.length;
    if (!PUBLIC_SECTIONS.has(title)) return [];
    return [source.slice(match.index, end).trim()];
  });
  const removeOldTrigger = text => text.replace(/^.*群聊里只回复\s*@你的消息.*$/gm, '').trim();
  if (publicOwnerRelationship) selected.push(`## 与授权用户的公开关系\n${publicOwnerRelationship}`);
  return { name: card.name, background: card.background, personality: card.personality,
    speechStyle: card.speechStyle, boundaries: removeOldTrigger(card.boundaries ?? ''),
    ...(selected.length ? { sourceText: removeOldTrigger(selected.join('\n\n')) } : {}) };
}

export function importMarkdownPersona(store, markdown) {
  if (typeof markdown !== 'string' || !markdown.trim() || markdown.length > 20000) throw new Error('角色卡 Markdown 不能为空或超过 20000 字符');
  const sourceText = markdown.trim();
  const name = sourceText.match(/^#\s*角色[:：]\s*(.+)$/m)?.[1]?.trim();
  if (!name) throw new Error('角色卡需要以“# 角色：名称”开头');
  const sections = new Map();
  for (const match of sourceText.matchAll(/^##\s+(.+)\r?\n([\s\S]*?)(?=^##\s+|$(?![\s\S]))/gm)) sections.set(match[1].trim(), match[2].trim());
  const section = title => sections.get(title) ?? '';
  const identity = section('你是谁');
  const relations = section('人物关系（记忆锚点）');
  const active = {
    name, background: identity.slice(0, 2000), personality: identity.slice(0, 2000),
    speechStyle: [section('核心原则（最高优先级）'), section('说话风格'), section('聊天习惯（更像真人）')].filter(Boolean).join('\n').slice(0, 2000),
    values: relations.slice(0, 2000), boundaries: section('避雷').slice(0, 2000),
    relationshipStyle: relations.slice(0, 2000), sourceText,
    sourceHash: createHash('sha256').update(sourceText).digest('hex')
  };
  if (sourceText.includes('每条不超过 20 字')) active.outputStyle = { splitMessages: true, maxCharsPerMessage: 20, maxMessages: 8 };
  if (sourceText.includes('凌晨 0-6 点群聊装死')) active.groupQuietHours = { timeZone: 'Asia/Shanghai', startHour: 0, endHour: 6, minMentions: 6 };
  store.update(state => {
    state.persona.active = active;
    state.persona.draft = null;
    state.persona.revision += 1;
    audit(state, 'persona_imported', `${active.sourceHash}:revision=${state.persona.revision}`);
  });
  return { name: active.name, revision: store.read().persona.revision, sourceHash: active.sourceHash,
    outputStyle: active.outputStyle ?? null, groupQuietHours: active.groupQuietHours ?? null };
}
