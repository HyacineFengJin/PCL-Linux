import path from 'node:path';
import { createHash } from 'node:crypto';
import { check, RuntimeError, throwIfAborted } from '../errors.mjs';

export const PINNED_PI = Object.freeze({ package: '@earendil-works/pi-coding-agent', version: '1.0.4' });

// Inspection only: no session, model request, auth discovery or account action.
export async function inspectInstalledPi() {
  const sdk = await import('@earendil-works/pi-coding-agent');
  check(sdk.VERSION === PINNED_PI.version, 'SDK_VERSION_MISMATCH', 'Installed Pi version differs from the audited pin');
  for (const name of ['createAgentSession', 'DefaultResourceLoader', 'SettingsManager', 'SessionManager']) {
    check(typeof sdk[name] === 'function', 'SDK_CONTRACT_CHANGED', `Missing SDK export ${name}`);
  }
  return { ...PINNED_PI, exportsVerified: true, sessionCreated: false, modelCalls: 0 };
}

// Intentionally no boolean flag can enable paid/live calls in this milestone.
export class DisabledPiProvider {
  id = 'pi';
  async run() {
    throw new RuntimeError('LIVE_MODEL_CALLS_DISABLED', 'Pi SDK is pinned; live session/auth integration requires a separate approved step');
  }
}

export function makePiTools(ctx) {
  return ctx.toolDescriptions.filter(tool => tool.name !== 'build.validate').map(tool => ({
    name: tool.name.replace('.', '__'), label: tool.name, description: tool.description,
    parameters: tool.inputSchema, executionMode: 'sequential',
    async execute(toolCallId, args, signal) {
      throwIfAborted(ctx.signal); throwIfAborted(signal);
      const id = `pi-${createHash('sha256').update(toolCallId).digest('hex')}`;
      const signals = [ctx.signal, signal].filter(Boolean);
      const result = await ctx.invoke(id, tool.name, args, { signal: AbortSignal.any(signals) });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  }));
}

// Host-side option builder for the next approved integration. Callers MUST supply
// their explicit model/auth runtime and persisted session manager. No defaults.
export function makePiSessionOptions(sdk, ctx, { modelRuntime, model, sessionManager }) {
  check(modelRuntime && model && sessionManager, 'EXPLICIT_SESSION_REQUIRED', 'Supply explicit model/auth runtime, model and session storage');
  const customTools = makePiTools(ctx);
  const settingsManager = sdk.SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
    cacheWarming: 'off', images: { blockImages: true },
  });
  const agentDir = path.join(ctx.workspaceRoot, '..', 'pi-private');
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: ctx.workspaceRoot, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true,
    systemPrompt: ctx.profile.systemPrompt,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
  });
  // No reload/discovery: the SDK loader starts with empty resources. Its constructor
  // does not resolve systemPrompt until reload, so supply the literal host prompt.
  resourceLoader.getSystemPrompt = () => ctx.profile.systemPrompt;
  return { cwd: ctx.workspaceRoot, agentDir, modelRuntime, model, sessionManager,
    settingsManager, resourceLoader, noTools: 'builtin',
    tools: customTools.map(t => t.name), customTools };
}

// Contract-tested with an explicitly injected offline session double only.
// This is not registered as a live provider and does not import/create Pi itself.
export async function runPiSessionContract(ctx, createOfflineSession) {
  throwIfAborted(ctx.signal);
  const { session } = await createOfflineSession({ customTools: makePiTools(ctx), profile: ctx.profile });
  let abortPromise;
  const onAbort = () => { abortPromise ??= Promise.resolve().then(() => session.abort()); };
  const events = [];
  const unsubscribe = session.subscribe(event => {
    // Keep raw prompts, tool arguments, credentials and model text out of logs.
    if (['agent_start', 'agent_settled', 'tool_execution_start', 'tool_execution_end'].includes(event.type)) {
      events.push(ctx.emit(`pi.${event.type}`, {}));
    }
  });
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (ctx.signal.aborted) { onAbort(); await abortPromise; throwIfAborted(ctx.signal); }
    await session.prompt(JSON.stringify(ctx.job.input));
    throwIfAborted(ctx.signal);
    await Promise.all(events);
    return { label: 'OFFLINE_PI_CONTRACT_TEST_ONLY', text: session.getLastAssistantText(), buildValidated: false };
  } finally {
    ctx.signal.removeEventListener('abort', onAbort);
    try { if (abortPromise) await abortPromise; }
    finally { unsubscribe(); session.dispose(); }
  }
}
