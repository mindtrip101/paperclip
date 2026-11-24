import { describe, expect, it } from "vitest";
import {
  automaticSameAgentContinuationEnabled,
  classifyHonestRunOutcome,
  classifyWorkspaceFailure,
  codexSpawnMaxRuntimeMs,
  codingChangeRequired,
  observeCodexStep,
  sameAgentContinuationDisposition,
} from "./codex-run-guards.js";

describe("codex run guards", () => {
  it("turns a configured timeout into the runnerd runtime limit and leaves an unset timeout unlimited", () => {
    expect(codexSpawnMaxRuntimeMs(undefined)).toBe(0);
    expect(codexSpawnMaxRuntimeMs(null)).toBe(0);
    expect(codexSpawnMaxRuntimeMs(0)).toBe(0);
    expect(codexSpawnMaxRuntimeMs(-5)).toBe(0);
    expect(codexSpawnMaxRuntimeMs(Number.NaN)).toBe(0);
    expect(codexSpawnMaxRuntimeMs(90)).toBe(90_000);
    expect(codexSpawnMaxRuntimeMs(2)).toBe(2_000);
  });

  it("stops once maxIterations tool steps are used and ignores an unset cap", () => {
    expect(observeCodexStep({
      completedSteps: 0, maxIterations: null, stepKind: "commandExecution",
    })).toMatchObject({ completedSteps: 1, stop: false });
    expect(observeCodexStep({
      completedSteps: 1, maxIterations: 2, stepKind: "agentMessage",
    })).toMatchObject({ completedSteps: 1, stop: false });
    expect(observeCodexStep({
      completedSteps: 1, maxIterations: 2, stepKind: "fileChange",
    })).toMatchObject({
      completedSteps: 2,
      stop: true,
      reasonCode: "max_iterations_exceeded",
    });
  });

  it("stops a run that already has an open pull request", () => {
    expect(observeCodexStep({
      completedSteps: 0,
      maxIterations: 8,
      pullRequestUrl: "https://github.com/acme/repo/pull/4",
      stepKind: "commandExecution",
    })).toMatchObject({ stop: true, reasonCode: "pull_request_open", completedSteps: 0 });
  });

  it("requires approval for automatic same-agent continuation unless the flag is on", () => {
    expect(automaticSameAgentContinuationEnabled(undefined, undefined)).toBe(false);
    expect(automaticSameAgentContinuationEnabled({}, "")).toBe(false);
    expect(automaticSameAgentContinuationEnabled({ automaticSameAgentContinuation: false }, "true")).toBe(false);
    expect(automaticSameAgentContinuationEnabled({ automaticSameAgentContinuation: true }, undefined)).toBe(true);
    expect(automaticSameAgentContinuationEnabled(null, "1")).toBe(true);
    expect(sameAgentContinuationDisposition({ continuationKind: "same_agent", automatic: false })).toBe("require_approval");
    expect(sameAgentContinuationDisposition({ continuationKind: "same_agent", automatic: true })).toBe("enqueue");
    expect(sameAgentContinuationDisposition({ continuationKind: "response_wake", automatic: false })).toBe("enqueue");
    expect(sameAgentContinuationDisposition({ continuationKind: "retry", automatic: false })).toBe("enqueue");
  });

  it("fails clone, authentication, and push instead of reporting success", () => {
    expect(classifyWorkspaceFailure("git clone failed: repository not found")).toBe("clone");
    expect(classifyWorkspaceFailure("Authentication failed for https://github.com/acme/repo.git")).toBe("authenticate");
    expect(classifyWorkspaceFailure("git push failed: permission denied")).toBe("push");
    for (const [message, reasonCode] of [
      ["fatal: could not clone the repository", "workspace_clone_failed"],
      ["authentication failed for origin", "workspace_authentication_failed"],
      ["unable to push refs to origin", "workspace_push_failed"],
    ] as const) {
      expect(classifyHonestRunOutcome({
        exitCode: 0,
        semanticResultPresent: true,
        reportedDisposition: "done",
        producedChange: true,
        changeRequired: true,
        workspaceErrors: [message],
      })).toMatchObject({ outcome: "failed", reasonCode });
    }
  });

  it("fails a clean exit with no change when a change was required, and does not fail a real change", () => {
    expect(codingChangeRequired({ workMode: "standard", repoUrl: "https://github.com/acme/repo.git" })).toBe(true);
    expect(codingChangeRequired({ workMode: "ask", repoUrl: "https://github.com/acme/repo.git" })).toBe(false);
    expect(codingChangeRequired({ workMode: "planning", repoUrl: "https://github.com/acme/repo.git" })).toBe(false);
    expect(classifyHonestRunOutcome({
      exitCode: 0,
      semanticResultPresent: true,
      reportedDisposition: "done",
      producedChange: false,
      changeRequired: true,
    })).toMatchObject({
      outcome: "failed",
      reasonCode: "no_changes_produced",
    });
    expect(classifyHonestRunOutcome({
      exitCode: 0,
      semanticResultPresent: true,
      reportedDisposition: "done",
      producedChange: false,
      changeRequired: true,
      summary: "The shell binary lookup is failing. Let me try with the zsh path I know exists.",
    })).toMatchObject({ outcome: "failed", reasonCode: "shell_unavailable" });
    expect(classifyHonestRunOutcome({
      exitCode: 0,
      semanticResultPresent: true,
      reportedDisposition: "yielded",
      producedChange: false,
      changeRequired: true,
    })).toMatchObject({ outcome: "failed", reasonCode: "no_changes_produced" });
    expect(classifyHonestRunOutcome({
      exitCode: 0,
      semanticResultPresent: true,
      reportedDisposition: "done",
      producedChange: true,
      changeRequired: true,
    })).toMatchObject({ outcome: "succeeded", reasonCode: null });
    expect(classifyHonestRunOutcome({
      exitCode: 0,
      semanticResultPresent: true,
      reportedDisposition: "blocked",
      continuationKind: "response_wake",
      producedChange: false,
      changeRequired: true,
    }).outcome).toBe("succeeded");
  });

  it("does not treat a missing exit code and an empty turn as success", () => {
    expect(classifyHonestRunOutcome({
      exitCode: null,
      semanticResultPresent: false,
      producedChange: false,
      changeRequired: false,
    })).toMatchObject({
      outcome: "failed",
      reasonCode: "no_output",
      message: expect.stringContaining("instead of succeeded"),
    });
    expect(classifyHonestRunOutcome({
      exitCode: undefined,
      semanticResultPresent: false,
      producedChange: false,
      changeRequired: false,
      summary: "   ",
    }).reasonCode).toBe("no_output");
    expect(classifyHonestRunOutcome({
      exitCode: 0,
      semanticResultPresent: false,
      producedChange: false,
      changeRequired: false,
      summary: "Answered the question.",
    })).toMatchObject({ outcome: "succeeded" });
  });
});
