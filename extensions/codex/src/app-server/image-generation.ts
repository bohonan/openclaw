import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "openclaw/plugin-sdk/provider-onboard";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CODEX_SESSION_OVERRIDABLE_LAYER_TYPES } from "./config-layer-policy.js";
import {
  isJsonObject,
  type CodexConfigReadResponse,
  type CodexDynamicToolSpec,
  type JsonObject,
} from "./protocol.js";

type CodexImageGenerationPlan = {
  kind: "native-default" | "managed" | "disabled";
  threadConfig: JsonObject;
};

/** Native imagegen cannot select an OpenClaw provider/model or apply its timeout. */
export function resolveCodexImageGenerationPlan(params: {
  config?: OpenClawConfig;
  disableTools?: boolean;
  nativeToolSurfaceEnabled?: boolean;
  imageGenerationAllowed?: boolean;
}): CodexImageGenerationPlan {
  if (params.disableTools || params.imageGenerationAllowed === false) {
    return { kind: "disabled", threadConfig: { "features.image_generation": false } };
  }
  const image = params.config?.agents?.defaults?.mediaModels?.image;
  const managedImageExplicit = Boolean(
    resolveAgentModelPrimaryValue(image) ||
    resolveAgentModelFallbackValues(image).some((model) => normalizeOptionalString(model)) ||
    (typeof image === "object" && image?.timeoutMs !== undefined),
  );
  if (managedImageExplicit || params.nativeToolSurfaceEnabled === false) {
    return { kind: "managed", threadConfig: { "features.image_generation": false } };
  }
  // Leave native feature, provider, model, and account eligibility to Codex. Keep
  // image_generate available for explicit per-call overrides and native-unavailable runs.
  return { kind: "native-default", threadConfig: {} };
}

export function resolveCodexImageGenerationToolName(
  dynamicTools: readonly CodexDynamicToolSpec[] | undefined,
): string | undefined {
  for (const spec of dynamicTools ?? []) {
    if (spec.type === "namespace" && spec.tools.some((tool) => tool.name === "image_generate")) {
      return `${spec.name}.image_generate`;
    }
    if (spec.type === "function" && spec.name === "image_generate") {
      return spec.name;
    }
  }
  return undefined;
}

export function buildCodexImageGenerationGuidance(
  config: OpenClawConfig | undefined,
  managedToolName: string | undefined,
): string | undefined {
  if (!managedToolName) {
    return undefined;
  }
  const route =
    resolveCodexImageGenerationPlan({ config }).kind === "managed"
      ? `Use \`${managedToolName}\` for image generation and editing with OpenClaw's configured image provider, model, timeout, and fallbacks. Set its model argument only for an explicitly requested model override.`
      : `For image generation and editing without an explicit provider/model, use Codex's native \`image_gen.imagegen\` when it is available. Use \`${managedToolName}\` for an explicitly requested provider/model or API parameters absent from the native tool schema, and when native image generation is unavailable. Never silently substitute native generation for an explicit provider/model request.`;
  return `${route} Preserve the full brief and reference images. For edits, pass the actual source images; use the latest output when refining that output. Return only the selected final images. For native results, embed their original saved paths as Markdown images in the final reply so OpenClaw can select them for delivery.`;
}

/** Legacy managed layers can outrank session flags without appearing in requirements. */
export function assertCodexImageGenerationEffectiveConfig(
  effectiveConfig: CodexConfigReadResponse,
): void {
  const features = effectiveConfig.config.features;
  if (
    isJsonObject(features) &&
    features.image_generation === true &&
    !CODEX_SESSION_OVERRIDABLE_LAYER_TYPES.has(
      effectiveConfig.origins?.["features.image_generation"]?.name.type ?? "",
    )
  ) {
    throw new Error(
      "OpenClaw requires native Codex image generation to be disabled for this image route, but the effective image_generation setting cannot be overridden. Ask your administrator to remove the conflicting native image requirement.",
    );
  }
}
