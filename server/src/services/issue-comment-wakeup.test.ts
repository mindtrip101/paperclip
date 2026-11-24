import { describe, expect, it } from "vitest";
import { sameAgentCommentShouldWake, shouldWakeAssigneeForIssueComment } from "./issue-comment-wakeup.js";

describe("shouldWakeAssigneeForIssueComment", () => {
  it("suppresses explicit resume from the run that currently owns the issue", () => {
    expect(
      shouldWakeAssigneeForIssueComment({
        selfComment: true,
        resumeRequested: true,
        commentCreatedByRunId: "run-current",
        issueAtCommentStart: {
          checkoutRunId: "run-current",
          executionRunId: "run-current",
        },
        reopened: false,
        currentStatus: "in_progress",
      }),
    ).toBe(false);
  });

  it("does not wake the assignee for its own outcome comment after checkout is released", () => {
    expect(
      shouldWakeAssigneeForIssueComment({
        selfComment: true,
        resumeRequested: true,
        commentCreatedByRunId: "run-finished",
        issueAtCommentStart: {
          checkoutRunId: null,
          executionRunId: null,
        },
        reopened: false,
        currentStatus: "in_progress",
      }),
    ).toBe(false);
  });

  it("still wakes the assignee for someone else's comment", () => {
    expect(
      shouldWakeAssigneeForIssueComment({
        selfComment: false,
        resumeRequested: true,
        commentCreatedByRunId: "run-other",
        issueAtCommentStart: {
          checkoutRunId: null,
          executionRunId: null,
        },
        reopened: false,
        currentStatus: "in_progress",
      }),
    ).toBe(true);
  });

  it("keeps ordinary self-comments inert", () => {
    expect(
      shouldWakeAssigneeForIssueComment({
        selfComment: true,
        resumeRequested: false,
        commentCreatedByRunId: "run-prior",
        issueAtCommentStart: {},
        reopened: false,
        currentStatus: "in_progress",
      }),
    ).toBe(false);
  });

  it("does not let the runner's own comment wake that agent", () => {
    expect(sameAgentCommentShouldWake({
      targetAgentId: "coder",
      authorAgentId: "coder",
      createdByRunAgentId: "coder",
      requestedByActorType: "agent",
    })).toBe(false);
    expect(sameAgentCommentShouldWake({
      targetAgentId: "coder",
      authorAgentId: "reviewer",
      createdByRunAgentId: "reviewer",
      requestedByActorType: "agent",
    })).toBe(true);
    expect(sameAgentCommentShouldWake({
      targetAgentId: "coder",
      authorAgentId: null,
      createdByRunAgentId: null,
      requestedByActorType: "user",
    })).toBe(true);
  });

  it("does not wake a closed issue unless the comment reopened it", () => {
    const base = {
      selfComment: false,
      resumeRequested: false,
      issueAtCommentStart: {},
      currentStatus: "done",
    };
    expect(
      shouldWakeAssigneeForIssueComment({ ...base, reopened: false }),
    ).toBe(false);
    expect(shouldWakeAssigneeForIssueComment({ ...base, reopened: true })).toBe(
      true,
    );
  });
});
