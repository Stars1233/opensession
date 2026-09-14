/**
 * GitHub issues: the open-issue list behind the Issues page, and the button
 * that starts an issue's Open Session session from there (the in-app twin of
 * the `os` label).
 */
import { requestUser, type RouteContext } from "./context";
import { conditionalJsonResponse } from "../http-json";
import { githubLoginFor, isTrustedGithubLogin } from "../shared/user-mappings";
import { getRepo } from "../worktree";

export async function handleIssuesRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;

  if (path === "/api/issues" && req.method === "GET") {
    const { getOpenIssues } = await import("../issue-cache");
    return conditionalJsonResponse(req, { issues: await getOpenIssues() });
  }

  // Start (or resume) the issue's session for the signed-in person. The run
  // is attributed to their GitHub login and gated by the same roster check
  // the webhook applies, so a person the label path would refuse is refused
  // here too. The `os` label is added for visibility on GitHub; the webhook
  // ignores that bot-sent label event, so this does not start a second run.
  if (path === "/api/issues/start" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    const number = Number(body?.number);
    if (!Number.isInteger(number) || number < 1)
      return Response.json({ error: "number required" }, { status: 400 });
    let ghRepo = "";
    try {
      ghRepo = getRepo(
        typeof body?.repo === "string" ? body.repo : undefined,
      ).ghRepo;
    } catch {
      return Response.json({ error: "Unknown repo" }, { status: 400 });
    }
    if (!ghRepo)
      return Response.json(
        { error: "This repo has no GitHub issues" },
        { status: 400 },
      );
    const login = githubLoginFor(requestUser(ctx, body?.user));
    if (!login || !isTrustedGithubLogin(login))
      return Response.json(
        {
          error:
            "Your account needs a GitHub login on the team roster to start issue sessions",
        },
        { status: 403 },
      );
    const [{ runIssueSession }, { bksIdFor }, { invalidateIssueCache }] =
      await Promise.all([
        import("../../agents/github/issue"),
        import("../../agents/github/run"),
        import("../issue-cache"),
      ]);
    const sessionId = bksIdFor(number, "issue", ghRepo);
    void runIssueSession({
      issueNumber: number,
      author: login,
      body: "",
      ghRepo,
    }).catch((e) =>
      console.error(`[issues] session start failed for #${number}:`, e),
    );
    void import("../../agents/github/github-rest")
      .then(async ({ githubRequest }) => {
        const { LABEL_ISSUE } = await import("../../agents/github/constants");
        await githubRequest(
          "POST",
          `/repos/${ghRepo}/issues/${number}/labels`,
          { labels: [LABEL_ISSUE] },
        );
        invalidateIssueCache();
      })
      .catch(() => {});
    return Response.json({ sessionId });
  }

  return undefined;
}
