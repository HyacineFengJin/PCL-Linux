import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workspace } from './workspace.mjs';
import { check, cloneJson } from './errors.mjs';

/** Host-owned bounded repair coordinator. Never owns or manufactures approval. */
export class RepairService {
  #store; #builds; #reviews;
  constructor({ store, builds, reviews }) { this.#store = store; this.#builds = builds; this.#reviews = reviews; }
  async #control(jobId) { await this.#store.files(jobId); return new Workspace(path.join(this.#store.directory(jobId), 'repair-control')).init(); }
  async #exclusive(jobId, fn) {
    const control = await this.#control(jobId); const lock = path.join(control.root, 'host.lock');
    try { await fs.mkdir(lock, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') error.code = 'REPAIR_BUSY'; throw error; }
    try { return await fn(control); } finally { await fs.rmdir(lock); }
  }
  async #load(control) { return JSON.parse((await control.read('state.json')).content); }
  async #save(control, state) {
    state.revision++; state.updatedAt = new Date().toISOString();
    await control.write('state.json', JSON.stringify(cloneJson(state, { maxBytes: 48_000 }))); return cloneJson(state);
  }
  async #start(control, state) {
    check(state.checkpoint === 'build_start_pending', 'REPAIR_STATE', 'No build checkpoint is ready');
    let build;
    try { build = await this.#builds.start(state.jobId, { sourceOperationId: state.currentSourceOperationId,
      mode: 'simulated', requestId: state.nextRequestId }); }
    catch (error) {
      const definite = ['INVALID_SOURCE', 'SOURCE_CHANGED', 'SOURCE_TOO_LARGE', 'UNSAFE_PATH', 'ENOENT',
        'BUILD_EXECUTION_DISABLED', 'BUILD_LIMIT', 'INVALID_REQUEST_ID', 'BUILD_REQUEST_CONFLICT', 'BUILD_HOST_CLOSED'].includes(error.code);
      state.status = definite ? 'blocked_admission' : 'awaiting_build_admission';
      state.checkpoint = definite ? 'build_admission_rejected' : 'build_start_pending';
      state.recoveryReason = error.code ?? 'BUILD_ADMISSION_UNCERTAIN';
      await this.#save(control, state); throw error;
    }
    if (!state.attemptIds.includes(build.buildId)) state.attemptIds.push(build.buildId);
    state.currentBuildId = build.buildId; state.sourceFingerprint = build.sourceFingerprint;
    state.status = 'building'; state.checkpoint = 'build_running'; state.review = null;
    return this.#save(control, state);
  }
  async begin(jobId, { sourceOperationId, maxRetries = 1, mode = 'real' }) {
    check(mode === 'simulated', 'BUILD_EXECUTION_DISABLED', 'Real repair builds require tested OS containment');
    check(Number.isInteger(maxRetries) && maxRetries >= 0 && maxRetries <= 2, 'REPAIR_LIMIT', 'At most two reviewed retries are allowed');
    return this.#exclusive(jobId, async control => {
      let prior; try { prior = await this.#load(control); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (prior) { check(prior.initialSourceOperationId === sourceOperationId && prior.maxRetries === maxRetries,
        'REPAIR_CONFLICT', 'This job already has a different repair workflow'); return cloneJson(prior); }
      const state = { schemaVersion: 1, jobId, revision: 0, mode: 'simulated', status: 'starting', checkpoint: 'build_start_pending',
        initialSourceOperationId: sourceOperationId, currentSourceOperationId: sourceOperationId, currentBuildId: null,
        attemptIds: [], maxRetries, nextRequestId: randomUUID(), processedBuildId: null, seenErrorFingerprints: [],
        errorFingerprint: null, diagnostics: [], review: null, stages: null, generatedCodeExecuted: false };
      await this.#save(control, state); return this.#start(control, state);
    });
  }
  async #reconcile(control, state) {
    if (state.status === 'awaiting_approval' && state.review) {
      const review = await this.#reviews.getReview(state.jobId, state.review.reviewId);
      if (['expired', 'cancelled'].includes(review.status)) {
        state.status = 'awaiting_review'; state.checkpoint = 'build_finished';
        state.recoveryReason = review.status === 'expired' ? 'APPROVAL_EXPIRED' : 'REVIEW_CANCELLED';
        state.review = null; return this.#save(control, state);
      }
    }
    if (state.checkpoint !== 'build_running') return cloneJson(state);
    const build = await this.#builds.status(state.jobId, state.currentBuildId); state.stages = build.stages;
    if (build.status === 'running') return cloneJson(state);
    if (state.processedBuildId === build.buildId) return cloneJson(state);
    state.processedBuildId = build.buildId; state.checkpoint = 'build_finished';
    state.errorFingerprint = build.errorFingerprint; state.diagnostics = build.diagnostics;
    if (build.status === 'cancelled') state.status = 'cancelled';
    else if (build.status === 'succeeded') state.status = 'simulated_success';
    else if (build.errorCode || !build.errorFingerprint) state.status = 'blocked_build_error';
    else if (state.seenErrorFingerprints.includes(build.errorFingerprint)) state.status = 'blocked_repeat_failure';
    else if (state.attemptIds.length >= 1 + state.maxRetries) state.status = 'blocked_retry_limit';
    else { state.seenErrorFingerprints.push(build.errorFingerprint); state.status = 'awaiting_review'; }
    return this.#save(control, state);
  }
  async status(jobId) { return this.#exclusive(jobId, async control => this.#reconcile(control, await this.#load(control))); }
  async getPublicReviewReference(jobId) {
    return this.#exclusive(jobId, async control => {
      const state = await this.#reconcile(control, await this.#load(control));
      if (state.status !== 'awaiting_approval' || !state.review) return null;
      const review = await this.#reviews.getReview(jobId, state.review.reviewId);
      const binding = await this.#reviews.assertRepairSource(jobId, review.reviewId, state.currentSourceOperationId);
      check(binding.sourceFingerprint === state.sourceFingerprint && review.reviewDigest === state.review.digest,
        'REPAIR_SOURCE_MISMATCH', 'Review no longer matches the failed build source');
      return { jobId, buildId: state.currentBuildId, reviewId: review.reviewId, reviewDigest: review.reviewDigest,
        sourceFingerprint: binding.sourceFingerprint, status: review.status };
    });
  }
  async wait(jobId) {
    const state = await this.status(jobId);
    if (state.checkpoint === 'build_running') await this.#builds.wait(jobId, state.currentBuildId);
    return this.status(jobId);
  }
  async attachReview(jobId, { reviewId, expectedDigest }) {
    return this.#exclusive(jobId, async control => {
      const state = await this.#reconcile(control, await this.#load(control));
      check(state.status === 'awaiting_review', 'REPAIR_STATE', 'A failed attempt must be ready for review');
      const review = await this.#reviews.getReview(jobId, reviewId);
      check(review.status === 'pending' && review.reviewDigest === expectedDigest, 'STALE_APPROVAL', 'Show the authoritative pending review before attaching it');
      await this.#reviews.assertRepairSource(jobId, reviewId, state.currentSourceOperationId);
      state.review = { reviewId, digest: expectedDigest }; state.status = 'awaiting_approval';
      return this.#save(control, state);
    });
  }
  async applyAndRetry(jobId, { reviewId, expectedDigest, approvalToken }) {
    return this.#exclusive(jobId, async control => {
      const state = await this.#load(control);
      if (state.lastAppliedReview?.reviewId === reviewId && state.lastAppliedReview.digest === expectedDigest) return cloneJson(state);
      check(['awaiting_approval', 'applying_review'].includes(state.status) && state.review?.reviewId === reviewId
        && state.review.digest === expectedDigest, 'STALE_APPROVAL', 'Repair requires its exact attached review');
      check(state.attemptIds.length < 1 + state.maxRetries, 'REPAIR_LIMIT', 'No retry allowance remains');
      await this.#reviews.assertRepairSource(jobId, reviewId, state.currentSourceOperationId);
      const job = await this.#store.load(jobId);
      let applied = job.operations.find(op => op.id === `host-${reviewId}` && op.status === 'completed'
        && op.result?.reviewDigest === expectedDigest)?.result;
      if (!applied) {
        state.status = 'applying_review'; state.checkpoint = 'apply_pending'; await this.#save(control, state);
        try { applied = await this.#reviews.applyApprovedReview(jobId, { reviewId, approvalToken }); }
        catch (error) {
          // A receipt is authoritative even if a later control/event write failed.
          // Never replay an uncertain effect merely because its response was lost.
          const freshJob = await this.#store.load(jobId);
          applied = freshJob.operations.find(op => op.id === `host-${reviewId}` && op.status === 'completed'
            && op.result?.reviewDigest === expectedDigest)?.result;
          if (!applied) {
            const review = await this.#reviews.getReview(jobId, reviewId);
            state.recoveryReason = error.code ?? 'REVIEW_APPLY_FAILED';
            if (['APPROVAL_REQUIRED', 'APPROVAL_EXPIRED'].includes(error.code)
              && ['pending', 'approved', 'expired', 'cancelled'].includes(review.status)) {
              state.status = ['pending', 'approved'].includes(review.status) ? 'awaiting_approval' : 'awaiting_review';
              state.checkpoint = 'build_finished';
              if (state.status === 'awaiting_review') state.review = null;
            } else {
              state.status = 'blocked_reconciliation'; state.checkpoint = 'apply_uncertain';
            }
            await this.#save(control, state); throw error;
          }
        }
      }
      state.currentSourceOperationId = `host-${reviewId}`; state.nextRequestId = randomUUID();
      state.lastAppliedReview = { reviewId, digest: expectedDigest };
      state.status = 'starting'; state.checkpoint = 'build_start_pending'; state.copyCreated = applied.outputDirectory;
      await this.#save(control, state); return this.#start(control, state);
    });
  }
  async resumePendingBuild(jobId) {
    return this.#exclusive(jobId, async control => this.#start(control, await this.#load(control)));
  }
  async cancel(jobId) {
    return this.#exclusive(jobId, async control => {
      const state = await this.#load(control);
      if (['simulated_success', 'cancelled', 'blocked_build_error', 'blocked_repeat_failure', 'blocked_retry_limit', 'blocked_reconciliation'].includes(state.status)) return cloneJson(state);
      if (state.checkpoint === 'build_running') await this.#builds.cancel(jobId, state.currentBuildId);
      if (state.review) await this.#reviews.revokeReview(jobId, { reviewId: state.review.reviewId });
      state.status = 'cancelled'; state.checkpoint = 'cancelled'; state.review = null;
      return this.#save(control, state);
    });
  }
}
