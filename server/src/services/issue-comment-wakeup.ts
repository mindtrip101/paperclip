export function shouldWakeAssigneeForIssueComment(input: {
  selfComment: boolean;
  resumeRequested: boolean;
  commentCreatedByRunId?: string | null;
  issueAtCommentStart: {
    checkoutRunId?: string | null;
    executionRunId?: string | null;
  };
  reopened: boolean;
  currentStatus: string | null | undefined;
}) {
  const sourceRunId = input.commentCreatedByRunId;
  const commentIsFromCurrentIssueRun = Boolean(
    sourceRunId &&
    (sourceRunId === input.issueAtCommentStart.checkoutRunId ||
      sourceRunId === input.issueAtCommentStart.executionRunId),
  );
  // A comment from the assignee, including the runner's own outcome comment,
  // never starts another run. A person or a different agent still can.
  if (input.selfComment) return false;
  if (commentIsFromCurrentIssueRun) return false;
  return (
    input.reopened ||
    (input.currentStatus !== "done" && input.currentStatus !== "cancelled")
  );
}

/**
 * Comment wakes attributed to the target agent do not start that agent.
 * A board user's wake is unchanged.
 */
export function sameAgentCommentShouldWake(input: {
  targetAgentId: string;
  authorAgentId: string | null;
  createdByRunAgentId: string | null;
  requestedByActorType?: string | null;
}): boolean {
  if (input.requestedByActorType === "user") return true;
  if (input.authorAgentId != null && input.authorAgentId === input.targetAgentId) return false;
  if (input.createdByRunAgentId != null && input.createdByRunAgentId === input.targetAgentId) return false;
  return true;
}
