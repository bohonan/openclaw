import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it } from "vitest";
import { codexTestTurnIds } from "./codex-app-server.test-fixtures.js";
import {
  createFakeClient,
  createOpenClawCodingToolsMock,
  getSharedCodexAppServerClientMock,
  runCodexAppServerSideQuestion,
  runSideQuestionWithManagedWebSearchCall,
  sideParams,
  toolExecuteMock,
  turnCompleted,
} from "./side-question.test-support.js";

/** Reuse the side-question owner's tool bridge setup and cleanup for route policy. */
export function registerSideQuestionToolPolicyTests() {
  it("disables hosted search when side-question sender policy removes managed web_search", async () => {
    createOpenClawCodingToolsMock.mockImplementation((options: { senderId?: string }) =>
      options.senderId === "restricted-sender"
        ? []
        : [
            {
              name: "web_search",
              description: "Search the web",
              parameters: { type: "object", properties: {}, additionalProperties: true },
              execute: toolExecuteMock,
            },
          ],
    );

    const { forkConfig } = await runSideQuestionWithManagedWebSearchCall(
      sideParams({ senderId: "restricted-sender" }),
      { preserveToolFactory: true },
    );

    expect(forkConfig).toMatchObject({
      "features.standalone_web_search": false,
      web_search: "disabled",
    });
  });

  it("keeps configured image generation available through the managed tool in side forks", async () => {
    const turnStarted = createDeferred<void>();
    const client = createFakeClient({
      completeTurn: false,
      onTurnStart: () => turnStarted.resolve(),
    });
    const respond = client.request.getMockImplementation()!;
    client.request.mockImplementation(async (method: string, requestParams?: unknown) => {
      if (method === "config/read") {
        return { config: {}, origins: {}, layers: [] };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      return respond(method, requestParams);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);
    createOpenClawCodingToolsMock.mockReturnValue([
      {
        name: "image_generate",
        description: "Generate or edit images with the configured provider",
        parameters: { type: "object", properties: {}, additionalProperties: true },
        execute: toolExecuteMock,
      },
    ]);
    const run = runCodexAppServerSideQuestion(
      sideParams({
        cfg: {
          agents: { defaults: { mediaModels: { image: "google/test-image-model" } } },
        },
      }),
    );
    await turnStarted.promise;
    const imageArguments = { prompt: "Draw a blue bird", model: "google/test-image-model" };
    const toolResponse = await client.handleRequest({
      id: 42,
      method: "item/tool/call",
      params: {
        ...codexTestTurnIds("side-thread"),
        callId: "image-tool-1",
        tool: "image_generate",
        arguments: imageArguments,
      },
    });
    client.emit(turnCompleted("side-thread", "turn-1", "Image ready."));
    await expect(run).resolves.toEqual({ text: "Image ready." });

    const fork = client.request.mock.calls.find(([method]) => method === "thread/fork")?.[1];
    expect(fork).toMatchObject({
      config: { "features.image_generation": false },
      developerInstructions: expect.stringContaining("configured image provider"),
    });
    expect(toolResponse).toMatchObject({ success: true });
    expect(toolExecuteMock).toHaveBeenCalledOnce();
    expect(toolExecuteMock.mock.calls[0]?.[1]).toEqual(imageArguments);
  });
}
