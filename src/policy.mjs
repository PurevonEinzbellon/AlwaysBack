import { audit } from './store.mjs';

export const DISCLOSURES = {
  conversationAnalysis: '开启后，系统会定时将近期对话正文发送至所配置的模型服务，用于提出角色卡微调建议、提取待审核记忆并对长期记忆分类。建议默认不生效；关闭后停止新增分析。模型服务可能按其政策处理收到的内容。',
  userProfile: '数据来源：本机保存的近期私聊正文。分析范围：用户明确表达的称呼、沟通偏好、兴趣、相处边界和希望得到的支持方式。用途：经人工审核后，调整私聊中的称呼、语气、话题选择与边界遵守；不用于群聊、广告、评分、心理诊断或针对脆弱性的劝诱。处理方式：正文发送至所配置的模型服务，服务方可能按其政策处理收到的内容；候选画像及来源时间保存在本机，人工批准后才参与生成。默认关闭；关闭后停止新分析且旧画像不再注入，可用 erase profile 删除。',
  groupObservation: '开启后，本机接收机器人已加入的所有群中协议端实际推送的普通群消息，可在 config.json 的 excludedGroupIds 排除群。仅保存截短文字、媒体类型及来源 ID，最多保留 24 小时；不下载媒体，不主动补采历史，不触发群回复。可用 group-observation clear 删除。开启本地观察不授权远端分析。',
  groupRemoteAnalysis: '独立授权后，系统才会批量把所有已加入且未排除群中筛选后的文字正文、媒体类型占位、群号、消息 ID 和时间发送至 config.json 的 modelUrl/modelName 模型服务。服务方可能按其政策处理；本地原始缓冲最多保留 24 小时，短期想法最多 30 天，可用 group-observation clear 删除。关闭后停止新外传并清理派生想法；群讨论不是已证实的现实事实。'
};

export function setConsent(store, kind, enabled, acknowledged = false) {
  if (!(kind in DISCLOSURES)) throw new Error('未知同意类型');
  if (enabled && !acknowledged) throw new Error(`需明确确认告知内容：${DISCLOSURES[kind]}`);
  store.update(state => {
    if (kind === 'groupObservation') {
      state.groupObservation.revision++;
      state.groupObservation.enabled = enabled;
      if (!enabled) { state.groupObservation.remoteAnalysisEnabled = false; state.groupObservation.messages = []; state.groupObservation.thoughts = []; state.groupObservation.consumedIds = []; }
    } else if (kind === 'groupRemoteAnalysis') {
      if (enabled && !state.groupObservation.enabled) throw new Error('先启用本地群观察');
      state.groupObservation.revision++;
      state.groupObservation.remoteAnalysisEnabled = enabled;
      if (!enabled) state.groupObservation.thoughts = [];
      else { state.groupObservation.messages = []; state.groupObservation.consumedIds = []; }
    } else state.consent[kind] = enabled;
    audit(state, 'consent', `${kind}=${enabled}`);
  });
}

export function setRelationship(store, value) {
  if (!['stranger', 'friend', 'partner'].includes(value)) throw new Error('初始关系只能是 stranger/friend/partner');
  store.update(state => {
    if (state.relationship !== value && state.proactive) {
      state.proactive.nextAt = null;
      state.proactive.scheduledFor = null;
      audit(state, 'proactive_rescheduled', 'relationship_changed');
    }
    state.relationship = value;
    audit(state, 'relationship', value);
  });
}
