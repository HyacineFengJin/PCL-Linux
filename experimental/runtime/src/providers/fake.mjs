import { check, cloneJson, sleep, throwIfAborted } from '../errors.mjs';

// A deterministic test driver, NOT a model and NOT evidence of reasoning quality.
export class DeterministicFakeProvider {
  id = 'deterministic-fake';
  async run(ctx) {
    const steps = ctx.job.providerConfig?.steps ?? [];
    check(Array.isArray(steps) && steps.length <= 100, 'INVALID_SCRIPT', 'Expected at most 100 fake steps');
    const start = ctx.job.providerState?.cursor ?? 0;
    let result = ctx.job.providerState?.result ?? { label: 'OFFLINE_TEST_ONLY', buildValidated: false };
    for (let i = start; i < steps.length; i++) {
      throwIfAborted(ctx.signal);
      const step = steps[i];
      if (step.type === 'tool') result = await ctx.invoke(`fake-step-${i}`, step.name, step.args);
      else if (step.type === 'wait') {
        check(Number.isInteger(step.ms) && step.ms >= 0 && step.ms <= 60_000, 'INVALID_SCRIPT', 'Fake delay out of range');
        await sleep(step.ms, ctx.signal);
      } else if (step.type === 'result') result = cloneJson(step.value);
      else throw new Error(`Unknown deterministic fake step: ${step.type}`);
      await ctx.checkpoint({ cursor: i + 1, result });
    }
    return { label: 'OFFLINE_TEST_ONLY', value: result, buildValidated: false };
  }
}
