import * as fs from 'node:fs/promises';
import { check, cloneJson, RuntimeError } from '../errors.mjs';

export const DEEPSEEK_SELECTION = Object.freeze({
  provider: 'deepseek', model: 'deepseek-flash', displayName: 'DeepSeek V4.1 Flash',
  api: 'openai-completions', baseUrl: 'https://api.deepseek.com',
  credentialEnvironmentVariable: 'DEEPSEEK_API_KEY', pinnedPiVersion: '1.0.4', verifiedOn: '2026-10-06',
});

/** A credential-free preparation record, not an activated provider configuration. */
export function prepareDeepSeekPlan(options = {}) {
  check(options && typeof options === 'object' && !Array.isArray(options)
    && Object.keys(options).every(key => ['thinkingLevel', 'maximumOutputTokens'].includes(key)),
  'INVALID_PROVIDER_PLAN', 'Only non-secret thinking/output-limit options are accepted');
  const thinkingLevel = options.thinkingLevel ?? 'high';
  const maximumOutputTokens = options.maximumOutputTokens ?? 4096;
  check(['off', 'low', 'high', 'max'].includes(thinkingLevel), 'INVALID_PROVIDER_PLAN', 'Unsupported DeepSeek effort');
  check(Number.isInteger(maximumOutputTokens) && maximumOutputTokens >= 256 && maximumOutputTokens <= 8192,
    'INVALID_PROVIDER_PLAN', 'Prepared output limit must be 256–8192 tokens');
  return { schemaVersion: 1, status: 'prepared_not_activated', ...DEEPSEEK_SELECTION,
    thinkingLevel, maximumOutputTokens, strictToolSampling: false,
    proposedLimits: { modelTurns: 3, toolCalls: 12, wallTimeMs: 60_000, automaticRetries: 0 },
    controls: { liveCallsEnabled: false, credentialsRead: false, credentialPersistenceEnabled: false,
      ambientResourcesEnabled: false, modelApprovalToolsEnabled: false, generatedCodeExecutionEnabled: false },
    evidence: {
      officialModelAndEndpoint: 'https://api-docs.deepseek.com/',
      officialModelVersion: 'https://api-docs.deepseek.com/quick_start/pricing/',
      officialToolCompatibility: 'https://api-docs.deepseek.com/guides/tool_calls/',
      piProviderDocumentation: 'https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/docs/providers.md',
    } };
}

/** Reads only installed package metadata/catalog, never auth stores or env keys. */
export async function inspectPinnedDeepSeekCompatibility() {
  const sdk = JSON.parse(await fs.readFile(new URL('../../node_modules/@earendil-works/pi-coding-agent/package.json', import.meta.url), 'utf8'));
  const ai = JSON.parse(await fs.readFile(new URL('../../node_modules/@earendil-works/pi-ai/package.json', import.meta.url), 'utf8'));
  check(sdk.version === DEEPSEEK_SELECTION.pinnedPiVersion && ai.version === DEEPSEEK_SELECTION.pinnedPiVersion,
    'SDK_VERSION_MISMATCH', 'Recheck compatibility after a Pi version change');
  const catalog = JSON.parse(await fs.readFile(new URL('../../node_modules/@earendil-works/pi-ai/dist/providers/data/deepseek.json', import.meta.url), 'utf8'));
  const model = catalog['openai-completions']?.['chat:deepseek-flash'];
  check(model?.provider === 'deepseek' && model.id === 'deepseek-flash' && model.baseUrl === 'https://api.deepseek.com'
    && model.api === 'openai-completions' && model.compat?.thinkingFormat === 'deepseek'
    && model.compat?.requiresReasoningContentOnAssistantMessages === true,
  'PROVIDER_CATALOG_MISMATCH', 'Pinned model/provider compatibility metadata changed');
  return { ...DEEPSEEK_SELECTION, catalogVerified: true, sessionCreated: false, networkRequests: 0,
    credentialStoresRead: false, environmentCredentialsRead: false,
    protocolNotes: { reasoningReplaySupported: true, normalChatCompletionsToolCalls: true,
      betaStrictSamplingNotSelected: true, syntheticMidConversationToolCallsNotSupported: true } };
}

/** Never registered by the workbench. No flag or credential can activate it. */
export class PreparedDeepSeekProvider {
  id = 'deepseek-prepared';
  #plan;
  constructor(options = {}) { this.#plan = prepareDeepSeekPlan(options); }
  describe() { return cloneJson(this.#plan); }
  async run() {
    throw new RuntimeError('LIVE_MODEL_CALLS_DISABLED', 'DeepSeek is prepared only; user-owned secret entry and a separately authorized live adapter are still required');
  }
}
