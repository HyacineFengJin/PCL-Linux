/** Offline routing regressions only: no runtime jobs, domain adapters, native
 * host, credential files or model services are started by these checks. */
import test from "node:test";
import assert from "node:assert/strict";
import * as sdk from "@earendil-works/pi-coding-agent";
import {
  createPrivateModelRuntime,
  getPiCatalog,
  normalizePiSelection,
  publicPiSelection,
  installPiModel,
  validatePiRequest,
  selectedRequestEndpoint,
} from "../src/providers/pi-selection.mjs";

// Pi distinguishes an OpenAI API key from an OAuth token by the sk- prefix.
const fixtureKey = "sk-offline-routing-fixture-not-a-real-key";
const failCode = (code) => (error) => error?.code === code;
function credentials(provider, key = fixtureKey) {
  return {
    read: async (id) =>
      id === provider ? { type: "api_key", key } : undefined,
    list: async () => [{ providerId: provider, type: "api_key" }],
    modify: async () => assert.fail("No credential writes"),
    delete: async () => assert.fail("No credential writes"),
  };
}

test("the bundled catalog supports multiple API-key providers without auth discovery", async () => {
  const catalog = await getPiCatalog();
  for (const id of [
    "openai",
    "anthropic",
    "deepseek",
    "openrouter",
    "groq",
    "mistral",
  ]) {
    assert.ok(catalog.providers.find((p) => p.id === id)?.models.length, id);
  }
  assert.equal(
    catalog.providers.some((p) => p.id === "openai-codex"),
    false,
  );
});
test("custom routes are literal, and public status never returns credentials", async () => {
  const selection = await normalizePiSelection({
    provider: "pcl-custom",
    model: "local-model",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1234/v1/",
    key: fixtureKey,
  });
  assert.equal(selection.baseUrl, "http://127.0.0.1:1234/v1");
  assert.equal(selection.costKnown, false);
  assert.equal(
    JSON.stringify(publicPiSelection(selection)).includes(fixtureKey),
    false,
  );
  await assert.rejects(
    normalizePiSelection({ ...publicPiSelection(selection), key: fixtureKey }),
    failCode("INVALID_LIVE_CONFIG"),
  );
  for (const baseUrl of [
    "file:///tmp/model",
    "https://user:pass@example.invalid/v1",
    "https://example.invalid/v1?key=secret",
  ])
    await assert.rejects(
      normalizePiSelection({
        provider: "pcl-custom",
        model: "local",
        api: "openai-completions",
        baseUrl,
      }),
      failCode("INVALID_LIVE_CONFIG"),
    );
});
test("missing prices are unknown, explicit zero prices are valid, and local keys are optional", async () => {
  const args = {
    provider: "pcl-custom",
    model: "local",
    api: "openai-completions",
    baseUrl: "http://localhost:1234/v1",
  };
  const selection = await normalizePiSelection(args);
  assert.equal(selection.key, "");
  assert.equal(selection.costKnown, false);
  assert.equal(
    (await normalizePiSelection({ ...args, cost: { input: 0, output: 0 } }))
      .costKnown,
    true,
  );
  await assert.rejects(
    normalizePiSelection({ ...args, cost: { input: -1, output: 0 } }),
    failCode("INVALID_LIVE_CONFIG"),
  );
});
test("built-in routes cannot be overridden and unknown model IDs fail before a request", async () => {
  const catalog = await getPiCatalog();
  const model = catalog.providers.find((p) => p.id === "deepseek").models[0].id;
  await assert.rejects(
    normalizePiSelection({
      provider: "deepseek",
      model,
      key: fixtureKey,
      baseUrl: "https://example.invalid",
    }),
    failCode("INVALID_LIVE_CONFIG"),
  );
  await assert.rejects(
    normalizePiSelection({
      provider: "deepseek",
      model: "absent-model",
      key: fixtureKey,
    }),
    failCode("MODEL_UNAVAILABLE"),
  );
});
for (const provider of ["openai", "anthropic", "deepseek", "mistral"]) {
  test(`real Pi ${provider} serialization stays within its selected endpoint and output limit`, async () => {
    const catalog = await getPiCatalog();
    const entry = catalog.providers.find((p) => p.id === provider).models[0];
    const selection = await normalizePiSelection({
      provider,
      model: entry.id,
      key: fixtureKey,
      thinking: "off",
    });
    const runtime = await createPrivateModelRuntime(sdk, credentials(provider));
    const model = installPiModel(runtime, selection);
    let requests = 0,
      accepted = false,
      diagnostic;
    const stream = runtime.streamSimple(
      model,
      {
        systemPrompt: "Offline serializer check.",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Reply with one word." }],
            timestamp: 0,
          },
        ],
      },
      {
        apiKey: fixtureKey,
        env: {},
        maxTokens: 4096,
        reasoning: undefined,
        maxRetries: 0,
        fetch: async (url, options) => {
          requests++;
          const payload = JSON.parse(options.body);
          diagnostic = JSON.stringify({
            url: String(url),
            model: payload.model,
            max: payload.max_output_tokens,
            stream: payload.stream,
          });
          validatePiRequest(model, url, options, 4096);
          accepted = true;
          // A synthetic HTTP failure stops here; no network is reachable.
          return new Response(
            JSON.stringify({
              error: { type: "offline", message: "offline fixture" },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        },
      },
    );
    const result = await stream.result();
    assert.equal(requests, 1);
    assert.equal(accepted, true, diagnostic);
    assert.equal(result.stopReason, "error");
    assert.ok(
      !result.errorMessage?.includes("Only the selected model endpoint"),
    );
    assert.ok(!result.errorMessage?.includes("changed its fixed model"));
    const endpoint = selectedRequestEndpoint(model);
    assert.throws(
      () =>
        validatePiRequest(
          model,
          endpoint + "/other",
          { method: "POST", body: "{}" },
          4096,
        ),
      failCode("MODEL_REQUEST_DENIED"),
    );
  });
}
for (const api of [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
]) {
  test(`custom ${api} registration uses Pi without writing an auth file`, async () => {
    const selection = await normalizePiSelection({
      provider: "pcl-custom",
      model: "local-fixture",
      api,
      baseUrl:
        "http://127.0.0.1:1234" + (api === "anthropic-messages" ? "" : "/v1"),
    });
    const runtime = await createPrivateModelRuntime(
      sdk,
      credentials("pcl-custom", "pcl-local-no-auth"),
    );
    const model = installPiModel(runtime, selection);
    let requests = 0,
      accepted = false,
      diagnostic;
    const result = await runtime
      .streamSimple(
        model,
        {
          systemPrompt: "Offline.",
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "One word." }],
              timestamp: 0,
            },
          ],
        },
        {
          apiKey: "pcl-local-no-auth",
          env: {},
          maxTokens: 4096,
          reasoning: undefined,
          maxRetries: 0,
          fetch: async (url, options) => {
            requests++;
            const payload = JSON.parse(options.body);
            diagnostic = JSON.stringify({
              url: String(url),
              method: options.method,
              model: payload.model,
              max: payload.max_tokens,
              stream: payload.stream,
            });
            validatePiRequest(model, url, options, 4096);
            accepted = true;
            return new Response('{"error":{"message":"offline fixture"}}', {
              status: 400,
              headers: { "content-type": "application/json" },
            });
          },
        },
      )
      .result();
    assert.equal(requests, 1);
    assert.equal(accepted, true, diagnostic);
    assert.equal(result.stopReason, "error");
  });
}

for (const provider of ["anthropic", "deepseek"]) {
  test(`Pi ${provider} thinking stays inside the per-job model ceiling`, async () => {
    const catalog = await getPiCatalog();
    const entry = catalog.providers
      .find((p) => p.id === provider)
      .models.find((m) => m.reasoning);
    assert.ok(entry);
    const selection = await normalizePiSelection({
      provider,
      model: entry.id,
      key: fixtureKey,
      thinking: "high",
    });
    const runtime = await createPrivateModelRuntime(sdk, credentials(provider));
    const model = { ...installPiModel(runtime, selection), maxTokens: 4096 };
    let accepted = false;
    await runtime
      .streamSimple(
        model,
        {
          systemPrompt: "Offline.",
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "One word." }],
              timestamp: 0,
            },
          ],
        },
        {
          apiKey: fixtureKey,
          env: {},
          maxTokens: 4096,
          reasoning: "high",
          maxRetries: 0,
          fetch: async (url, options) => {
            validatePiRequest(model, url, options, 4096);
            accepted = true;
            return new Response('{"error":{"message":"offline fixture"}}', {
              status: 400,
              headers: { "content-type": "application/json" },
            });
          },
        },
      )
      .result();
    assert.equal(accepted, true);
  });
}

test("the live wrapper uses an actual Pi session with an offline transport and no credential persistence", async () => {
  const { LivePiProvider } = await import("../src/providers/pi-live.mjs");
  const { PI_WORK_LIMITS } = await import("../src/providers/pi-limits.mjs");
  const limits = { ...PI_WORK_LIMITS, maximumOutputTokens: 16384 };
  const { mkdir } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const workspaceRoot = fileURLToPath(
    new URL("../../../work/pi-routing-tests/workspace/", import.meta.url),
  );
  await mkdir(workspaceRoot, { recursive: true });
  const selection = await normalizePiSelection({
    provider: "pcl-custom",
    model: "local-fixture",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1234/v1",
  });
  let requests = 0;
  const checkpoints = [];
  const provider = new LivePiProvider(
    { enabled: true, getSelection: () => selection, getLimits: () => limits },
    {
      loadSdk: async () => {
        limits.maximumOutputTokens = 512;
        return sdk;
      },
      fetch: async (url, options) => {
        requests++;
        validatePiRequest(
          { id: selection.id, api: selection.api, baseUrl: selection.baseUrl },
          url,
          options,
          16384,
        );
        assert.equal(JSON.parse(options.body).max_tokens, 16384);
        const chunks = [
          {
            id: "offline",
            object: "chat.completion.chunk",
            created: 0,
            model: "local-fixture",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "Offline response." },
                finish_reason: null,
              },
            ],
          },
          {
            id: "offline",
            object: "chat.completion.chunk",
            created: 0,
            model: "local-fixture",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
        ];
        return new Response(
          chunks.map((v) => "data: " + JSON.stringify(v) + "\n\n").join("") +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    },
  );
  const result = await provider.run({
    workspaceRoot,
    signal: new AbortController().signal,
    profile: { systemPrompt: "Offline contract only." },
    toolDescriptions: [],
    job: { attempt: 1, providerConfig: {}, input: { prompt: "One word." } },
    checkpoint: async (value) => checkpoints.push(value),
    emit: async () => {},
    invoke: async () => assert.fail("No tools in this check"),
  });
  assert.equal(requests, 1);
  assert.equal(result.text, "Offline response.");
  assert.equal(result.provider, "pcl-custom");
  assert.equal(result.reservedEstimatedUsd, null);
  assert.equal(result.priceEstimateAvailable, false);
  assert.equal(
    JSON.stringify(checkpoints).includes("pcl-local-no-auth"),
    false,
  );
});
