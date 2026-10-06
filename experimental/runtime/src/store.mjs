import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { check, RuntimeError } from './errors.mjs';
import { Workspace } from './workspace.mjs';

export class JobStore {
  constructor(root) { this.root = path.resolve(root); }
  async init() { await fs.mkdir(this.root, { recursive: true, mode: 0o700 }); this.root = await fs.realpath(this.root); return this; }
  directory(id) {
    check(typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id), 'INVALID_JOB_ID', 'Invalid job ID');
    return path.join(this.root, id);
  }
  async files(id) {
    const directory = this.directory(id);
    const stat = await fs.lstat(directory);
    check(stat.isDirectory() && !stat.isSymbolicLink(), 'INVALID_JOB', 'Expected an existing private job directory');
    return new Workspace(directory).init();
  }
  async create(data) {
    const id = randomUUID();
    await fs.mkdir(this.directory(id), { mode: 0o700 });
    await new Workspace(path.join(this.directory(id), 'workspace')).init();
    const now = new Date().toISOString();
    const job = { schemaVersion: 1, id, revision: 0, createdAt: now, updatedAt: now,
      status: 'queued', attempt: 0, providerState: {}, operations: [], result: null,
      verification: { generatedCodeExecuted: false, buildValidated: false }, ...data };
    await this.save(job);
    await this.event(id, 'job.created', { profile: job.profile, provider: job.provider });
    return job;
  }
  async load(id) {
    const file = await (await this.files(id)).read('job.json');
    const job = JSON.parse(file.content);
    check(job.id === id && job.schemaVersion === 1, 'INVALID_JOB', 'Invalid persisted job');
    return job;
  }
  async save(job) {
    const next = { ...job, updatedAt: new Date().toISOString(), revision: job.revision + 1 };
    const text = JSON.stringify(next);
    check(Buffer.byteLength(text) <= 800_000, 'JOB_TOO_LARGE', 'Persisted job metadata exceeded its total budget');
    await (await this.files(job.id)).write('job.json', text);
    job.updatedAt = next.updatedAt; job.revision = next.revision;
  }
  async event(id, type, metadata = {}) {
    const line = JSON.stringify({ time: new Date().toISOString(), type, ...metadata });
    check(line.length < 8192, 'EVENT_TOO_LARGE', 'Event metadata is too large');
    const files = await this.files(id);
    const target = await files.resolve('events.jsonl');
    const handle = await fs.open(target, 'a', 0o600);
    try { await handle.write(`${line}\n`); } finally { await handle.close(); }
  }
  async workspace(id) { return new Workspace(path.join(this.directory(id), 'workspace')).init(); }
  async acquire(id) {
    const lease = path.join(this.directory(id), 'run.lock');
    try { await fs.mkdir(lease, { mode: 0o700 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = await fs.lstat(lease);
      check(stat.isDirectory() && !stat.isSymbolicLink(), 'INVALID_LEASE', 'Invalid run lease');
      let owner;
      try { owner = JSON.parse(await fs.readFile(path.join(lease, 'owner.json'), 'utf8')); }
      catch { throw new RuntimeError('JOB_BUSY', 'Run lease is incomplete; inspect before recovering'); }
      check(Number.isSafeInteger(owner.pid) && owner.pid > 0, 'INVALID_LEASE', 'Invalid lease owner');
      let live = true;
      try { process.kill(owner.pid, 0); } catch (e) { if (e.code === 'ESRCH') live = false; }
      check(!live, 'JOB_BUSY', 'Another live runtime owns this job');
      // Never delete a lock based on a previous observation: a second recovering
      // process could otherwise remove a newly acquired live lock (ABA race).
      throw new RuntimeError('STALE_LEASE', 'Dead-owner lease retained; stop all runtime hosts and perform exclusive recovery before resuming');
    }
    const token = randomUUID();
    await fs.writeFile(path.join(lease, 'owner.json'), JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 });
    return async () => {
      const owner = JSON.parse(await fs.readFile(path.join(lease, 'owner.json'), 'utf8'));
      check(owner.token === token, 'INVALID_LEASE', 'Run lease changed unexpectedly');
      await fs.rm(lease, { recursive: true });
    };
  }
}
