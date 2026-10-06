import path from "node:path";
import { expect, it, vi } from "vitest";
import { tempDir } from "./run-attempt-test-harness.js";
import {
  createLeasedCodexLifecycleHarness,
  type CodexAttemptThreadInput as LifecycleInput,
  type startOrResumeAttemptThread,
} from "./thread-lifecycle.test-fixtures.js";

type ImageGenerationFixtures = {
  createParams: (sessionFile: string, workspaceDir: string) => LifecycleInput["params"];
  createPaths: () => { sessionFile: string; workspaceDir: string };
  createFixedThreadRequest: (
    threadId: string,
    methods: string[],
  ) => (method: string, requestParams?: unknown) => Promise<unknown>;
  startOrResumeThread: (
    input: Pick<LifecycleInput, "client"> & Partial<LifecycleInput>,
  ) => ReturnType<typeof startOrResumeAttemptThread>;
  retainThread: (
    client: LifecycleInput["client"],
    binding: Awaited<ReturnType<typeof startOrResumeAttemptThread>>,
  ) => Promise<boolean>;
  preflightMethods: readonly string[];
  warmResumeMethods: readonly string[];
};

/** Keep image policy cases under the binding suite's existing lifecycle setup and cleanup. */
export function registerThreadImageGenerationTests({
  createParams,
  createPaths,
  createFixedThreadRequest,
  startOrResumeThread,
  retainThread,
  preflightMethods,
  warmResumeMethods,
}: ImageGenerationFixtures) {
  it.each(["tool denial", "configured image model", "removed image model"] as const)(
    "cold-resumes a warm thread when image routing changes: %s",
    async (change) => {
      const sessionFile = path.join(tempDir, "warm-image-deny-session.jsonl");
      const workspaceDir = path.join(tempDir, "warm-image-deny-workspace");
      const params = createParams(sessionFile, workspaceDir);
      const configuredImageModel = {
        agents: { defaults: { mediaModels: { image: "google/test-image-model" } } },
      };
      if (change === "removed image model") {
        params.config = configuredImageModel;
      }
      const respond = createFixedThreadRequest("thread-warm-image-deny", [
        "thread/start",
        "thread/resume",
      ]);
      const fixture = await createLeasedCodexLifecycleHarness({
        agentDir: path.join(tempDir, "agent"),
        respond,
      });
      const { client, request } = fixture;
      const common = {
        client,
        params,
        userMcpServersEnabled: false,
      };

      const started = await startOrResumeThread(common);
      const startRequest = request.mock.calls.find(([method]) => method === "thread/start")?.[1];
      if (change === "removed image model") {
        expect(startRequest).toMatchObject({ config: { "features.image_generation": false } });
      } else {
        expect(startRequest).not.toHaveProperty(["config", "features.image_generation"]);
      }
      await expect(retainThread(client, started)).resolves.toBe(true);
      if (change === "tool denial") {
        params.pluginHarnessToolPolicySafeDeniedTools = ["image_generate"];
      } else {
        params.config = change === "configured image model" ? configuredImageModel : undefined;
      }
      const resumed = await startOrResumeThread(common);

      expect(resumed).toMatchObject({
        threadId: "thread-warm-image-deny",
        lifecycle: { action: "resumed" },
      });
      expect(request.mock.calls.map(([method]) => method)).toEqual(warmResumeMethods);
      const resumeRequest = request.mock.calls.find(([method]) => method === "thread/resume")?.[1];
      if (change === "removed image model") {
        expect(resumeRequest).not.toHaveProperty(["config", "features.image_generation"]);
      } else {
        expect(resumeRequest).toMatchObject({ config: { "features.image_generation": false } });
      }
    },
  );

  it.each([
    { denial: "tool policy", feature: "image_generation" },
    { denial: "configured image model", feature: "image_generation" },
    { denial: "configured image model", feature: "imagegenext" },
  ])(
    "fails closed when requirements pin $feature on against $denial",
    async ({ denial, feature }) => {
      const { sessionFile, workspaceDir } = createPaths();
      const params = createParams(sessionFile, workspaceDir);
      if (denial === "tool policy") {
        params.pluginHarnessToolPolicySafeDeniedTools = ["image_generate"];
      } else {
        params.config = {
          agents: { defaults: { mediaModels: { image: "google/test-image-model" } } },
        };
      }
      const request = vi.fn(async (method: string) => {
        if (method === "config/read") {
          return { config: {}, layers: [] };
        }
        if (method === "configRequirements/read") {
          return { requirements: { featureRequirements: { [feature]: true } } };
        }
        throw new Error(`unexpected method: ${method}`);
      });

      await expect(
        startOrResumeThread({
          client: { request } as never,
          params,
          userMcpServersEnabled: false,
        }),
      ).rejects.toThrow(`cannot override required feature ${feature}`);
      expect(request.mock.calls.map(([method]) => method)).toEqual([...preflightMethods]);
    },
  );
}
