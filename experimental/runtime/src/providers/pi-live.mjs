import { check, RuntimeError, throwIfAborted } from '../errors.mjs';
import { makePiSessionOptions, PINNED_PI } from './pi.mjs';
import { DEEPSEEK_SELECTION } from './deepseek.mjs';

export const LIVE_PI_LIMITS = Object.freeze({
  modelTurns: 3, toolCalls: 12, maximumOutputTokens: 4096,
  requestBytes: 120_000, responseBytes: 512_000, resultBytes: 32_000,
  wallTimeMs: 60_000, estimatedBudgetUsd: 0.05,
});
const SAFE_CODES = new Set(['LIVE_MODEL_CALLS_DISABLED', 'LIVE_RESUME_UNSUPPORTED', 'INVALID_LIVE_CONFIG',
  'SDK_VERSION_MISMATCH', 'MODEL_UNAVAILABLE', 'CREDENTIAL_REQUIRED', 'MODEL_TURN_LIMIT', 'MODEL_TOOL_LIMIT',
  'MODEL_REQUEST_LIMIT', 'MODEL_RESPONSE_LIMIT', 'MODEL_RESULT_LIMIT', 'MODEL_SPEND_LIMIT', 'MODEL_TIMEOUT',
  'MODEL_REQUEST_DENIED', 'MODEL_FAILED', 'MODEL_OUTPUT_LIMIT', 'CANCELLED', 'PROVIDER_CONFIG_DENIED']);
function containsSecret(value, secret) {
  if (typeof value === 'string') return value.includes(secret);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([name, child]) => name.includes(secret) || containsSecret(child, secret));
}

/** Real SDK integration. The host owns activation, key callback and limits, never job input. */
export class LivePiProvider {
  id = 'pi-deepseek-live';
  #enabled; #getApiKey; #limits; #loadSdk; #fetch;
  constructor({ enabled = false, getApiKey, limits = {} } = {}, dependencies = {}) {
    check(typeof enabled === 'boolean' && (getApiKey === undefined || typeof getApiKey === 'function'),
      'INVALID_LIVE_CONFIG', 'Use a host enable flag and a host-owned key callback');
    check(limits && typeof limits === 'object' && !Array.isArray(limits)
      && Object.keys(limits).every(key => Object.hasOwn(LIVE_PI_LIMITS, key)), 'INVALID_LIVE_CONFIG', 'Unknown run limit');
    this.#limits = { ...LIVE_PI_LIMITS, ...limits };
    for (const [key, value] of Object.entries(this.#limits)) {
      check(Number.isFinite(value) && value > 0 && value <= LIVE_PI_LIMITS[key]
        && (key === 'estimatedBudgetUsd' || Number.isInteger(value)), 'INVALID_LIVE_CONFIG', 'Limits may only reduce the host defaults');
    }
    this.#enabled = enabled; this.#getApiKey = getApiKey;
    this.#loadSdk = dependencies.loadSdk ?? (() => import('@earendil-works/pi-coding-agent'));
    // This injection is for host-owned mock transports; no job-config override exists.
    this.#fetch = dependencies.fetch ?? ((...args) => globalThis.fetch(...args));
  }
  async run(ctx) {
    check(this.#enabled, 'LIVE_MODEL_CALLS_DISABLED', 'Explicit host enablement is required');
    check(ctx.job.attempt === 1, 'LIVE_RESUME_UNSUPPORTED', 'Live jobs are single-attempt; review receipts before explicitly starting a new job');
    check(Object.keys(ctx.job.providerConfig ?? {}).length === 0, 'PROVIDER_CONFIG_DENIED', 'Job input cannot configure provider access');
    check(this.#getApiKey, 'CREDENTIAL_REQUIRED', 'The user must supply a key through the host entry flow');
    throwIfAborted(ctx.signal);
    const limits = this.#limits;
    const controller = new AbortController();
    const signal = AbortSignal.any([ctx.signal, controller.signal]);
    let session, unsubscribe = () => {}, abortPromise, key, failure;
    const counts = { modelTurns: 0, requests: 0, toolCalls: 0, reservedEstimatedUsd: 0 };
    const stop = (code, message) => {
      failure ??= new RuntimeError(code, message); controller.abort(); return failure;
    };
    const timer = setTimeout(() => stop('MODEL_TIMEOUT', 'The live job reached its time limit'), limits.wallTimeMs);
    const onAbort = () => { if (session) abortPromise ??= Promise.resolve().then(() => session.abort()).catch(() => {}); };
    signal.addEventListener('abort', onAbort);
    try {
      const sdk = await this.#loadSdk();
      check(sdk.VERSION === PINNED_PI.version, 'SDK_VERSION_MISMATCH', 'Installed Pi differs from the pinned version');
      throwIfAborted(signal);
      key = await this.#getApiKey();
      check(typeof key === 'string' && key.length >= 16 && key.length <= 512 && !/[\s\x00-\x1f\x7f]/.test(key),
        'CREDENTIAL_REQUIRED', 'The host did not provide a valid key value');
      throwIfAborted(signal);
      // A private in-memory store. No auth.json, models.json, environment credential
      // fallback or login operation is used. The selected provider always has a key.
      const credentials = {
        read: async id => id === 'deepseek' ? { type: 'api_key', key } : undefined,
        list: async () => [{ providerId: 'deepseek', type: 'api_key' }],
        modify: async () => { throw new Error('Credential writes are disabled'); },
        delete: async () => { throw new Error('Credential writes are disabled'); },
      };
      const modelRuntime = await sdk.ModelRuntime.create({ credentials, modelsPath: null,
        allowModelNetwork: false, refreshOnCreate: false, signal });
      const catalogModel = modelRuntime.getModel('deepseek', 'deepseek-flash');
      check(catalogModel?.baseUrl === DEEPSEEK_SELECTION.baseUrl && catalogModel.api === 'openai-completions',
        'MODEL_UNAVAILABLE', 'Pinned DeepSeek model is unavailable');
      const model = { ...catalogModel, compat: { ...catalogModel.compat, supportsStrictMode: false } };
      // Fail closed if the cost catalog becomes unusable. Estimate at cache-miss
      // rates, 2x serialized bytes + 4096 input-token overhead. This is not billing.
      check(Number.isFinite(model.cost?.input) && model.cost.input > 0 && Number.isFinite(model.cost?.output)
        && model.cost.output > 0, 'MODEL_UNAVAILABLE', 'Model price estimates are unavailable');
      const saveCounts = () => ctx.checkpoint({ livePi: { schemaVersion: 1, ...counts, liveResumeSupported: false } });
      const guardFetch = async (url, options = {}) => {
        throwIfAborted(signal);
        check(typeof url === 'string' || url instanceof URL, 'MODEL_REQUEST_DENIED', 'Unexpected request transport');
        check(String(url) === 'https://api.deepseek.com/chat/completions' && options.method === 'POST'
          && typeof options.body === 'string', 'MODEL_REQUEST_DENIED', 'Only the selected completion endpoint is allowed');
        const bytes = Buffer.byteLength(options.body);
        if (bytes > limits.requestBytes) throw stop('MODEL_REQUEST_LIMIT', 'The model request exceeded its size limit');
        const payload = JSON.parse(options.body);
        check(payload.model === 'deepseek-flash' && payload.max_tokens === limits.maximumOutputTokens
          && payload.stream === true, 'MODEL_REQUEST_DENIED', 'The provider request changed its fixed model or limits');
        if (counts.requests >= limits.modelTurns) throw stop('MODEL_TURN_LIMIT', 'The job reached its request limit');
        const estimate = ((2 * bytes + 4096) * model.cost.input + limits.maximumOutputTokens * model.cost.output) / 1_000_000;
        if (counts.reservedEstimatedUsd + estimate > limits.estimatedBudgetUsd)
          throw stop('MODEL_SPEND_LIMIT', 'The next request exceeds the local estimated spend allowance');
        counts.requests++; counts.reservedEstimatedUsd += estimate;
        await saveCounts(); // Reserve before sending; an uncertain/failed request is not refunded.
        throwIfAborted(signal);
        const response = await this.#fetch(url, { ...options, redirect: 'error', signal: AbortSignal.any([signal, options.signal].filter(Boolean)) });
        if (!response.body) return response;
        const reader = response.body.getReader(); let readBytes = 0;
        const body = new ReadableStream({
          async pull(target) {
            try {
              const part = await reader.read();
              if (part.done) { target.close(); return; }
              readBytes += part.value.byteLength;
              if (readBytes > limits.responseBytes) {
                const error = stop('MODEL_RESPONSE_LIMIT', 'The provider response exceeded its size limit');
                await reader.cancel(); target.error(error); return;
              }
              target.enqueue(part.value);
            } catch (error) { target.error(error); }
          },
          cancel: reason => reader.cancel(reason),
        });
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      };
      const toolContext = { ...ctx, signal, invoke: async (...args) => {
        throwIfAborted(signal);
        if (++counts.toolCalls > limits.toolCalls) throw stop('MODEL_TOOL_LIMIT', 'The job reached its tool-call limit');
        if (containsSecret(args[2], key)) throw stop('MODEL_REQUEST_DENIED', 'Credential-like tool input was refused');
        await saveCounts(); return ctx.invoke(...args);
      } };
      const options = makePiSessionOptions(sdk, toolContext, { modelRuntime, model,
        sessionManager: sdk.SessionManager.inMemory(ctx.workspaceRoot) });
      ({ session } = await sdk.createAgentSession({ ...options, thinkingLevel: 'high' }));
      // Use the real Pi session/tool loop and real provider serializer. The guarded
      // transport is the only request path: no warming, compaction, fallback or retries.
      session.agent.streamFunction = async (requestModel, context, requestOptions = {}) => {
        throwIfAborted(signal);
        if (++counts.modelTurns > limits.modelTurns) throw stop('MODEL_TURN_LIMIT', 'The job reached its model-turn limit');
        check(requestModel.id === model.id && requestModel.provider === model.provider
          && requestModel.baseUrl === model.baseUrl, 'MODEL_REQUEST_DENIED', 'Model routing changes are disabled');
        return modelRuntime.streamSimple(model, context, {
          ...requestOptions, apiKey: key, maxTokens: limits.maximumOutputTokens,
          maxRetries: 0, maxRetryDelayMs: 0, timeoutMs: limits.wallTimeMs,
          cacheRetention: 'none', fetch: guardFetch, env: {},
          signal: AbortSignal.any([signal, requestOptions.signal].filter(Boolean)),
        });
      };
      unsubscribe = session.subscribe(event => {
        if (event.type === 'message_end' && event.message.role === 'assistant'
          && ['error', 'aborted'].includes(event.message.stopReason)) {
          stop('MODEL_FAILED', 'The provider request failed; private provider details were withheld');
        }
      });
      if (signal.aborted) onAbort();
      throwIfAborted(signal);
      await ctx.emit('pi.live.started', { provider: 'deepseek', model: model.id });
      await session.prompt(JSON.stringify(ctx.job.input), { expandPromptTemplates: false });
      if (failure) throw failure;
      throwIfAborted(signal);
      const last = session.messages.filter(message => message.role === 'assistant').at(-1);
      check(last?.stopReason === 'stop', 'MODEL_OUTPUT_LIMIT', 'The model did not produce a complete final response');
      const text = session.getLastAssistantText() ?? '';
      check(Buffer.byteLength(text) <= limits.resultBytes && !text.includes(key), 'MODEL_RESULT_LIMIT', 'Final model text exceeded the safe result limit');
      await saveCounts();
      return { label: 'UNTRUSTED_MODEL_PROPOSAL', text, provider: 'deepseek', model: model.id, ...counts,
        buildValidated: false, runtimeValidated: false, approvalGranted: false };
    } catch (error) {
      if (ctx.signal.aborted) throw new RuntimeError('CANCELLED', 'Job was cancelled');
      if (failure) throw failure;
      if (error instanceof RuntimeError && SAFE_CODES.has(error.code)) throw error;
      throw new RuntimeError('MODEL_FAILED', 'The live provider could not finish; private provider details were withheld');
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', onAbort);
      try { if (abortPromise) await abortPromise; }
      finally { unsubscribe(); session?.dispose(); key = undefined; }
    }
  }
}
