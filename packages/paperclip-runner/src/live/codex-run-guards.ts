/**
 * Guards for a Codex runnerd run.
 *
 * A configured `timeoutSeconds` of 0 or a missing value keeps the historical
 * unlimited spawn (`maxRuntimeMs: 0`). Maintenance spawns pass their own limit
 * and do not call this helper.
 */
export function codexSpawnMaxRuntimeMs(timeoutSeconds: number | null | undefined): number {
  if (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) return 0;
  return Math.trunc(timeoutSeconds * 1000);
}

export function readConfiguredLimit(value: unknown, integer: boolean): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  if (integer && !Number.isInteger(value)) return null;
  return value;
}

/** Tool and file actions that count toward `maxIterations`. Messages do not. */
const CODEX_STEP_KINDS = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicTool",
  "tool",
]);

export function observeCodexStep(input: {
  completedSteps: number;
  maxIterations: number | null | undefined;
  pullRequestUrl?: string | null;
  stepKind: string;
}): {
  completedSteps: number;
  stop: boolean;
  reasonCode: "max_iterations_exceeded" | "pull_request_open" | null;
  message: string | null;
} {
  if (isOpenPullRequestUrl(input.pullRequestUrl)) {
    return {
      completedSteps: input.completedSteps,
      stop: true,
      reasonCode: "pull_request_open",
      message: "The task already has an open pull request, so this run stops instead of continuing.",
    };
  }
  const counts = CODEX_STEP_KINDS.has(input.stepKind);
  const completedSteps = counts ? input.completedSteps + 1 : input.completedSteps;
  if (
    counts &&
    typeof input.maxIterations === "number" &&
    input.maxIterations > 0 &&
    completedSteps >= input.maxIterations
  ) {
    const noun = input.maxIterations === 1 ? "step" : "steps";
    return {
      completedSteps,
      stop: true,
      reasonCode: "max_iterations_exceeded",
      message: `max_iterations_exceeded: stopped after ${input.maxIterations} ${noun}.`,
    };
  }
  return { completedSteps, stop: false, reasonCode: null, message: null };
}

export function isOpenPullRequestUrl(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export type WorkspaceFailureKind = "clone" | "authenticate" | "push";

export function classifyWorkspaceFailure(message: string): WorkspaceFailureKind | null {
  const text = message.toLowerCase();
  if (/\bpush\b/.test(text) && /(fail|error|denied|rejected|unable|could not)/.test(text)) return "push";
  if (/\bclone\b/.test(text) && /(fail|error|unable|could not)/.test(text)) return "clone";
  if (/(authentication failed|could not authenticate|auth(?:entication)? (?:failed|error)|permission denied|invalid credentials|authentication required)/.test(text)) {
    return "authenticate";
  }
  return null;
}

export const HONEST_RUN_FAILURE_CODES = [
  "no_output",
  "change_required_but_missing",
  "workspace_clone_failed",
  "workspace_authentication_failed",
  "workspace_push_failed",
  "max_iterations_exceeded",
] as const;

export type HonestRunFailureCode = (typeof HONEST_RUN_FAILURE_CODES)[number];

export function isHonestRunFailureCode(value: string | null | undefined): value is HonestRunFailureCode {
  return (HONEST_RUN_FAILURE_CODES as readonly string[]).includes(value ?? "");
}

export interface HonestRunAssessment {
  outcome: "succeeded" | "failed";
  reasonCode: HonestRunFailureCode | null;
  message: string | null;
}

/**
 * A Codex turn that only explores the repo still exits 0. Heartbeat treated a
 * missing exit code as 0 (`exitCode ?? 0`) and a completed turn as
 * `runTerminalState: succeeded`. Either path recorded success with no branch,
 * diff, or pull request. This classifier rejects that.
 */
export function classifyHonestRunOutcome(input: {
  exitCode?: number | null;
  errorMessage?: string | null;
  summary?: string | null;
  semanticResultPresent: boolean;
  reportedDisposition?: string | null;
  continuationKind?: string | null;
  producedChange: boolean;
  changeRequired: boolean;
  pullRequestUrl?: string | null;
  workspaceErrors?: readonly string[];
}): HonestRunAssessment {
  const texts = [input.errorMessage, input.summary, ...(input.workspaceErrors ?? [])].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  for (const text of texts) {
    const kind = classifyWorkspaceFailure(text);
    if (!kind) continue;
    const reasonCode = kind === "clone"
      ? "workspace_clone_failed"
      : kind === "authenticate"
        ? "workspace_authentication_failed"
        : "workspace_push_failed";
    const action = kind === "clone" ? "clone the repository" : kind === "authenticate" ? "authenticate" : "push";
    return {
      outcome: "failed",
      reasonCode,
      message: `The run failed to ${action}: ${text}`,
    };
  }
  if (isOpenPullRequestUrl(input.pullRequestUrl) || input.producedChange) {
    return { outcome: "succeeded", reasonCode: null, message: null };
  }
  const waiting = input.reportedDisposition === "blocked"
    || input.reportedDisposition === "needs_review"
    || input.continuationKind === "response_wake"
    || input.continuationKind === "monitor";
  if (input.changeRequired && !waiting) {
    return {
      outcome: "failed",
      reasonCode: "change_required_but_missing",
      message: "The run ended without a repository change or pull request, but this task required a change.",
    };
  }
  const exitMissing = input.exitCode === undefined || input.exitCode === null;
  const exitLooksSuccessful = exitMissing || input.exitCode === 0;
  if (exitLooksSuccessful && !input.semanticResultPresent && !input.summary?.trim()) {
    return {
      outcome: "failed",
      reasonCode: "no_output",
      message: "The run finished without a result, diff, or pull request, so it is failed instead of succeeded.",
    };
  }
  return { outcome: "succeeded", reasonCode: null, message: null };
}

export function codingChangeRequired(input: { workMode?: string | null; repoUrl?: string | null }): boolean {
  if (input.workMode === "ask" || input.workMode === "planning") return false;
  return typeof input.repoUrl === "string" && input.repoUrl.trim().length > 0;
}

/**
 * Same-agent follow-ups started by the status arbiter (`invocationSource=automation`)
 * require approval unless this flag is on. An explicit adapter value wins over
 * the environment variable. Unset means require approval.
 */
export function automaticSameAgentContinuationEnabled(
  config: { automaticSameAgentContinuation?: unknown } | null | undefined,
  envValue?: string | null,
): boolean {
  if (config?.automaticSameAgentContinuation === true) return true;
  if (config?.automaticSameAgentContinuation === false) return false;
  const env = (envValue ?? "").trim().toLowerCase();
  return env === "1" || env === "true" || env === "yes";
}

export function sameAgentContinuationDisposition(input: {
  continuationKind: string;
  automatic: boolean;
}): "enqueue" | "require_approval" {
  if (input.continuationKind === "same_agent" && !input.automatic) return "require_approval";
  return "enqueue";
}
