import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  completed,
  done,
  httpConfigCall,
  imageItem,
  jsonRequestCall,
  logInfoMock,
  mockCodexAuthOnly,
  mockCodexEvents,
  mockCodexImageStream,
  mockCodexRawStream,
  postJsonRequestMock,
  postMultipartRequestMock,
  resolveApiKeyForProviderMock,
  sanitizeConfiguredModelProviderRequestMock,
  setupImageGenerationProviderTests,
} from "./image-generation-provider.test-mocks.js";
import {
  createCodexOAuthAuthStore,
  createMixedOpenAIAuthStore,
  openAIImageConfig,
} from "./image-generation-provider.test-support.js";

describe("openai image generation provider: Codex Responses", () => {
  const { generateOpenAIImage } = setupImageGenerationProviderTests();
  beforeEach(() => {
    mockCodexAuthOnly();
    mockCodexImageStream();
  });

  it.each(["gpt-image-2", "gpt-image-2-2026-04-21"])(
    "preserves supported flexible dimensions for %s through Codex OAuth",
    async (model) => {
      const result = await generateOpenAIImage("A portrait illustration", {
        model,
        size: "2048x2560",
      });

      expect(jsonRequestCall().body).toMatchObject({
        tools: [{ type: "image_generation", model, size: "2048x2560", action: "generate" }],
      });
      expect(result.metadata).not.toHaveProperty("normalizedSize");
    },
  );

  it("uses the previous output as the source for a subsequent Codex edit", async () => {
    const first = await generateOpenAIImage("Change the background to blue", {
      size: "2048x2560",
      inputImages: [{ buffer: Buffer.from("source-image"), mimeType: "image/png" }],
    });
    const previousImage = first.images[0];
    if (!previousImage) {
      throw new Error("Expected the first edit to return an image for the next edit.");
    }
    mockCodexEvents([
      done(imageItem(Buffer.from("revised-image").toString("base64"))),
      completed(),
    ]);
    const second = await generateOpenAIImage("Keep the background and add a small star", {
      size: "2048x2560",
      inputImages: [previousImage],
    });

    expect(jsonRequestCall(1).body).toMatchObject({
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Keep the background and add a small star" },
            {
              type: "input_image",
              image_url: "data:image/png;base64,Y29kZXgtaW1hZ2U=",
              detail: "auto",
            },
          ],
        },
      ],
      tools: [{ type: "image_generation", size: "2048x2560", action: "edit" }],
    });
    expect(second.images[0]?.buffer).toEqual(Buffer.from("revised-image"));
    expect(postMultipartRequestMock).not.toHaveBeenCalled();
  });

  it("serializes reference-image requests and caps the per-image Responses calls", async () => {
    mockCodexEvents([
      {
        type: "response.output_item.done",
        item: { ...imageItem(), revised_prompt: "revised prompt" },
      },
      {
        type: "response.completed",
        response: {
          usage: { total_tokens: 30 },
          tool_usage: { image_gen: { total_tokens: 30 } },
        },
      },
    ]);
    const result = await generateOpenAIImage("Use the reference", {
      authStore: { version: 1, profiles: {} },
      count: 12,
      size: "1024x1536",
      quality: "low",
      outputFormat: "jpeg",
      inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
      providerOptions: {
        openai: { background: "opaque", moderation: "low", outputCompression: 55 },
      },
    });
    expect(postJsonRequestMock).toHaveBeenCalledTimes(4);
    expect(jsonRequestCall()).toMatchObject({
      url: "https://chatgpt.com/backend-api/codex/responses",
      timeoutMs: 180_000,
      body: {
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Use the reference" },
              {
                type: "input_image",
                image_url: "data:image/png;base64,cG5nLWJ5dGVz",
                detail: "auto",
              },
            ],
          },
        ],
        instructions: "You are an image generation assistant.",
        stream: true,
        store: false,
        tools: [
          {
            type: "image_generation",
            model: "gpt-image-2",
            action: "edit",
            size: "1024x1536",
            quality: "low",
            output_format: "jpeg",
            background: "opaque",
            moderation: "low",
            output_compression: 55,
          },
        ],
        tool_choice: { type: "image_generation" },
      },
    });
    expect(jsonRequestCall().headers?.get("authorization")).toBe("Bearer codex-key");
    expect(result.images.map((image) => image.fileName)).toEqual([
      "image-1.jpg",
      "image-2.jpg",
      "image-3.jpg",
      "image-4.jpg",
    ]);
    expect(result.images[0]).toEqual({
      buffer: Buffer.from("codex-image"),
      mimeType: "image/jpeg",
      fileName: "image-1.jpg",
      revisedPrompt: "revised prompt",
    });
    expect(result.metadata?.responses).toEqual(
      Array.from({ length: 4 }, () => ({
        usage: { total_tokens: 30 },
        toolUsage: { image_gen: { total_tokens: 30 } },
      })),
    );
    expect(postMultipartRequestMock).not.toHaveBeenCalled();
  });

  it("honors configured transport overrides for transparent PNG requests", async () => {
    const result = await generateOpenAIImage("Transparent sticker", {
      cfg: openAIImageConfig({
        baseUrl: "http://127.0.0.1:44220/backend-api/codex",
        api: "openai-chatgpt-responses",
        request: { allowPrivateNetwork: true },
      }),
      authStore: createCodexOAuthAuthStore(),
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
      outputFormat: "png",
      providerOptions: { openai: { background: "transparent", outputCompression: 55 } },
    });
    expect(sanitizeConfiguredModelProviderRequestMock).toHaveBeenCalledWith({
      allowPrivateNetwork: true,
    });
    expect(jsonRequestCall()).toMatchObject({
      url: "http://127.0.0.1:44220/backend-api/codex/responses",
      allowPrivateNetwork: true,
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
    });
    expect(jsonRequestCall().body).toHaveProperty("tools", [
      {
        type: "image_generation",
        action: "generate",
        model: "gpt-image-1.5",
        size: "1024x1024",
        output_format: "png",
        background: "transparent",
      },
    ]);
    expect(result.model).toBe("gpt-image-1.5");
  });

  it("canonicalizes a legacy Codex endpoint", async () => {
    await generateOpenAIImage("Legacy endpoint", {
      cfg: openAIImageConfig({
        baseUrl: "https://chatgpt.com/backend-api/codex/v1",
        api: "openai-chatgpt-responses",
      }),
      authStore: createMixedOpenAIAuthStore(),
    });
    expect(resolveApiKeyForProviderMock).toHaveBeenCalledOnce();
    expect(httpConfigCall()).toMatchObject({
      baseUrl: "https://chatgpt.com/backend-api/codex",
      provider: "openai",
      api: "openai-chatgpt-responses",
      capability: "image",
    });
    expect(jsonRequestCall().url).toBe("https://chatgpt.com/backend-api/codex/responses");
  });

  it("sanitizes auth logs and truncates without splitting surrogate pairs", async () => {
    resolveApiKeyForProviderMock.mockResolvedValue({
      apiKey: "codex-key",
      mode: "oauth\nfake\u202eignored",
    });
    await generateOpenAIImage("Safe logs", {
      model: `${"a".repeat(255)}😀tail`,
      authStore: createCodexOAuthAuthStore(),
    });
    expect(logInfoMock).toHaveBeenCalledWith(
      expect.stringContaining(
        `mode=oauth fakeignored transport=codex-responses requestedModel=${"a".repeat(255)}... responsesModel=`,
      ),
    );
  });

  it("uses completed image bytes and metadata instead of malformed interim data", async () => {
    mockCodexEvents([
      done(imageItem("not valid base64")),
      {
        type: "response.completed",
        response: {
          output: [{ ...imageItem(), revised_prompt: "completed prompt" }],
          usage: { input_tokens: 11, output_tokens: 22, total_tokens: 33 },
        },
      },
    ]);
    const result = await generateOpenAIImage("Completed image");
    expect(result.images).toEqual([
      {
        buffer: Buffer.from("codex-image"),
        mimeType: "image/png",
        fileName: "image-1.png",
        revisedPrompt: "completed prompt",
      },
    ]);
    expect(result.metadata).toEqual({
      responses: [
        {
          usage: { input_tokens: 11, output_tokens: 22, total_tokens: 33 },
          toolUsage: undefined,
        },
      ],
    });
  });

  it("parses multiline SSE without optional spaces and trims Unicode image whitespace", async () => {
    const event = JSON.stringify(done(imageItem("\u0085aGVsbG8=\u0085")));
    mockCodexRawStream(
      `data:${event.replace(',"item":', ',\ndata:"item":')}\n\ndata:${JSON.stringify(completed())}\n\n`,
    );
    expect((await generateOpenAIImage("Framed image")).images[0]?.buffer).toEqual(
      Buffer.from("hello"),
    );
  });

  it.each([
    {
      name: "authoritative failure after malformed interim data",
      events: [
        done(imageItem("invalid base64")),
        {
          type: "response.failed",
          response: { error: { code: "rate_limit_exceeded", message: "quota was exhausted" } },
        },
      ],
      error: /quota was exhausted/,
    },
    {
      name: "incomplete turn",
      events: [
        {
          type: "response.incomplete",
          response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
        },
      ],
      error: /incomplete.*max_output_tokens/i,
    },
    {
      name: "stream closed before completion",
      events: [done()],
      error: /closed before response\.completed/i,
    },
  ])("rejects $name", async ({ events, error }) => {
    mockCodexEvents(events);
    await expect(generateOpenAIImage("Rejected turn")).rejects.toThrow(error);
  });

  it.each([
    { status: "completed", result: null, error: /did not produce an image/i },
    {
      status: "failed",
      result: Buffer.from("failed-image").toString("base64"),
      error: /image call did not complete/i,
    },
  ])(
    "rejects authoritative $status output instead of using a stale interim image",
    async ({ status, result, error }) => {
      mockCodexEvents([
        done(imageItem(undefined, "completed")),
        completed([imageItem(result, status)]),
      ]);
      await expect(generateOpenAIImage("Authoritative output")).rejects.toThrow(error);
    },
  );

  it.each([
    {
      name: "invalid alphabet in completed output",
      events: [completed([imageItem("aGVs!bG8=")])],
    },
    {
      name: "noncanonical trailing bits in interim output",
      events: [done(imageItem("Zh==")), completed()],
    },
  ])("rejects $name", async ({ events }) => {
    mockCodexEvents(events);
    await expect(generateOpenAIImage("Malformed image")).rejects.toThrow(
      "OpenAI Codex image generation returned malformed base64 image data",
    );
  });

  it("cancels oversized Codex OAuth image response streams", async () => {
    let canceled = false;
    let chunkSent = false;
    const release = vi.fn(async () => {});
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunkSent) {
          return;
        }
        chunkSent = true;
        controller.enqueue(new Uint8Array(64 * 1024 * 1024 + 1));
      },
      cancel() {
        canceled = true;
      },
    });
    postJsonRequestMock.mockResolvedValue({
      response: new Response(stream),
      release,
    });

    await expect(
      generateOpenAIImage("Draw an oversized Codex lighthouse", {
        authStore: createCodexOAuthAuthStore(),
      }),
    ).rejects.toThrow("OpenAI Codex image generation response exceeded size limit");
    expect(canceled).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects streams exceeding the SSE event limit", async () => {
    mockCodexEvents(
      Array.from({ length: 513 }, (_, index) => ({
        type: "response.output_text.delta",
        delta: String(index),
      })),
    );
    await expect(generateOpenAIImage("Noisy stream")).rejects.toThrow(
      "OpenAI Codex image generation response exceeded event limit",
    );
  });
});
