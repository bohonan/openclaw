import { afterEach, describe, expect, it, vi } from "vitest";
import { rotateAgentRunRegistryLifecycleGeneration } from "../infra/agent-run-registry.js";
import {
  clearGeneratedMediaTaskActivity,
  createMediaGenerationOperation,
  getActiveMediaGenerationRunCount,
  getGeneratedMediaTaskIdsForSessionKey,
  hasNewGeneratedMediaTaskForSessionKey,
  hasPendingGeneratedMediaTaskForSessionKey,
  isMediaGenerationOperationCurrent,
  listMediaGenerationOperations,
  updateMediaGenerationOperation,
} from "./media-generation-activity.js";
import { resetGeneratedMediaTaskActivityForTests } from "./media-generation-activity.test-support.js";
import { findDuplicateGuardImageGenerationTaskForSession } from "./media-generation-task-status.js";
afterEach(() => {
  resetGeneratedMediaTaskActivityForTests();
  vi.restoreAllMocks();
});
describe("native media operation lifetime", () => {
  it.each(["queued", "running"] as const)(
    "dedupes only the same request while a long-lived operation is %s",
    async (status) => {
      const sessionKey = "agent:main:discord:direct:edits";
      const operation = createMediaGenerationOperation({
        taskId: "pending-edit",
        runId: "pending-edit",
        taskKind: "image_generation",
        sourceId: "image_generate:synthetic",
        requesterSessionKey: sessionKey,
        task: "Make the background blue",
        requestKey: "reference-one:1024x1024",
        status,
        createdAt: Date.now() - 10 * 60_000,
      });
      const request = { prompt: operation.task, requestKey: operation.requestKey };
      expect(await findDuplicateGuardImageGenerationTaskForSession(sessionKey, request)).toBe(
        operation,
      );
      for (const requestKey of ["reference-two:1024x1024", "reference-one:2048x2048"]) {
        expect(
          await findDuplicateGuardImageGenerationTaskForSession(sessionKey, {
            ...request,
            requestKey,
          }),
        ).toBeUndefined();
      }
    },
  );

  it.each([
    ["succeeded", undefined, 120_000, true],
    ["succeeded", undefined, 120_001, false],
    ["succeeded", "blocked", 1_000, false],
    ["failed", undefined, 1_000, false],
  ] as const)(
    "guards a %s completion (%s, aged %s ms): %s",
    async (status, terminalOutcome, ageMs, blocksDuplicate) => {
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);
      const sessionKey = "agent:main:discord:direct:completed";
      const operation = createMediaGenerationOperation({
        taskId: "completed-edit",
        runId: "completed-edit",
        taskKind: "image_generation",
        sourceId: "image_generate:synthetic",
        requesterSessionKey: sessionKey,
        task: "Make the background blue",
        requestKey: "same-edit",
        status,
        terminalOutcome,
        createdAt: now - 10 * 60_000,
        endedAt: now - ageMs,
      });
      const siblingRunId = "other-completed-edit";
      const sibling = createMediaGenerationOperation({
        taskId: "other-completed-edit",
        runId: siblingRunId,
        taskKind: "image_generation",
        sourceId: "image_generate:synthetic",
        requesterSessionKey: sessionKey,
        task: "Make the background green",
        requestKey: "other-edit",
        status: "running",
        createdAt: now - 2_000,
      });
      updateMediaGenerationOperation(siblingRunId, {
        status: "succeeded",
        endedAt: now - 1_000,
      });
      clearGeneratedMediaTaskActivity(siblingRunId);
      expect(
        await findDuplicateGuardImageGenerationTaskForSession(sessionKey, {
          prompt: operation.task,
          requestKey: "same-edit",
        }),
      ).toBe(blocksDuplicate ? operation : undefined);
      expect(
        await findDuplicateGuardImageGenerationTaskForSession(sessionKey, {
          prompt: operation.task,
          requestKey: "revised-edit",
        }),
      ).toBeUndefined();
      expect(
        await findDuplicateGuardImageGenerationTaskForSession(sessionKey, {
          prompt: sibling.task,
          requestKey: "other-edit",
        }),
      ).toBe(sibling);
    },
  );

  it("keeps shared bare session keys agent-scoped and retires stale process ownership", async () => {
    const before = getGeneratedMediaTaskIdsForSessionKey("shared", "one");
    for (const agent of ["one", "two"]) {
      createMediaGenerationOperation({
        taskId: agent,
        runId: agent,
        requesterSessionKey: "shared",
        requesterAgentId: agent,
        taskKind: "image_generation",
        sourceId: "image_generate:synthetic",
        task: "a synthetic lighthouse",
        requestKey: "same-request",
        status: "running",
        createdAt: Date.now(),
      });
    }
    expect(listMediaGenerationOperations("shared")).toEqual([]);
    expect(
      listMediaGenerationOperations("shared", "one").map((operation) => operation.taskId),
    ).toEqual(["one"]);
    expect(getGeneratedMediaTaskIdsForSessionKey("shared", "one")).not.toContain("two");
    expect(hasNewGeneratedMediaTaskForSessionKey("shared", before, "one")).toBe(true);
    expect(hasNewGeneratedMediaTaskForSessionKey("shared", before)).toBe(false);
    const oneAdmissions = getGeneratedMediaTaskIdsForSessionKey("shared", "one");
    expect(hasNewGeneratedMediaTaskForSessionKey("shared", oneAdmissions, "one")).toBe(false);
    expect(hasNewGeneratedMediaTaskForSessionKey("shared", oneAdmissions, "two")).toBe(true);
    expect(getActiveMediaGenerationRunCount()).toBe(2);
    expect(
      await findDuplicateGuardImageGenerationTaskForSession("shared", {
        agentId: "one",
        prompt: "a synthetic lighthouse",
        requestKey: "same-request",
      }),
    ).toMatchObject({ runId: "one", status: "running" });
    rotateAgentRunRegistryLifecycleGeneration();
    expect(isMediaGenerationOperationCurrent("one")).toBe(false);
    expect(getActiveMediaGenerationRunCount()).toBe(0);
    expect(listMediaGenerationOperations("shared", "one")).toEqual([]);
    expect(
      await findDuplicateGuardImageGenerationTaskForSession("shared", {
        agentId: "one",
        prompt: "a synthetic lighthouse",
        requestKey: "same-request",
      }),
    ).toBeUndefined();
  });
  it("blocks duplicate provider work, retains attempt admission after completion, and releases restart custody", async () => {
    const sessionKey = "agent:main:cron:media:run:one";
    const before = getGeneratedMediaTaskIdsForSessionKey(sessionKey);
    const operation = createMediaGenerationOperation({
      taskId: "image:1",
      runId: "image:1",
      taskKind: "image_generation",
      sourceId: "image_generate:test",
      requesterSessionKey: sessionKey,
      requesterAgentId: "main",
      task: "draw a tree",
      requestKey: "same-request",
      status: "running",
      createdAt: Date.now(),
    });
    expect(
      await findDuplicateGuardImageGenerationTaskForSession(sessionKey, {
        prompt: "draw a tree",
        agentId: "main",
      }),
    ).toBe(operation);
    expect(getActiveMediaGenerationRunCount()).toBe(1);
    expect(hasPendingGeneratedMediaTaskForSessionKey(sessionKey)).toBe(true);
    updateMediaGenerationOperation("image:1", { status: "succeeded", endedAt: Date.now() });
    clearGeneratedMediaTaskActivity("image:1");
    expect(getActiveMediaGenerationRunCount()).toBe(0);
    expect(hasPendingGeneratedMediaTaskForSessionKey(sessionKey)).toBe(false);
    expect(hasNewGeneratedMediaTaskForSessionKey(sessionKey, before)).toBe(true);
    expect(
      await findDuplicateGuardImageGenerationTaskForSession(sessionKey, {
        prompt: "draw a tree",
        requestKey: "same-request",
        agentId: "main",
      }),
    ).toBe(operation);
    expect(
      await findDuplicateGuardImageGenerationTaskForSession(sessionKey, {
        prompt: "draw something different",
        requestKey: "different-request",
        agentId: "main",
      }),
    ).toBeUndefined();
  });
});
