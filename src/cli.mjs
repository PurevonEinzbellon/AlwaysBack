import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from './config.mjs';
import { Store, initialState, audit } from './store.mjs';
import { Model } from './model.mjs';
import { App } from './app.mjs';
import { startOnboarding, finalizeOnboarding, importMarkdownPersona } from './persona.mjs';
import { DISCLOSURES, setConsent, setRelationship } from './policy.mjs';
import { runAnalysis, runProfileAnalysis, reviewProposal } from './analysis.mjs';
import { OneBotClient, normalizeObservation } from './onebot.mjs';
import { proactiveState, settingsForRelationship } from './proactive.mjs';
import { clearObservation, GroupObservation, pruneObservation } from './group-observation.mjs';
import { qq } from './config.mjs';

const [command, subcommand, ...args] = process.argv.slice(2);
const help = `用法（在 Project 目录运行）：
  node src/cli.mjs doctor
  node src/cli.mjs probe onebot|model
  node src/cli.mjs persona start card.json
  node src/cli.mjs persona finalize answers.json
  node src/cli.mjs persona import "C:\\path\\to\\card.md"
  node src/cli.mjs relationship set stranger|friend|partner
  node src/cli.mjs consent show
  node src/cli.mjs consent enable analysis|profile --accept-disclosure
  node src/cli.mjs consent disable analysis|profile
  node src/cli.mjs group-observation status
  node src/cli.mjs group-observation probe-feed
  node src/cli.mjs group-observation enable|disable --accept-disclosure
  node src/cli.mjs group-observation remote-enable|remote-disable --accept-disclosure
  node src/cli.mjs group-observation analyze
  node src/cli.mjs group-observation clear all|GROUP_QQ
  node src/cli.mjs proactive status|enable|disable
  node src/cli.mjs analyze now
  node src/cli.mjs profile now
  node src/cli.mjs proposals list
  node src/cli.mjs proposals approve|reject ID
  node src/cli.mjs erase conversations|analysis|profile|all
  node src/cli.mjs serve`;

function jsonFile(path) { return JSON.parse(readFileSync(resolve(path), 'utf8')); }
function print(value) { console.log(JSON.stringify(value, null, 2)); }

async function main() {
  if (!command || command === 'help') { console.log(help); return; }
  const config = loadConfig();
  const store = new Store(resolve('data/state.json'), config.ownerQq);
  const model = new Model(config);
  if (command === 'doctor') {
    const state = store.read();
    print({ node: process.version, ownerQq: config.ownerQq, botQq: config.botQq,
      onebotUrl: config.onebotUrl, modelUrl: config.modelUrl, modelName: config.modelName,
      personaReady: !!state.persona.active, relationship: state.relationship, consent: state.consent,
      groupPersona: { ...config.groupPersona, active: !!config.groupPersona.publicOwnerRelationship
        && config.groupPersona.forRelationship === state.relationship },
      proactive: proactiveState(state), groupObservation: { enabled: state.groupObservation.enabled,
        remoteAnalysisEnabled: state.groupObservation.remoteAnalysisEnabled,
        excludedGroupIds: config.groupObservation.excludedGroupIds },
      note: '此命令只检查本地配置，不代表已连接 QQ 或模型服务' });
  } else if (command === 'probe' && subcommand === 'onebot') {
    const client = new OneBotClient(config, () => {});
    try {
      client.start();
      await client.waitOpen();
      const login = await client.call('get_login_info', {});
      if (String(login?.user_id) !== config.botQq) throw new Error('OneBot 登录账号与 botQq 不一致');
      print({ connected: true, botQq: config.botQq, nickname: login.nickname ?? null,
        note: '只调用 get_login_info，未发送 QQ 消息' });
    } finally { client.stop(); }
  } else if (command === 'probe' && subcommand === 'model') {
    const answer = await model.complete('你是连通性检查器。只回复 TEST_OK。', 'ping');
    print({ connected: true, response: answer, note: '只发送测试文本 ping，未发送 QQ 或私聊数据' });
  } else if (command === 'persona' && subcommand === 'start' && args[0]) {
    print(await startOnboarding(store, model, jsonFile(args[0])));
  } else if (command === 'persona' && subcommand === 'finalize' && args[0]) {
    print(await finalizeOnboarding(store, model, jsonFile(args[0])));
  } else if (command === 'persona' && subcommand === 'import' && args[0]) {
    print(importMarkdownPersona(store, readFileSync(resolve(args[0]), 'utf8')));
  } else if (command === 'relationship' && subcommand === 'set' && args[0]) {
    setRelationship(store, args[0]); print({ relationship: args[0] });
  } else if (command === 'consent' && subcommand === 'show') {
    const state = store.read();
    print({ current: { ...state.consent, groupObservation: state.groupObservation.enabled,
      groupRemoteAnalysis: state.groupObservation.remoteAnalysisEnabled }, disclosures: DISCLOSURES,
      modelService: { url: config.modelUrl, name: config.modelName } });
  } else if (command === 'consent' && ['enable', 'disable'].includes(subcommand) && args[0]) {
    const kind = ({ analysis: 'conversationAnalysis', profile: 'userProfile' })[args[0]];
    if (!kind) throw new Error('同意类型只能是 analysis/profile');
    const enabled = subcommand === 'enable';
    if (enabled) console.log(DISCLOSURES[kind]);
    setConsent(store, kind, enabled, args.includes('--accept-disclosure'));
    print(store.read().consent);
  } else if (command === 'analyze' && subcommand === 'now') {
    print(await runAnalysis(store, model));
  } else if (command === 'profile' && subcommand === 'now') {
    print(await runProfileAnalysis(store, model));
  } else if (command === 'group-observation' && subcommand === 'status') {
    store.update(state => pruneObservation(state.groupObservation, config.groupObservation));
    const observation = store.read().groupObservation;
    print({ enabled: observation.enabled, remoteAnalysisEnabled: observation.remoteAnalysisEnabled,
      scope: 'OneBot 实际推送的所有已加入群；无法仅凭本地状态证明推送完整',
      excludedGroupIds: config.groupObservation.excludedGroupIds,
      groups: [...new Set(observation.messages.map(item => item.group))],
      bufferedMessages: observation.messages.length,
      thoughts: observation.thoughts.map(({ id, topic, view, question, observedAt, expiresAt, sources, status }) =>
        ({ id, topic, view, question, observedAt, expiresAt, status, sources })),
      dropped: observation.dropped, lastDropReason: observation.lastDropReason,
      lastRoundAt: observation.lastRoundAt, lastSkipReason: observation.lastSkipReason,
      callsToday: observation.callsToday, inputCharsToday: observation.inputCharsToday,
      estimatedTokensToday: observation.estimatedTokensToday });
  } else if (command === 'group-observation' && subcommand === 'probe-feed') {
    const counts = new Map();
    const client = new OneBotClient(config, event => {
      const item = normalizeObservation(event, { ...config, groupObservation: { excludedGroupIds: [] } });
      if (item) counts.set(item.group, (counts.get(item.group) ?? 0) + 1);
    });
    try {
      client.start(); await client.waitOpen();
      const login = await client.call('get_login_info', {});
      if (String(login?.user_id) !== config.botQq) throw new Error('OneBot 登录账号与 botQq 不一致');
      const groups = await client.call('get_group_list', {});
      if (!Array.isArray(groups)) throw new Error('get_group_list 未返回数组');
      await new Promise(resolve => setTimeout(resolve, 20000));
      const joined = groups.map(item => String(item.group_id)).filter(id => /^[1-9]\d{4,14}$/.test(id));
      print({ botQq: config.botQq, joinedGroups: joined, observedMessageCounts: Object.fromEntries(counts),
        durationSeconds: 20, conclusion: joined.every(id => counts.has(id)) && joined.length
          ? '窗口内每个已加入群都有普通消息事件；仅证明本次窗口' : '观察不完整或窗口内没有足够群消息，无法证明全群推送',
        note: '只调用 get_login_info/get_group_list 并被动监听，不读取历史、不保存正文、不发送消息' });
    } finally { client.stop(); }
  } else if (command === 'group-observation' && ['enable', 'disable', 'remote-enable', 'remote-disable'].includes(subcommand)) {
    const remote = subcommand.startsWith('remote-');
    const kind = remote ? 'groupRemoteAnalysis' : 'groupObservation';
    const enabled = subcommand.endsWith('enable');
    if (enabled) console.log(`${DISCLOSURES[kind]} 模型服务：${config.modelUrl} / ${config.modelName}`);
    setConsent(store, kind, enabled, args.includes('--accept-disclosure'));
    print({ enabled: store.read().groupObservation.enabled, remoteAnalysisEnabled: store.read().groupObservation.remoteAnalysisEnabled });
  } else if (command === 'group-observation' && subcommand === 'clear' && args[0]) {
    const group = args[0] === 'all' ? null : qq(args[0]);
    clearObservation(store, group); print({ cleared: group ?? 'all' });
  } else if (command === 'group-observation' && subcommand === 'analyze') {
    print(await new GroupObservation(config.groupObservation, store, model).analyze());
  } else if (command === 'proactive' && subcommand === 'status') {
    const state = store.read();
    print({ ...proactiveState(state), relationship: state.relationship,
      effectiveSettings: settingsForRelationship(config.proactive, state.relationship),
      relationshipProfiles: config.proactive.relationshipProfiles });
  } else if (command === 'proactive' && ['enable', 'disable'].includes(subcommand)) {
    store.update(state => {
      const proactive = state.proactive ??= proactiveState(state);
      proactive.enabled = subcommand === 'enable';
      proactive.nextAt = null;
      proactive.scheduledFor = null;
      if (proactive.enabled && !proactive.lastOwnerAt) {
        proactive.lastOwnerAt = state.messages.filter(item => item.scope === 'private' && item.role === 'user').at(-1)?.at ?? null;
      }
      audit(state, 'proactive_toggle', subcommand);
    });
    print(proactiveState(store.read()));
  } else if (command === 'proposals' && subcommand === 'list') {
    print(store.read().proposals.filter(x => x.status === 'pending'));
  } else if (command === 'proposals' && ['approve', 'reject'].includes(subcommand) && args[0]) {
    reviewProposal(store, args[0], subcommand); print({ id: args[0], decision: subcommand });
  } else if (command === 'erase' && ['conversations', 'analysis', 'profile', 'all'].includes(subcommand)) {
    store.update(state => {
      if (subcommand === 'all') Object.assign(state, initialState(config.ownerQq));
      else if (subcommand === 'conversations') {
        state.messages = [];
        if (state.proactive) { state.proactive.lastOwnerAt = null; state.proactive.nextAt = null; state.proactive.scheduledFor = null; state.proactive.unanswered = 0; state.proactive.attempts = []; }
      }
      else if (subcommand === 'analysis') { state.proposals = state.proposals.filter(x => x.type === 'profile'); state.memories = []; state.lastAnalysisDate = null; state.lastAnalysisDigest = null; }
      else { state.profile = []; state.proposals = state.proposals.filter(x => x.type !== 'profile'); state.lastProfileDate = null; state.lastProfileDigest = null; }
      audit(state, 'erase', subcommand);
    });
    print({ erased: subcommand });
  } else if (command === 'serve') {
    const app = new App(config, store, model);
    app.start();
    console.log('AlwaysBack 运行中');
    process.on('SIGINT', () => { app.stop(); process.exit(0); });
    process.on('SIGTERM', () => { app.stop(); process.exit(0); });
  } else throw new Error(help);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
