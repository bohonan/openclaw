// Verifies media-generation task lookup, duplicate guards, and prompt status text.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  listMediaGenerationOperations,
  MediaGenerationOperation,
} from "./media-generation-activity.js";
import {
  buildMediaTaskRuntimeContext,
  buildImageGenerationTaskStatusDetails,
  buildImageGenerationTaskStatusText,
  findDuplicateGuardImageGenerationTaskForSession,
  IMAGE_GENERATION_TASK_KIND,
  buildVideoGenerationTaskStatusDetails,
  buildVideoGenerationTaskStatusText,
  findActiveVideoGenerationTaskForSession,
  VIDEO_GENERATION_TASK_KIND,
} from "./media-generation-task-status.js";

const mediaActivityMocks = vi.hoisted(() => ({
  listOperations: vi.fn<typeof listMediaGenerationOperations>(),
}));

vi.mock("./media-generation-activity.js", () => ({
  listMediaGenerationOperations: mediaActivityMocks.listOperations,
}));

function makeTask(overrides: Partial<MediaGenerationOperation>): MediaGenerationOperation {
  return {
    taskId: "task-running",
    taskKind: IMAGE_GENERATION_TASK_KIND,
    sourceId: "image_generate:openai",
    requesterSessionKey: "agent:main",
    task: "running task",
    status: "running",
    createdAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  mediaActivityMocks.listOperations.mockReset();
  mediaActivityMocks.listOperations.mockReturnValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function expectActiveImageGenerationTask(
  task: Awaited<ReturnType<typeof findDuplicateGuardImageGenerationTaskForSession>>,
): NonNullable<Awaited<ReturnType<typeof findDuplicateGuardImageGenerationTaskForSession>>> {
  // Narrows optional lookups in tests that need status helper calls.
  if (task == null) {
    throw new Error("Expected active image generation task");
  }
  return task;
}

describe("image generation task status", () => {
  it("prefers a running task over queued session siblings", async () => {
    mediaActivityMocks.listOperations.mockReturnValue([
      makeTask({
        taskId: "task-queued",
        sourceId: "image_generate:google",
        task: "queued task",
        status: "queued",
      }),
      makeTask({
        progressSummary: "Generating image",
      }),
    ]);

    const task = await findDuplicateGuardImageGenerationTaskForSession("agent:main");

    expect(task?.taskId).toBe("task-running");
    const activeTask = expectActiveImageGenerationTask(task);
    expect(buildImageGenerationTaskStatusText(activeTask, { duplicateGuard: true })).toContain(
      "Do not resubmit this same pending generation.",
    );
    const details = buildImageGenerationTaskStatusDetails(activeTask);
    expect(details.active).toBe(true);
    expect(details.existingTask).toBe(true);
    expect(details.status).toBe("running");
    expect(details.taskKind).toBe(IMAGE_GENERATION_TASK_KIND);
    expect(details.provider).toBe("openai");
    expect(details.progressSummary).toBe("Generating image");
  });

  it("can restrict active lookup to the matching image prompt", async () => {
    mediaActivityMocks.listOperations.mockReturnValue([
      makeTask({
        taskId: "task-first",
        task: "First diagram prompt",
      }),
      makeTask({
        taskId: "task-second",
        task: "Second diagram prompt",
      }),
    ]);

    expect(
      (
        await findDuplicateGuardImageGenerationTaskForSession("agent:main", {
          prompt: "Second diagram prompt",
        })
      )?.taskId,
    ).toBe("task-second");
    expect(
      await findDuplicateGuardImageGenerationTaskForSession("agent:main", {
        prompt: "Third diagram prompt",
      }),
    ).toBeUndefined();
  });

  it("builds prompt context for active session work", async () => {
    mediaActivityMocks.listOperations.mockReturnValue([
      makeTask({
        requesterAgentId: "main",
        progressSummary: "Generating image",
      }),
    ]);

    const context = await buildMediaTaskRuntimeContext({
      capabilityToolNames: new Set(["image_generate"]),
      sessionKey: "agent:main",
      agentId: "main",
    });

    expect(context).toBe(
      '## Media Generation Tasks\n- tool=image_generate; task=task-running; status=running; provider_json="openai"; progress_json="Generating image"',
    );
  });
});

function expectActiveVideoGenerationTask(
  task: Awaited<ReturnType<typeof findActiveVideoGenerationTaskForSession>>,
): NonNullable<Awaited<ReturnType<typeof findActiveVideoGenerationTaskForSession>>> {
  if (task == null) {
    throw new Error("Expected active video generation task");
  }
  return task;
}

describe("video generation task status", () => {
  it("recognizes active session-backed video generation tasks", async () => {
    mediaActivityMocks.listOperations.mockReturnValue([
      makeTask({
        taskId: "task-1",
        taskKind: VIDEO_GENERATION_TASK_KIND,
        sourceId: "video_generate:openai",
        task: "make lobster video",
      }),
      makeTask({
        taskId: "task-2",
        taskKind: VIDEO_GENERATION_TASK_KIND,
        sourceId: "video_generate:openai",
        task: "make lobster video",
      }),
    ]);

    expect((await findActiveVideoGenerationTaskForSession("agent:main"))?.taskId).toBe("task-1");
  });

  it("prefers a running task over queued session siblings", async () => {
    // Running work should suppress duplicate generation even when older queued
    // siblings still exist for the same session owner.
    mediaActivityMocks.listOperations.mockReturnValue([
      makeTask({
        taskId: "task-queued",
        taskKind: VIDEO_GENERATION_TASK_KIND,
        sourceId: "video_generate:google",
        task: "queued task",
        status: "queued",
      }),
      makeTask({
        taskKind: VIDEO_GENERATION_TASK_KIND,
        sourceId: "video_generate:openai",
        progressSummary: "Generating video",
      }),
    ]);

    const task = await findActiveVideoGenerationTaskForSession("agent:main");

    expect(task?.taskId).toBe("task-running");
    const activeTask = expectActiveVideoGenerationTask(task);
    expect(buildVideoGenerationTaskStatusText(activeTask, { duplicateGuard: true })).toContain(
      "Do not resubmit this same pending generation.",
    );
    const details = buildVideoGenerationTaskStatusDetails(activeTask);
    expect(details.active).toBe(true);
    expect(details.existingTask).toBe(true);
    expect(details.status).toBe("running");
    expect(details.taskKind).toBe(VIDEO_GENERATION_TASK_KIND);
    expect(details.provider).toBe("openai");
    expect(details.progressSummary).toBe("Generating video");
  });

  it("builds prompt context for active session work", async () => {
    mediaActivityMocks.listOperations.mockReturnValue([
      makeTask({
        taskKind: VIDEO_GENERATION_TASK_KIND,
        sourceId: "video_generate:openai",
        requesterAgentId: "main",
        progressSummary: "Generating video",
      }),
    ]);

    const context = await buildMediaTaskRuntimeContext({
      capabilityToolNames: new Set(["video_generate"]),
      sessionKey: "agent:main",
      agentId: "main",
    });

    expect(context).toBe(
      '## Media Generation Tasks\n- tool=video_generate; task=task-running; status=running; provider_json="openai"; progress_json="Generating video"',
    );
  });
});
