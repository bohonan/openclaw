// Finish lazy SDK/worker fixture initialization during collection so a cold import
// cannot outlive a test and resume against the next test's reset mocks.
import "openclaw/plugin-sdk/image-generation";
import "openclaw/plugin-sdk/media-generation-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, vi } from "vitest";
import { buildOpenAIImageGenerationProvider } from "./image-generation-provider.js";

const {
  ensureAuthProfileStoreMock,
  isProviderApiKeyConfiguredMock,
  listProfilesForProviderMock,
  resolveApiKeyForProviderMock,
  postJsonRequestMock,
  postMultipartRequestMock,
  assertOkOrThrowHttpErrorMock,
  resolveProviderHttpRequestConfigMock,
  sanitizeConfiguredModelProviderRequestMock,
  logInfoMock,
} = vi.hoisted(() => ({
  ensureAuthProfileStoreMock: vi.fn(() => ({ version: 1, profiles: {} })),
  isProviderApiKeyConfiguredMock: vi.fn<
    (params: { provider: string; agentDir?: string }) => boolean
  >(() => false),
  listProfilesForProviderMock: vi.fn(
    (store: { profiles?: Record<string, { provider?: string }> }, provider: string) =>
      Object.entries(store.profiles ?? {})
        .filter(([, profile]) => profile.provider === provider)
        .map(([profileId]) => profileId),
  ),
  resolveApiKeyForProviderMock: vi.fn(
    async (_params?: {
      provider?: string;
    }): Promise<{ apiKey?: string; source?: string; mode?: string }> => ({
      apiKey: "openai-key",
    }),
  ),
  postJsonRequestMock: vi.fn(),
  postMultipartRequestMock: vi.fn(),
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
  resolveProviderHttpRequestConfigMock: vi.fn((params) => {
    const headers = new Headers(params.defaultHeaders);
    new Headers(params.headers).forEach((value, key) => headers.set(key, value));
    return {
      baseUrl: params.baseUrl ?? params.defaultBaseUrl,
      allowPrivateNetwork: Boolean(
        params.allowPrivateNetwork ?? params.request?.allowPrivateNetwork,
      ),
      headers,
      dispatcherPolicy: undefined,
    };
  }),
  sanitizeConfiguredModelProviderRequestMock: vi.fn((request) => request),
  logInfoMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth")>()),
  ensureAuthProfileStore: ensureAuthProfileStoreMock,
  isProviderApiKeyConfigured: isProviderApiKeyConfiguredMock,
  listProfilesForProvider: listProfilesForProviderMock,
}));

// mock-isolation: Resolve synthetic credentials without loading real provider credential stores.
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>()),
  assertOkOrThrowHttpError: assertOkOrThrowHttpErrorMock,
  postJsonRequest: postJsonRequestMock,
  postMultipartRequest: postMultipartRequestMock,
  // Pass-through: bounded-reader enforcement is tested via bounded-reader unit tests.
  readProviderJsonResponse: async (response: { json(): Promise<unknown> }) => response.json(),
  resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
  sanitizeConfiguredModelProviderRequest: sanitizeConfiguredModelProviderRequestMock,
}));

// mock-isolation: Capture provider diagnostics without initializing the global logging backend.
vi.mock("openclaw/plugin-sdk/logging-core", () => ({
  createSubsystemLogger: vi.fn(() => ({
    info: logInfoMock,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

const noopRelease = async () => {};

export {
  ensureAuthProfileStoreMock,
  isProviderApiKeyConfiguredMock,
  listProfilesForProviderMock,
  resolveApiKeyForProviderMock,
  postJsonRequestMock,
  postMultipartRequestMock,
  assertOkOrThrowHttpErrorMock,
  resolveProviderHttpRequestConfigMock,
  sanitizeConfiguredModelProviderRequestMock,
  logInfoMock,
};

const generatedPngRequest = {
  response: {
    json: async () => ({ data: [{ b64_json: Buffer.from("png-bytes").toString("base64") }] }),
  },
  release: noopRelease,
};

export function mockGeneratedPngResponse() {
  postJsonRequestMock.mockResolvedValue(generatedPngRequest);
  postMultipartRequestMock.mockResolvedValue(generatedPngRequest);
}

export function mockCodexRawStream(body: string) {
  postJsonRequestMock.mockImplementation(async () => ({
    response: new Response(body),
    release: noopRelease,
  }));
}

export function mockCodexEvents(events: unknown[]) {
  mockCodexRawStream(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
}

export function imageItem(
  result: string | null = Buffer.from("codex-image").toString("base64"),
  status?: string,
) {
  return { type: "image_generation_call", result, ...(status ? { status } : {}) };
}

export function done(item = imageItem()) {
  return { type: "response.output_item.done", item };
}

export function completed(output: unknown[] = []) {
  return { type: "response.completed", response: { output } };
}

export function mockCodexImageStream() {
  mockCodexEvents([done(), completed()]);
}

export function mockCodexAuthOnly() {
  resolveApiKeyForProviderMock.mockImplementation(async (params?: { provider?: string }) =>
    params?.provider === "openai"
      ? { apiKey: "codex-key", source: "profile:openai:default", mode: "oauth" }
      : {},
  );
}

type MockWithCalls = {
  mock: {
    calls: readonly (readonly unknown[])[];
  };
};

type HttpConfigCall = {
  allowPrivateNetwork?: boolean;
  api?: string;
  baseUrl?: string;
  capability?: string;
  defaultBaseUrl?: string;
  defaultHeaders?: Record<string, string>;
  provider?: string;
  request?: unknown;
};

export type RequestCall = {
  allowPrivateNetwork?: boolean;
  body?: unknown;
  dispatcherPolicy?: unknown;
  fetchFn?: typeof fetch;
  headers?: Headers;
  ssrfPolicy?: unknown;
  timeoutMs?: number;
  url?: string;
};

export type AuthResolutionCall = {
  cfg?: {
    models?: {
      providers?: {
        openai?: {
          auth?: string;
        };
      };
    };
  };
  credentialPrecedence?: string;
  provider?: string;
  store?: unknown;
};

function mockCallArg(mock: MockWithCalls, callIndex = 0, argIndex = 0): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  if (call.length <= argIndex) {
    throw new Error(`Expected mock call ${callIndex} argument ${argIndex}`);
  }
  return call[argIndex];
}

export function jsonRequestCall(callIndex = 0): RequestCall {
  return mockCallArg(postJsonRequestMock, callIndex) as RequestCall;
}

export function multipartRequestCall(callIndex = 0): RequestCall {
  return mockCallArg(postMultipartRequestMock, callIndex) as RequestCall;
}

export function httpConfigCall(callIndex = 0): HttpConfigCall {
  return mockCallArg(resolveProviderHttpRequestConfigMock, callIndex) as HttpConfigCall;
}

export function authResolutionCall(callIndex = 0): AuthResolutionCall {
  return mockCallArg(resolveApiKeyForProviderMock, callIndex) as AuthResolutionCall;
}

export function setupImageGenerationProviderTests() {
  const provider = buildOpenAIImageGenerationProvider({
    ensureAuthProfileStore: ensureAuthProfileStoreMock,
    listProfilesForProvider: listProfilesForProviderMock,
    isProviderApiKeyConfigured: isProviderApiKeyConfiguredMock,
  });
  const emptyConfig: OpenClawConfig = {};
  type OpenAIImageRequest = Parameters<typeof provider.generateImage>[0];
  const generateOpenAIImage = (
    prompt: string,
    request: Omit<Partial<OpenAIImageRequest>, "prompt" | "provider"> = {},
  ) =>
    provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt,
      cfg: emptyConfig,
      ...request,
    });

  afterEach(() => {
    ensureAuthProfileStoreMock.mockReset();
    ensureAuthProfileStoreMock.mockReturnValue({ version: 1, profiles: {} });
    isProviderApiKeyConfiguredMock.mockReset();
    isProviderApiKeyConfiguredMock.mockReturnValue(false);
    listProfilesForProviderMock.mockClear();
    resolveApiKeyForProviderMock.mockReset();
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "openai-key" });
    postJsonRequestMock.mockReset();
    postMultipartRequestMock.mockReset();
    assertOkOrThrowHttpErrorMock.mockClear();
    resolveProviderHttpRequestConfigMock.mockClear();
    sanitizeConfiguredModelProviderRequestMock.mockClear();
    logInfoMock.mockClear();
    vi.unstubAllEnvs();
  });

  beforeEach(mockGeneratedPngResponse);

  return { provider, generateOpenAIImage };
}
