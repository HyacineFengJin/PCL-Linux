import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Workspace } from './workspace.mjs';
import { SubprocessSupervisor } from './subprocesses.mjs';
import { captureSourceArtifact, recordDigest } from './artifact-snapshot.mjs';
import { check, cloneJson } from './errors.mjs';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/.test(value);
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const MARKER = 'PCL_SYNTHETIC_ERROR';
function stages(snapshot) {
  return { generated: { status: 'source_ready', evidence: { sourceFingerprint: snapshot.fingerprint, operationId: snapshot.operationId } },
    compiled: { status: 'not_run', evidence: null }, packaged: { status: 'not_run', evidence: null },
    loaded: { status: 'not_run', evidence: null }, behaviorVerified: { status: 'not_run', evidence: null } };
}

/** Host lifecycle API. Real generated-code execution is unconditionally disabled. */
export class BuildService {
  #store; #supervisor; #active = new Map(); #starting = new Set(); #delay; #closed = false;
  constructor({ store, fixtureDelayMs = 25 }) {
    check(store && Number.isInteger(fixtureDelayMs) && fixtureDelayMs >= 0 && fixtureDelayMs <= 5000,
      'INVALID_BUILD_HOST', 'Expected the shared store and a bounded fixture delay');
    this.#store = store; this.#delay = fixtureDelayMs;
    this.#supervisor = new SubprocessSupervisor({ trustedCommands: { synthetic: {
      executable: process.execPath, args: [fileURLToPath(new URL('../fixtures/synthetic-build-child.mjs', import.meta.url))],
    } } });
  }
  async #control(jobId) { await this.#store.files(jobId); return new Workspace(path.join(this.#store.directory(jobId), 'build-control')).init(); }
  async #index(control) {
    try { return JSON.parse((await control.read('index.json')).content); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return { requests: [], activeBuildId: null }; }
  }
  async #save(control, record) {
    record.revision++; record.updatedAt = new Date().toISOString();
    await control.write(`runs/${record.buildId}.json`, JSON.stringify(cloneJson(record, { maxBytes: 64_000 })));
  }
  async status(jobId, buildId) {
    check(uuid(buildId), 'INVALID_BUILD_ID', 'Expected a build ID');
    let record;
    try { record = JSON.parse((await (await this.#control(jobId)).read(`runs/${buildId}.json`)).content); }
    catch (error) { if (error.code === 'ENOENT') error.code = 'BUILD_NOT_FOUND'; throw error; }
    check(record.jobId === jobId && record.buildId === buildId, 'BUILD_NOT_FOUND', 'No build belongs to this job');
    return cloneJson(record);
  }
  async getPublicSummary(jobId, buildId) {
    const record = await this.status(jobId, buildId);
    return cloneJson({ schemaVersion: 1, jobId: record.jobId, buildId: record.buildId, workflow: record.workflow,
      revision: record.revision, status: record.status, mode: record.mode, sourceFingerprint: record.sourceFingerprint,
      stages: record.stages, simulation: record.simulation, diagnosticCount: record.diagnostics.length,
      errorFingerprint: record.errorFingerprint, updatedAt: record.updatedAt });
  }
  start(jobId, options) {
    const pending = this.#start(jobId, options); this.#starting.add(pending);
    const settled = () => this.#starting.delete(pending); pending.then(settled, settled);
    return pending;
  }
  async #start(jobId, { sourceOperationId, requestId, mode = 'real' }) {
    check(!this.#closed, 'BUILD_HOST_CLOSED', 'Build host is shut down');
    check(mode === 'simulated', 'BUILD_EXECUTION_DISABLED', 'Real builds remain disabled: required OS containment is unavailable');
    check(uuid(requestId), 'INVALID_REQUEST_ID', 'Expected an idempotency request ID');
    const control = await this.#control(jobId); const binding = recordDigest({ sourceOperationId, mode });
    const existing = (await this.#index(control)).requests.find(request => request.id === requestId);
    if (existing) { check(existing.binding === binding, 'BUILD_REQUEST_CONFLICT', 'Request ID belongs to different inputs'); return this.status(jobId, existing.buildId); }
    const release = await this.#store.acquire(jobId); let transferred = false;
    try {
      const job = await this.#store.load(jobId); const index = await this.#index(control);
      const previous = index.requests.find(request => request.id === requestId);
      if (previous) { check(previous.binding === binding, 'BUILD_REQUEST_CONFLICT', 'Request ID belongs to different inputs'); return this.status(jobId, previous.buildId); }
      check(!index.activeBuildId, 'BUILD_BUSY', 'A build is active or needs explicit interruption recovery');
      check(index.requests.length < 20, 'BUILD_LIMIT', 'This job reached its build-attempt limit');
      const snapshot = await captureSourceArtifact(this.#store, job, sourceOperationId);
      check(!this.#closed, 'BUILD_HOST_CLOSED', 'Shutdown cancelled pending build admission');
      const buildId = randomUUID(); const record = { schemaVersion: 1, buildId, jobId, workflow: job.profile,
        sourceOperationId, sourceFingerprint: snapshot.fingerprint, mode: 'simulated', status: 'running', revision: 0,
        diagnostics: [], errorFingerprint: null, errorCode: null, stages: stages(snapshot),
        simulation: { label: 'SYNTHETIC_BUILD_FIXTURE', outcome: 'pending' }, checkpoint: 'child_pending',
        startedAt: new Date().toISOString(), actualGeneratedCodeExecuted: false };
      await this.#save(control, record); index.activeBuildId = buildId; index.requests.push({ id: requestId, binding, buildId });
      await control.write('index.json', JSON.stringify(index));
      const run = { controller: new AbortController(), promise: null };
      // Shutdown may have arrived during the durable reservation writes. An
      // aborted supervisor run finalizes that reservation without spawning.
      if (this.#closed) run.controller.abort();
      this.#active.set(buildId, run);
      run.promise = this.#run(record, snapshot, run).finally(async () => { try { await release(); } finally { this.#active.delete(buildId); } });
      run.promise.catch(() => {}); // Status/wait exposes failures without an unhandled background rejection.
      transferred = true; return cloneJson(record);
    } finally { if (!transferred) await release(); }
  }
  async #run(record, snapshot, run) {
    let outcome;
    try {
      const found = Object.entries(snapshot.files).sort(([a], [b]) => a.localeCompare(b))
        .find(([name, bytes]) => name.startsWith('src/main/') && bytes.toString('utf8').includes(MARKER));
      const marker = found ? { file: found[0], line: found[1].toString('utf8').slice(0, found[1].toString('utf8').indexOf(MARKER)).split('\n').length } : null;
      const processResult = await this.#supervisor.run('synthetic', { cwd: this.#store.directory(record.jobId),
        signal: run.controller.signal, timeoutMs: 6000, maxOutputBytes: 16_000,
        input: JSON.stringify({ label: 'SYNTHETIC_BUILD_FIXTURE', marker, delayMs: this.#delay }) });
      if (processResult.status === 'cancelled') outcome = { status: 'cancelled', errorCode: null };
      else {
        const report = JSON.parse(processResult.stdout);
        check(report.label === 'SYNTHETIC_BUILD_FIXTURE' && report.outcome === (marker ? 'failed' : 'passed')
          && processResult.exitCode === (marker ? 1 : 0) && Object.values(report.actualExecution).every(value => value === false)
          && Array.isArray(report.diagnostics) && report.diagnostics.length === (marker ? 1 : 0), 'BUILD_FIXTURE_FAILED', 'Synthetic child returned an invalid result');
        const diagnostics = marker ? [{ category: 'synthetic', severity: 'error', code: 'SYNTHETIC_MARKER', file: marker.file, line: marker.line,
          message: 'Authored marker triggers this simulated diagnostic; no compiler ran.' }] : [];
        outcome = { status: marker ? 'failed' : 'succeeded', diagnostics,
          errorFingerprint: marker ? recordDigest(diagnostics.map(({ code, file, line }) => ({ code, file, line }))) : null,
          simulation: { label: 'SYNTHETIC_BUILD_FIXTURE', outcome: report.outcome } };
      }
    } catch (error) { outcome = { status: run.controller.signal.aborted ? 'cancelled' : 'failed', errorCode: 'BUILD_FIXTURE_FAILED' }; }
    // The build holds the shared job lease until child cleanup and finalization.
    // Same-user external mutations remain outside this non-sandbox threat model.
    {
      const control = await this.#control(record.jobId); const current = await this.status(record.jobId, record.buildId);
      if (run.controller.signal.aborted) outcome = { status: 'cancelled', errorCode: null };
      else try {
        const fresh = await captureSourceArtifact(this.#store, await this.#store.load(record.jobId), record.sourceOperationId);
        check(fresh.fingerprint === record.sourceFingerprint, 'SOURCE_CHANGED', 'Source changed during build');
      } catch { outcome = { status: 'failed', errorCode: 'SOURCE_CHANGED', diagnostics: [], errorFingerprint: null,
        simulation: { label: 'SYNTHETIC_BUILD_FIXTURE', outcome: 'discarded_source_changed' } }; }
      Object.assign(current, outcome, { checkpoint: 'terminal', finishedAt: new Date().toISOString() });
      if (current.status === 'cancelled') current.simulation.outcome = 'cancelled';
      else if (current.errorCode === 'BUILD_FIXTURE_FAILED') current.simulation.outcome = 'fixture_error';
      if (current.errorCode === 'SOURCE_CHANGED') current.stages.generated = { status: 'invalidated', evidence: null };
      await this.#save(control, current); const index = await this.#index(control);
      if (index.activeBuildId === current.buildId) index.activeBuildId = null;
      await control.write('index.json', JSON.stringify(index));
      await this.#store.event(record.jobId, 'build.simulated.finished', { buildId: record.buildId, status: current.status });
    }
    return this.status(record.jobId, record.buildId);
  }
  async wait(jobId, buildId) {
    await this.status(jobId, buildId); const active = this.#active.get(buildId);
    if (active) { await active.promise; return this.status(jobId, buildId); }
    const record = await this.status(jobId, buildId);
    check(TERMINAL.has(record.status), 'BUILD_RECOVERY_REQUIRED', 'Previous host stopped; explicit interruption recovery is required'); return record;
  }
  async cancel(jobId, buildId) {
    const record = await this.status(jobId, buildId); if (TERMINAL.has(record.status)) return record;
    const active = this.#active.get(buildId);
    if (!active) { const fresh = await this.status(jobId, buildId); if (TERMINAL.has(fresh.status)) return fresh; }
    check(active, 'BUILD_OWNER_REQUIRED', 'Cancel through the running build host');
    active.controller.abort(); await active.promise; return this.status(jobId, buildId);
  }
  async shutdown() {
    this.#closed = true;
    for (const run of this.#active.values()) run.controller.abort();
    await Promise.allSettled([...this.#starting]);
    const runs = [...this.#active.values()]; runs.forEach(run => run.controller.abort());
    await Promise.allSettled(runs.map(run => run.promise)); await this.#supervisor.shutdown();
  }
}
