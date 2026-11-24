import { describe, expect, it, vi } from "vitest";
import { PgDialect, pgTable, text } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { classifyHonestRunOutcome, readIssueOpenPullRequestUrl } from "./codex-run-guards.js";

vi.mock("@paperclipai/db", () => ({
  agents: {}, issues: {}, projectWorkspaces: {},
  issueWorkProducts: pgTable("issue_work_products", {
    companyId: text("company_id"), issueId: text("issue_id"), type: text("type"),
    status: text("status"), url: text("url"),
  }),
  issueComments: pgTable("issue_comments", {
    companyId: text("company_id"), issueId: text("issue_id"), body: text("body"),
    deletedAt: text("deleted_at"), origin: text("origin"), createdAt: text("created_at"),
  }),
}));

function database(products: Array<{ url: string | null; status: string }> = [], comments: string[] = []) {
  const conditions: unknown[] = [];
  let reads = 0;
  const db = {
    select: () => {
      let rows: unknown[] = reads++ === 0 ? products : comments.map((body) => ({ body }));
      const query = {
        from: () => query,
        where: (condition: unknown) => {
          conditions.push(condition);
          const sql = new PgDialect().sqlToQuery(condition as never);
          if (sql.sql.includes('"status" not in')) {
            rows = products.filter((row) => !sql.params.includes(row.status));
          }
          return query;
        },
        orderBy: () => query,
        limit: () => query,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve),
      };
      return query;
    },
  };
  return { db: db as unknown as Db, conditions };
}

async function assess(summary: string, products: Array<{ url: string; status: string }> = [], comments: string[] = []) {
  const { db } = database(products, comments);
  const pullRequestUrl = await readIssueOpenPullRequestUrl(db, "company", "issue", summary);
  return classifyHonestRunOutcome({
    exitCode: 0, semanticResultPresent: true, reportedDisposition: "done",
    producedChange: false, changeRequired: true, pullRequestUrl,
  });
}

describe("reported pull request evidence", () => {
  const forgejo = "https://forgejo.example/acme/repo/pulls/42";

  it.each([
    `Opened PR: ${forgejo}`,
    `Open pull request: [review](${forgejo}).`,
    `HTTP 201\npr_url=${forgejo}`,
    `Created PR: https://github.com/acme/repo/pull/42`,
  ])("accepts a newly reported PR without a registered work product: %s", async (summary) => {
    expect(await assess(summary)).toMatchObject({ outcome: "succeeded", reasonCode: null });
  });

  it("reads PR reports from recent scoped comments", async () => {
    const { db, conditions } = database([], [`Opened PR: ${forgejo}`]);
    expect(await readIssueOpenPullRequestUrl(db, "company", "issue")).toBe(forgejo);
    const queries = conditions.map((condition) => new PgDialect().sqlToQuery(condition as never));
    for (const query of queries) expect(query.params).toEqual(expect.arrayContaining(["company", "issue"]));
    expect(queries[1].sql).toContain('"deleted_at" is null');
    expect(queries[1].params).toContain("comment");
  });

  it.each(["merged", "closed", "archived", "failed"])("does not revive a %s work product from text", async (status) => {
    expect(await assess(`Opened PR: ${forgejo}?tab=files#review`, [{ url: forgejo, status }], [`Opened PR: ${forgejo}`]))
      .toMatchObject({ outcome: "failed", reasonCode: "no_changes_produced" });
  });

  it.each([
    "Finished exploring the repository.",
    `Example PR: ${forgejo}`,
    `Will open PR: ${forgejo}`,
    `PR was not opened: ${forgejo}`,
    `Closed PR: ${forgejo}`,
    `Unable to open PR: ${forgejo}`,
    `I didn't open PR: ${forgejo}`,
    `Please open PR: ${forgejo}`,
    "Opened PR: https://forgejo.example/acme/repo/issues/42",
    "Opened PR: https://user:password@forgejo.example/acme/repo/pulls/42",
    "Opened PR: https://forgejo.example/acme/repo/pulls/0",
    "Opened PR: http://forgejo.example/acme/repo/pulls/42",
  ])("still requires a change without open PR evidence: %s", async (summary) => {
    expect(await assess(summary)).toMatchObject({ outcome: "failed", reasonCode: "no_changes_produced" });
  });

  it("preserves registered GitHub PR evidence", async () => {
    expect(await assess("", [{ url: "https://github.com/acme/repo/pull/42", status: "open" }]))
      .toMatchObject({ outcome: "succeeded", reasonCode: null });
  });

  it("does not revive an older opening report after a reported closure", async () => {
    for (const summary of ["", `PR is closed: ${forgejo}`]) {
      expect(await assess(summary, [], [`PR is closed: ${forgejo}`, `Opened PR: ${forgejo}`]))
        .toMatchObject({ outcome: "failed", reasonCode: "no_changes_produced" });
    }
  });
});
