import { parseJson, fail, freeze } from './json.mjs';

export const RUNTIME_CARD_SCHEMA_VERSION = 1;
export const WORKFLOWS = freeze(['maker','porter']);
export const JOB_STATES = freeze(['queued','running','completed','cancelled','failed','interrupted']);
export const ARTIFACT_STATES = freeze(['none','draft_ready','review_blocked']);
export const BLOCKED_REASONS = freeze(['build_execution_disabled','live_model_calls_disabled','review_required','runtime_error']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z(?![\s\S])/;

function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(key=>!Object.hasOwn(value,key)))
    fail('RUNTIME_SUMMARY_FIELDS','Runtime summaries must contain only the explicitly allowed status fields.');
}

/** Validate only a pre-sanitized host projection. Never pass a raw job here. */
export function readRuntimeSummaries(source) {
  if (typeof source !== 'string' || new TextEncoder().encode(source).length > 8192)
    fail('RUNTIME_SUMMARY_SIZE','At most two status summaries may occupy 8 KiB.');
  const envelope=parseJson(source);
  object(envelope,['schemaVersion','summaries']);
  if(envelope.schemaVersion!==1 || !Array.isArray(envelope.summaries) || envelope.summaries.length>2)
    fail('RUNTIME_SUMMARY_FORMAT','Expected runtime-card summary schema 1 with at most two jobs.');
  const profiles=new Set(),ids=new Set();
  for(const s of envelope.summaries) {
    object(s,['schemaVersion','jobId','revision','workflow','status','artifactState','blockedReason','verificationState','updatedAt']);
    if(s.schemaVersion!==1 || typeof s.jobId!=='string' || !UUID.test(s.jobId) ||
        !Number.isSafeInteger(s.revision) || s.revision<0 || !WORKFLOWS.includes(s.workflow) ||
        !JOB_STATES.includes(s.status) || !ARTIFACT_STATES.includes(s.artifactState) ||
        !(s.blockedReason===null || BLOCKED_REASONS.includes(s.blockedReason)) || s.verificationState!=='not_run')
      fail('RUNTIME_SUMMARY_VALUE','A runtime summary contains an unsupported state or verification claim.');
    if(typeof s.updatedAt!=='string' || !ISO.test(s.updatedAt) || !Number.isFinite(Date.parse(s.updatedAt)) || new Date(s.updatedAt).toISOString()!==s.updatedAt)
      fail('RUNTIME_SUMMARY_TIME','Summary timestamp must be canonical UTC ISO time.');
    if(profiles.has(s.workflow) || ids.has(s.jobId)) fail('RUNTIME_SUMMARY_DUPLICATE','Each workflow and job may appear only once.');
    if(s.artifactState==='review_blocked' && s.blockedReason===null)
      fail('RUNTIME_SUMMARY_CONFLICT','A blocked artifact requires an enumerated blocked reason.');
    profiles.add(s.workflow);ids.add(s.jobId);
  }
  return freeze(envelope.summaries);
}
