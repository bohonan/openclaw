import { describe, expect, it } from "vitest";
import {
  createThreadRequestAppServerOptions as createAppServerOptions,
  createThreadRequestAttemptParams as createAttemptParams,
} from "./thread-lifecycle.test-fixtures.js";
import { buildThreadStartParams } from "./thread-requests.js";

describe("configured image routing", () => {
  it.each([
    { image: "google/test-image-model", nativeDisabled: true },
    { image: { primary: "openai/test-image-model" }, nativeDisabled: true },
    { image: { fallbacks: ["google/test-image-model"] }, nativeDisabled: true },
    { image: { timeoutMs: 180000 }, nativeDisabled: true },
    { image: undefined, nativeDisabled: false },
    { image: { primary: " ", fallbacks: [" "] }, nativeDisabled: false },
  ])("applies image selection to native thread requests: $image", ({ image, nativeDisabled }) => {
    const params = createAttemptParams({ provider: "openai" });
    params.config = { agents: { defaults: { mediaModels: { image } } } };
    const request = buildThreadStartParams(params, {
      appServer: createAppServerOptions(),
      cwd: "/repo",
      dynamicTools: [],
      nativeCodeModeEnabled: true,
      // The configured image route must win over an enabled native home/plugin feature.
      config: { "features.image_generation": true },
    });
    expect(request.config?.["features.image_generation"]).toBe(!nativeDisabled);
  });
});
