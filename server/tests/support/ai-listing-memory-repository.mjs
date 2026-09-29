import {aiListingWorkPhase} from '../../ai-listing-repository.mjs';
const copy = (value) => structuredClone(value);
const runnable = new Set(["QUEUED", "COLLECTING", "GENERATING", "READY_TO_SUBMIT", "SUBMITTING", "SUBMITTED"]);
// Test-owned durable-boundary double: copies records, enforces scope/CAS/leases.
export function memoryRepository() {
  const rows = new Map();
  let queuePosition = 0;
  return {
    rows,
    async create(task) {
      const existing = [...rows.values()].find((row) => row.accountId === task.accountId && row.dedupeKey === task.dedupeKey);
      if (existing) return copy(existing);
      const row = { ...copy(task), version: 1, queuePosition: ++queuePosition, leaseToken: null, leaseExpiresAt: null };
      rows.set(row.id, row); return copy(row);
    },
    async createBatch(tasks) {
      const first=tasks[0], existing=[...rows.values()].find(row=>row.accountId===first.accountId && row.importBatchId===first.importBatchId);
      if(existing && existing.importRequestHash!==first.importRequestHash) throw Object.assign(new Error('Conflict'),{code:'AI_LISTING_IDEMPOTENCY_CONFLICT'});
      return Promise.all(tasks.map(task=>this.create(task)));
    },
    async finalizeImportBatch({accountId,importBatchId,now,merge}) {
      const batch=[...rows.values()].filter(row=>row.accountId===accountId && row.importBatchId===importBatchId).map(copy);
      if(batch.some(row=>!row.importGrouped && runnable.has(row.status) && (!row.source || (row.leaseToken && row.leaseExpiresAt>now))))return;
      for(const row of merge(batch)) rows.set(row.id,{...copy(row),version:row.version+1});
    },
    async get({ accountId, taskId }) { const row = rows.get(taskId); return row?.accountId === accountId ? copy(row) : null; },
    async getMany({ accountId, taskIds }) { return taskIds.map(id => rows.get(id)).filter(row => row?.accountId === accountId).map(copy); },
    async list({ accountId }) { return [...rows.values()].filter((row) => row.accountId === accountId && !row.deletedAt).map(copy); },
    async listActionCandidates({accountId,group}) {
      return [...rows.values()].filter(row => row.accountId===accountId).filter(row => {
        const value = row.deletedAt?'deleted':row.status==='PAUSED'?'paused':row.status==='CANCELLED'?'cancelled':row.status==='SUBMISSION_FAILED'?'failed'
          :['COLLECTION_FAILED','GENERATION_FAILED','UPLOAD_FAILED','SUBMISSION_UNCERTAIN'].includes(row.status)?'errors':'active';
        return row.status!=='COMPLETED' && value===group;
      }).map(copy);
    },
    async requestControl({task,action,expectedVersion,now}) {
      const row=rows.get(task.id);
      if(row?.accountId!==task.accountId || row.version!==expectedVersion || row.controlAction || row.deletedAt)return null;
      if(row.leaseToken && row.leaseExpiresAt>now){row.controlAction=action;return copy(row);}
      return this.save({task,expectedVersion,now});
    },
    async restoreDeleted({task,expectedVersion,now}) {
      const row=rows.get(task.id);
      if(row?.accountId!==task.accountId||row.version!==expectedVersion||!row.deletedAt||row.controlAction
        ||row.leaseToken&&row.leaseExpiresAt>now)return null;
      return this.save({task,expectedVersion,now});
    },
    async leaseState({accountId,taskId,leaseToken,expectedVersion,now}) {
      const row=rows.get(taskId);
      return {owned:row?.accountId===accountId && row.leaseToken===leaseToken && row.version===expectedVersion && row.leaseExpiresAt>now,controlAction:row?.controlAction};
    },
    async claimNext({ now, leaseMs, leaseToken, phase = "all" }) {
      const ownsPhase=row=>{
        const base=aiListingWorkPhase(row);
        if(phase==='all')return true;
        const media=base==='finalize'&&row.status!=='SUBMITTED'&&(row.status!=='SUBMITTING'||row.submissionStage==='preparing_media')&&row.submissionStage!=='prepared';
        return phase==='media'?media:base===phase&&(phase!=='finalize'||!media);
      };
      const row = [...rows.values()].sort((a,b)=>a.queuePosition-b.queuePosition).find((row) => !row.deletedAt && runnable.has(row.status) && ownsPhase(row) && row.nextRunAt <= now
        && (!row.leaseToken || row.leaseExpiresAt <= now));
      if (!row) return null;
      Object.assign(row, { leaseToken, leaseExpiresAt: now + leaseMs, version: row.version + 1 });
      return copy(row);
    },
    async renewLease({ accountId, taskId, leaseToken, now, leaseMs }) {
      const row = rows.get(taskId);
      if (row?.accountId !== accountId || row.leaseToken !== leaseToken || row.leaseExpiresAt <= now) return false;
      row.leaseExpiresAt = now + leaseMs; return true;
    },
    async save({ task, expectedVersion, leaseToken, now, releaseLease = true, requeue = false, finishControl = null, guardControl = false }) {
      const row = rows.get(task.id);
      if (row?.accountId !== task.accountId || row.version !== expectedVersion
        || (leaseToken && (row.leaseToken !== leaseToken || row.leaseExpiresAt <= now))
        || (finishControl && row.controlAction!==finishControl) || (guardControl && row.controlAction)) return null;
      releaseLease=releaseLease && (!row.controlAction || Boolean(finishControl));
      const updated = { ...copy(task), version: row.version + 1,
        controlAction:finishControl?null:row.controlAction,queuePosition:requeue?++queuePosition:row.queuePosition,
        leaseToken: releaseLease ? null : row.leaseToken, leaseExpiresAt: releaseLease ? null : row.leaseExpiresAt };
      rows.set(row.id, updated); return copy(updated);
    },
    async saveProgress({accountId,taskId,expectedVersion,leaseToken,now,patch}) {
      const row=rows.get(taskId);
      if(row?.accountId!==accountId||row.version!==expectedVersion||row.leaseToken!==leaseToken||row.leaseExpiresAt<=now||row.deletedAt)return null;
      Object.assign(row,copy(patch));row.version++;
      return {version:row.version,controlAction:row.controlAction};
    },
  };
}
