import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { AuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import { describe, expect, it, vi } from "vitest";
import {
  assertOkOrThrowHttpErrorMock,
  authResolutionCall,
  type AuthResolutionCall,
  httpConfigCall,
  jsonRequestCall,
  logInfoMock,
  mockCodexAuthOnly,
  mockCodexImageStream,
  mockGeneratedPngResponse,
  multipartRequestCall,
  postJsonRequestMock,
  postMultipartRequestMock,
  type RequestCall,
  resolveApiKeyForProviderMock,
  setupImageGenerationProviderTests,
} from "./image-generation-provider.test-mocks.js";
import {
  createCodexApiKeyAuthStore,
  createCodexOAuthAuthStore,
  createCodexTokenAuthStore,
  createMixedCodexAuthStore,
  createMixedOpenAIAuthStore,
  openAIImageConfig,
} from "./image-generation-provider.test-support.js";

describe("openai image generation provider", () => {
  const { provider, generateOpenAIImage } = setupImageGenerationProviderTests();

  it.each(["none", "codex", "api-key"] as const)(
    "selects an image-capable credential with SIWC first and %s configured",
    async (additional) => {
      vi.stubEnv("OPENAI_API_KEY", "");
      const store: AuthProfileStore = {
        version: 1,
        profiles: {
          "openai:siwc": {
            type: "oauth",
            provider: "openai",
            authFlow: "chatgpt-token-sharing",
            access: "siwc-access",
            refresh: "siwc-refresh",
            expires: Date.now() + 3_600_000,
          },
          ...(additional === "codex"
            ? createCodexTokenAuthStore().profiles
            : additional === "api-key"
              ? createCodexApiKeyAuthStore().profiles
              : {}),
        },
      };
      const realAuth = await vi.importActual<
        typeof import("openclaw/plugin-sdk/provider-auth-runtime")
      >("openclaw/plugin-sdk/provider-auth-runtime");
      resolveApiKeyForProviderMock.mockImplementation((params) =>
        realAuth.resolveApiKeyForProvider({ ...params, provider: "openai", store }),
      );
      if (additional === "api-key") {
        mockGeneratedPngResponse();
      } else {
        mockCodexImageStream();
      }
      const request = generateOpenAIImage("Draw an avatar", {
        authStore: store,
        cfg: { auth: { order: { openai: Object.keys(store.profiles) } } },
      });
      if (additional === "none") {
        await expect(request).rejects.toThrow("OpenAI API key or Codex OAuth missing");
        expect(postJsonRequestMock).not.toHaveBeenCalled();
        expect(postMultipartRequestMock).not.toHaveBeenCalled();
        return;
      }
      expect((await request).images).toHaveLength(1);
      const call = jsonRequestCall();
      expect(new Headers(call.headers).get("authorization")).toBe(
        `Bearer ${additional === "codex" ? "codex-token" : "codex-api-key"}`,
      );
      expect(call.url).toBe(
        additional === "codex"
          ? "https://chatgpt.com/backend-api/codex/responses"
          : "https://api.openai.com/v1/images/generations",
      );
    },
  );

  it.each([false, true])(
    "sets private-network permission from browser opt-in: %s",
    async (allow) => {
      const cfg = openAIImageConfig({
        baseUrl: "http://127.0.0.1:44080/v1",
        ...(allow ? { apiKey: "local-noauth" } : {}),
      });
      if (allow) {
        cfg.browser = { ssrfPolicy: { dangerouslyAllowPrivateNetwork: true } };
      }
      const result = await generateOpenAIImage("Private endpoint", {
        cfg,
        ssrfPolicy: { allowRfc2544BenchmarkRange: true },
      });
      expect(jsonRequestCall()).toMatchObject({
        url: "http://127.0.0.1:44080/v1/images/generations",
        allowPrivateNetwork: allow,
        ssrfPolicy: { allowRfc2544BenchmarkRange: true },
      });
      expect(result.images).toHaveLength(1);
    },
  );

  it("allows loopback for the synthetic mock-openai provider", async () => {
    await provider.generateImage({
      provider: "mock-openai",
      model: "gpt-image-2",
      prompt: "QA lighthouse",
      cfg: openAIImageConfig({ baseUrl: "http://127.0.0.1:44080/v1" }),
    });
    expect(jsonRequestCall()).toMatchObject({
      url: "http://127.0.0.1:44080/v1/images/generations",
      allowPrivateNetwork: true,
    });
  });

  it("uses a model-specific QA image endpoint without changing the text provider route", async () => {
    mockGeneratedPngResponse();
    vi.stubEnv("OPENCLAW_QA_ALLOW_LOCAL_IMAGE_PROVIDER", "1");

    await generateOpenAIImage("Draw a QA lighthouse", {
      model: "gpt-image-1",
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              models: [
                {
                  id: "gpt-image-1",
                  name: "gpt-image-1",
                  api: "openai-responses",
                  baseUrl: "http://127.0.0.1:44080/v1",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128_000,
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
      },
    });

    expect(httpConfigCall().baseUrl).toBe("http://127.0.0.1:44080/v1");
    expect(jsonRequestCall().url).toBe("http://127.0.0.1:44080/v1/images/generations");
    expect(jsonRequestCall().allowPrivateNetwork).toBe(true);
  });

  it("serializes a direct JPEG generation request and decodes its image", async () => {
    const result = await generateOpenAIImage("Landscape preview", {
      count: 2,
      size: "1024x640",
      quality: "low",
      outputFormat: "jpeg",
      providerOptions: {
        openai: {
          background: "opaque",
          moderation: "low",
          outputCompression: 60,
          user: "end-user-42",
        },
      },
    });
    expect(jsonRequestCall().url).toBe("https://api.openai.com/v1/images/generations");
    expect(jsonRequestCall().body).toEqual({
      model: "gpt-image-2",
      prompt: "Landscape preview",
      n: 2,
      size: "1024x640",
      quality: "low",
      output_format: "jpeg",
      background: "opaque",
      moderation: "low",
      output_compression: 60,
      user: "end-user-42",
    });
    expect(result).toEqual({
      model: "gpt-image-2",
      images: [
        { buffer: Buffer.from("png-bytes"), mimeType: "image/jpeg", fileName: "image-1.jpg" },
      ],
    });
  });
  describe("when OpenAI chat models are configured", () => {
    const configuredOpenAIFallback: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-sonnet-4-6",
            fallbacks: ["openai/gpt-6-luna"],
          },
        },
      },
    };

    it("keeps the default Codex OAuth image model while the account accepts it", async () => {
      mockCodexAuthOnly();
      mockCodexImageStream();

      const result = await generateOpenAIImage("Draw with the default model", {
        authStore: { version: 1, profiles: {} },
        cfg: configuredOpenAIFallback,
      });

      expect(postJsonRequestMock).toHaveBeenCalledTimes(1);
      expect((jsonRequestCall().body as Record<string, unknown>).model).toBe("gpt-6-astra");
      expect(result.images[0]?.buffer).toEqual(Buffer.from("codex-image"));
    });

    it.each(["", "x-request-id", "request-id"])("retries rejection (%s)", async (header) => {
      mockCodexAuthOnly();
      mockCodexImageStream();
      const { assertOkOrThrowHttpError } = await vi.importActual<
        typeof import("openclaw/plugin-sdk/provider-http")
      >("openclaw/plugin-sdk/provider-http");
      assertOkOrThrowHttpErrorMock.mockImplementationOnce(() =>
        assertOkOrThrowHttpError(
          new Response(
            JSON.stringify({
              detail:
                "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.",
            }),
            { status: 400, headers: header ? { [header]: "req-image-proof" } : {} },
          ),
          "OpenAI Codex image generation failed",
        ),
      );

      const result = await generateOpenAIImage("Draw with the configured ChatGPT model", {
        authStore: { version: 1, profiles: {} },
        cfg: configuredOpenAIFallback,
        count: 2,
      });

      expect(
        postJsonRequestMock.mock.calls.map(
          ([call]) => ((call as RequestCall).body as Record<string, unknown>).model,
        ),
      ).toEqual(["gpt-6-astra", "gpt-6-luna", "gpt-6-luna"]);
      expect(logInfoMock).toHaveBeenCalledWith(
        "codex image responses model unavailable: responsesModel=gpt-6-astra retryResponsesModel=gpt-6-luna",
      );
      expect(result.images.map((image) => image.buffer)).toEqual([
        Buffer.from("codex-image"),
        Buffer.from("codex-image"),
      ]);
    });

    it.each([
      "Invalid image size",
      "Unknown model",
      "The 'gpt-6-astra' model does not support image generation.",
    ])("does not retry an unrelated HTTP 400: %s", async (detail) => {
      mockCodexAuthOnly();
      mockCodexImageStream();
      const error = new Error(`OpenAI Codex image generation failed (HTTP 400): ${detail}`);
      assertOkOrThrowHttpErrorMock.mockRejectedValueOnce(error);
      await expect(
        generateOpenAIImage("Draw an image", { cfg: configuredOpenAIFallback }),
      ).rejects.toThrow(error);
      expect(postJsonRequestMock).toHaveBeenCalledTimes(1);
    });
  });

  it("preserves automatic dimensions for models that support them", async () => {
    const result = await generateOpenAIImage("Automatic dimensions", {
      model: "gpt-image-2.5-sunburst",
      size: "auto",
    });
    expect(jsonRequestCall().body).toMatchObject({ model: "gpt-image-2.5-sunburst", size: "auto" });
    expect(result.metadata).toBeUndefined();
  });

  it.each(["1024x624", "1025x1024", "3088x1024", "4096x2048", "2896x2896"])(
    "normalizes unsupported flexible-model dimensions %s",
    async (size) => {
      mockGeneratedPngResponse();

      const result = await generateOpenAIImage("Normalize unsupported image dimensions", {
        size,
      });

      const normalizedSize = (jsonRequestCall().body as { size: string }).size;
      expect(normalizedSize).not.toBe(size);
      expect(provider.capabilities.geometry?.sizes).toContain(normalizedSize);
      expect(result.metadata).toEqual({ requestedSize: size, normalizedSize });
    },
  );

  it("normalizes legacy native image dimensions", async () => {
    const result = await generateOpenAIImage("Wide image", {
      model: "gpt-image-1",
      size: "2048x1152",
    });
    expect(jsonRequestCall().body).toMatchObject({ model: "gpt-image-1", size: "1536x1024" });
    expect(result.metadata).toEqual({ requestedSize: "2048x1152", normalizedSize: "1536x1024" });
  });

  it("preserves custom-endpoint model and geometry choices", async () => {
    const result = await generateOpenAIImage("Transparent custom image", {
      cfg: openAIImageConfig({ baseUrl: "https://openai-compatible.example.com/v1" }),
      size: "1024x624",
      outputFormat: "png",
      background: "transparent",
    });
    expect(jsonRequestCall().url).toBe(
      "https://openai-compatible.example.com/v1/images/generations",
    );
    expect(jsonRequestCall().body).toMatchObject({
      model: "gpt-image-2",
      size: "1024x624",
      background: "transparent",
    });
    expect(result.metadata).toBeUndefined();
  });

  it("falls back to the provider baseUrl when the model catalog is omitted", async () => {
    mockGeneratedPngResponse();

    // Plugin-scoped runtime snapshots can carry a built-in provider overlay
    // before its model catalog is present.
    const cfg = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://openai-compatible.example.com/v1",
          },
        },
      },
    } as unknown as OpenClawConfig;
    const result = await generateOpenAIImage("Create an image through a provider overlay", {
      cfg,
    });

    expect(httpConfigCall().baseUrl).toBe("https://openai-compatible.example.com/v1");
    expect(jsonRequestCall().url).toBe(
      "https://openai-compatible.example.com/v1/images/generations",
    );
    expect(result.images).toHaveLength(1);
  });

  it("routes transparent PNG generation to the alpha-capable model without compression", async () => {
    const result = await generateOpenAIImage("Transparent sticker", {
      outputFormat: "png",
      background: "transparent",
      providerOptions: { openai: { outputCompression: 60 } },
    });
    expect(jsonRequestCall().body).toEqual({
      model: "gpt-image-1.5",
      prompt: "Transparent sticker",
      n: 1,
      size: "1024x1024",
      output_format: "png",
      background: "transparent",
    });
    expect(result.model).toBe("gpt-image-1.5");
  });

  it("serializes multipart edits with reference names, geometry, output options, and SSRF policy", async () => {
    const result = await generateOpenAIImage("Edit as WebP", {
      model: "gpt-image-2-2026-04-21",
      count: 2,
      size: "864x1536",
      quality: "high",
      outputFormat: "webp",
      cfg: openAIImageConfig({ baseUrl: "http://127.0.0.1:44080/v1" }),
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
      inputImages: [
        { buffer: Buffer.from("png-bytes"), mimeType: "image/png", fileName: "reference.png" },
        { buffer: Buffer.from("jpeg-bytes"), mimeType: "image/jpeg" },
      ],
      providerOptions: {
        openai: {
          background: "transparent",
          moderation: "low",
          outputCompression: 75,
          user: "end-user-99",
        },
      },
    });
    const request = multipartRequestCall();
    expect(request).toMatchObject({
      url: "http://127.0.0.1:44080/v1/images/edits",
      allowPrivateNetwork: false,
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
      dispatcherPolicy: undefined,
      fetchFn: fetch,
    });
    expect(request.headers?.has("Content-Type")).toBe(false);
    const form = request.body;
    expect(form).toBeInstanceOf(FormData);
    if (!(form instanceof FormData)) {
      throw new Error("Expected multipart edit");
    }
    expect(Object.fromEntries([...form].filter(([key]) => key !== "image[]"))).toEqual({
      model: "gpt-image-2-2026-04-21",
      prompt: "Edit as WebP",
      n: "2",
      size: "864x1536",
      quality: "high",
      output_format: "webp",
      background: "transparent",
      moderation: "low",
      output_compression: "75",
      user: "end-user-99",
    });
    expect(form.getAll("image[]")).toEqual([
      expect.objectContaining({ name: "reference.png", type: "image/png" }),
      expect.objectContaining({ name: "image-2.jpg", type: "image/jpeg" }),
    ]);
    expect(postJsonRequestMock).not.toHaveBeenCalled();
    expect(result.images[0]).toEqual({
      buffer: Buffer.from("png-bytes"),
      mimeType: "image/webp",
      fileName: "image-1.webp",
    });
  });

  it("uses native images when mixed subscription profiles resolve to an API key", async () => {
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "codex-api-key", mode: "api-key" });
    await generateOpenAIImage("Selected API key", { authStore: createMixedCodexAuthStore() });
    expect(resolveApiKeyForProviderMock).toHaveBeenCalledOnce();
    expect(jsonRequestCall().url).toBe("https://api.openai.com/v1/images/generations");
    expect(jsonRequestCall().headers?.get("authorization")).toBe("Bearer codex-api-key");
    expect(logInfoMock).not.toHaveBeenCalled();
  });

  it("forces explicit API-key config through native image auth", async () => {
    resolveApiKeyForProviderMock.mockImplementation(async (params?: AuthResolutionCall) =>
      params?.cfg?.models?.providers?.openai?.auth === "api-key"
        ? { apiKey: "configured-openai-key", mode: "api-key" }
        : { apiKey: "chatgpt-oauth-token", mode: "oauth" },
    );
    const authStore = createMixedOpenAIAuthStore();
    await generateOpenAIImage("Explicit API key", {
      cfg: openAIImageConfig({ apiKey: "sk-configured", baseUrl: "https://api.openai.com/v1" }),
      authStore,
    });
    expect(resolveApiKeyForProviderMock).toHaveBeenCalledOnce();
    expect(authResolutionCall()).toMatchObject({
      provider: "openai",
      store: authStore,
      credentialPrecedence: "env-first",
      cfg: { models: { providers: { openai: { auth: "api-key" } } } },
    });
    expect(jsonRequestCall().url).toBe("https://api.openai.com/v1/images/generations");
    expect(jsonRequestCall().headers?.get("authorization")).toBe("Bearer configured-openai-key");
    expect(logInfoMock).not.toHaveBeenCalled();
  });

  it.each(["https://openai-compatible.example.test/v1", "https://api.openai.com/v1?proxy=1"])(
    "does not send subscription credentials to %s",
    async (baseUrl) => {
      mockCodexAuthOnly();
      await expect(
        generateOpenAIImage("Custom endpoint", { cfg: openAIImageConfig({ baseUrl }) }),
      ).rejects.toThrow("OpenAI API key missing");
      expect(postJsonRequestMock).not.toHaveBeenCalled();
      expect(postMultipartRequestMock).not.toHaveBeenCalled();
    },
  );

  it("propagates unexpected auth failures without making a request", async () => {
    resolveApiKeyForProviderMock.mockRejectedValue(new Error("Keychain unavailable"));
    await expect(generateOpenAIImage("Auth error")).rejects.toThrow("Keychain unavailable");
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("keeps explicit OpenAI request settings on the native transport", async () => {
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "openai-key", mode: "api-key" });
    await generateOpenAIImage("Explicit settings", {
      cfg: openAIImageConfig({
        baseUrl: "https://api.openai.com/v1",
        api: "openai-responses",
        headers: { "X-Test-OpenAI": "direct" },
        request: { allowPrivateNetwork: true },
      }),
      authStore: createCodexOAuthAuthStore(),
    });
    expect(resolveApiKeyForProviderMock).toHaveBeenCalledOnce();
    expect(httpConfigCall()).toMatchObject({
      api: "openai-responses",
      request: { allowPrivateNetwork: true },
    });
    expect(jsonRequestCall().url).toBe("https://api.openai.com/v1/images/generations");
    expect(jsonRequestCall().headers?.get("X-Test-OpenAI")).toBe("direct");
  });

  it("uses Azure deployment-scoped JSON requests and its default timeout", async () => {
    await generateOpenAIImage("Transparent Azure sticker", {
      cfg: openAIImageConfig({ baseUrl: "https://myresource.openai.azure.com/openai/v1" }),
      outputFormat: "png",
      background: "transparent",
    });
    expect(jsonRequestCall()).toMatchObject({
      url: "https://myresource.openai.azure.com/openai/deployments/gpt-image-2/images/generations?api-version=2024-12-01-preview",
      timeoutMs: 600_000,
      body: {
        prompt: "Transparent Azure sticker",
        n: 1,
        size: "1024x1024",
        output_format: "png",
        background: "transparent",
      },
    });
    expect(jsonRequestCall().body).not.toHaveProperty("model");
    expect(jsonRequestCall().headers?.get("api-key")).toBe("openai-key");
    expect(jsonRequestCall().headers?.has("authorization")).toBe(false);
  });

  it("uses Azure deployment-scoped multipart requests with explicit version and timeout", async () => {
    vi.stubEnv("AZURE_OPENAI_API_VERSION", "2025-01-01");
    await generateOpenAIImage("Change background", {
      model: "gpt-image-2-1",
      timeoutMs: 123_456,
      cfg: openAIImageConfig({ baseUrl: "https://myresource.services.ai.azure.com/v1" }),
      inputImages: [
        { buffer: Buffer.from("png-bytes"), mimeType: "image/png", fileName: "reference.png" },
      ],
    });
    const request = multipartRequestCall();
    expect(request).toMatchObject({
      url: "https://myresource.services.ai.azure.com/openai/deployments/gpt-image-2-1/images/edits?api-version=2025-01-01",
      timeoutMs: 123_456,
    });
    expect(request.headers?.get("api-key")).toBe("openai-key");
    if (!(request.body instanceof FormData)) {
      throw new Error("Expected multipart edit");
    }
    expect(request.body.has("model")).toBe(false);
    expect(request.body.get("prompt")).toBe("Change background");
    expect(request.body.get("size")).toBe("1024x1024");
  });
});
