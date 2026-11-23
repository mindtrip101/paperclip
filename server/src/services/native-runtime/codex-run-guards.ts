import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { and, eq, notInArray } from "drizzle-orm";
import { resolveAgentAdapterRunBudget } from "../heartbeat-stop-metadata.js";
import { agents, issues, issueWorkProducts, projectWorkspaces, type Db } from "@paperclipai/db";

// Kept in this package so the server typecheck root stays inside server/src.
// The runner copy in packages/paperclip-runner/src/live/codex-run-guards.ts is the
// spawn and step-cap implementation; these decision functions match it.

export function readConfiguredLimit(value: unknown, integer: boolean): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  if (integer && !Number.isInteger(value)) return null;
  return value;
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

export function classifyShellSpawnFailure(message: string): boolean {
  const text = message.toLowerCase();
  return /shell binary lookup/.test(text)
    || /shell_unavailable/.test(text)
    || /unable to spawn (?:a )?shell/.test(text)
    || /spawn\s+\S*(?:zsh|bash|sh)\s+enoent/.test(text)
    || (/enoent/.test(text) && /\b(shell|zsh|bash)\b/.test(text));
}

export const HONEST_RUN_FAILURE_CODES = [
  "no_output",
  "no_changes_produced",
  "change_required_but_missing",
  "shell_unavailable",
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
    return { outcome: "failed", reasonCode, message: `The run failed to ${action}: ${text}` };
  }
  const shellFailure = texts.find((text) => classifyShellSpawnFailure(text));
  if (shellFailure && !input.producedChange && !isOpenPullRequestUrl(input.pullRequestUrl)) {
    return {
      outcome: "failed",
      reasonCode: "shell_unavailable",
      message: `shell_unavailable: the run could not start a shell. ${shellFailure}`,
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
      reasonCode: "no_changes_produced",
      message: "no_changes_produced: the run ended without a diff on the workspace branch or an open pull request.",
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

export function shellSpawnFailureText(value: unknown, depth = 0): string | null {
  if (depth > 6 || value == null) return null;
  if (typeof value === "string") return classifyShellSpawnFailure(value) ? value : null;
  if (typeof value !== "object") return null;
  const entries = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (const entry of entries) {
    const found = shellSpawnFailureText(entry, depth + 1);
    if (found) return found;
  }
  return null;
}

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

const execFileAsync = promisify(execFile);
const CLOSED_PULL_REQUEST_STATUSES = ["merged", "closed", "archived", "failed"];

export interface CodexRunLimits {
  timeoutSeconds: number | null;
  maxIterations: number | null;
  openPullRequestUrl: string | null;
}

export async function loadCodexRunLimits(
  db: Db,
  companyId: string,
  agentId: string,
  issueId: string,
): Promise<CodexRunLimits> {
  const [agent, pullRequest] = await Promise.all([
    db.select({ adapterConfig: agents.adapterConfig }).from(agents).where(and(
      eq(agents.id, agentId),
      eq(agents.companyId, companyId),
    )).limit(1).then((rows) => rows[0] ?? null),
    readIssueOpenPullRequestUrl(db, companyId, issueId),
  ]);
  const budget = resolveAgentAdapterRunBudget([agent?.adapterConfig ?? {}]);
  return {
    timeoutSeconds: budget.timeoutSec > 0 ? budget.timeoutSec : null,
    maxIterations: budget.maxIterations,
    openPullRequestUrl: pullRequest,
  };
}

export async function readIssueWorkspaceRepoUrl(
  db: Db,
  companyId: string,
  issueId: string,
): Promise<string | null> {
  const [row] = await db.select({ repoUrl: projectWorkspaces.repoUrl }).from(issues).leftJoin(
    projectWorkspaces,
    eq(projectWorkspaces.id, issues.projectWorkspaceId),
  ).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId))).limit(1);
  const repoUrl = row?.repoUrl?.trim();
  return repoUrl ? repoUrl : null;
}

export async function readIssueOpenPullRequestUrl(
  db: Db,
  companyId: string,
  issueId: string,
): Promise<string | null> {
  const [row] = await db.select({ url: issueWorkProducts.url }).from(issueWorkProducts).where(and(
    eq(issueWorkProducts.companyId, companyId),
    eq(issueWorkProducts.issueId, issueId),
    eq(issueWorkProducts.type, "pull_request"),
    notInArray(issueWorkProducts.status, CLOSED_PULL_REQUEST_STATUSES),
  )).limit(1);
  const url = row?.url?.trim();
  return url ? url : null;
}

export async function readGitHead(cwd: string | null | undefined): Promise<string | null> {
  if (!cwd) return null;
  try {
    const result = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd, timeout: 10_000 });
    const head = result.stdout.trim();
    return head.length > 0 ? head : null;
  } catch {
    return null;
  }
}

export async function inspectRepositoryChange(
  cwd: string | null | undefined,
  baseHead: string | null,
): Promise<{ available: boolean; producedChange: boolean; error: string | null }> {
  if (!cwd) return { available: false, producedChange: false, error: null };
  try {
    const [status, head] = await Promise.all([
      execFileAsync("git", ["status", "--porcelain"], { cwd, timeout: 10_000 }),
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd, timeout: 10_000 }),
    ]);
    const current = head.stdout.trim();
    const producedChange = status.stdout.trim().length > 0
      || (baseHead !== null && current.length > 0 && current !== baseHead);
    return { available: true, producedChange, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const classified = Boolean(classifyWorkspaceFailure(message) || classifyShellSpawnFailure(message));
    return { available: classified, producedChange: false, error: message };
  }
}

export function runnerHonestyFrom(value: unknown): HonestRunAssessment | null {
  if (!value || typeof value !== "object") return null;
  const honesty = (value as { runnerHonesty?: unknown }).runnerHonesty;
  if (!honesty || typeof honesty !== "object") return null;
  const outcome = (honesty as { outcome?: unknown }).outcome;
  if (outcome !== "succeeded" && outcome !== "failed") return null;
  const reasonCode = (honesty as { reasonCode?: unknown }).reasonCode;
  const message = (honesty as { message?: unknown }).message;
  return {
    outcome,
    reasonCode: typeof reasonCode === "string" ? reasonCode as HonestRunAssessment["reasonCode"] : null,
    message: typeof message === "string" ? message : null,
  };
}
