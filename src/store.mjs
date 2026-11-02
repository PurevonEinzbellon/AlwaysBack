import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function initialState(ownerQq) {
  return {
    schemaVersion: 1, ownerQq, persona: { draft: null, active: null, revision: 0 },
    relationship: null,
    consent: { conversationAnalysis: false, userProfile: false },
    groupObservation: { enabled: false, remoteAnalysisEnabled: false, revision: 0, messages: [], thoughts: [], consumedIds: [],
      dropped: 0, lastDropReason: null, lastRoundAt: null, usageDay: null, callsToday: 0,
      inputCharsToday: 0, estimatedTokensToday: 0, lastSkipReason: null },
    messages: [], memories: [], profile: [], proposals: [],
    proactive: { enabled: false, nextAt: null, scheduledFor: null, lastOwnerAt: null, unanswered: 0, attempts: [] },
    processedIds: [], lastAnalysisDate: null, lastProfileDate: null,
    lastAnalysisDigest: null, lastProfileDigest: null, audit: []
  };
}

export class Store {
  constructor(path, ownerQq) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) this.#withLock(() => { if (!existsSync(path)) this.#save(initialState(ownerQq)); });
    const state = this.read();
    if (state.schemaVersion !== 1 || state.ownerQq !== ownerQq) throw new Error('数据版本或 ownerQq 与配置不一致');
    if (!state.groupObservation) this.update(next => { next.groupObservation = initialState(ownerQq).groupObservation; });
  }

  read() { return JSON.parse(readFileSync(this.path, 'utf8')); }

  update(mutator) {
    return this.#withLock(() => {
      const state = this.read();
      const result = mutator(state);
      this.#save(state);
      return result;
    });
  }

  #withLock(action) {
    const lockPath = `${this.path}.lock`;
    let handle;
    for (let attempt = 0; attempt < 200; attempt++) {
      try { handle = openSync(lockPath, 'wx'); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    if (handle === undefined) throw new Error(`数据文件被占用；若此前进程异常退出，请确认无服务运行后移除 ${lockPath}`);
    try { return action(); }
    finally { closeSync(handle); unlinkSync(lockPath); }
  }

  #save(state) {
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { renameSync(temp, this.path); return; }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 40) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  }
}

export function audit(state, action, detail = '') {
  state.audit.push({ at: new Date().toISOString(), action, detail });
  state.audit = state.audit.slice(-300);
}
