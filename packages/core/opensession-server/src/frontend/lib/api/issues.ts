import { request } from "./request";

/** One open GitHub issue from the repo-wide list (session or not). */
export interface OpenIssue {
  repo: string;
  ghRepo: string;
  number: number;
  title: string;
  url: string;
  body: string;
  author: string;
  /** Web user-picker key ("kent"), or null when the author isn't a teammate. */
  person: string | null;
  labels: string[];
  assignees: string[];
  comments: number;
  createdAt: string;
  updatedAt: string;
  /** The deterministic id of this issue's Open Session session, whether or
   *  not one has been started yet. */
  sessionId: string;
  /** The `os` label is on the issue: a session was asked for. */
  assigned: boolean;
}

/** Every open issue across the registered GitHub repos. */
export async function fetchOpenIssues(): Promise<OpenIssue[]> {
  const data = await request<{ issues: OpenIssue[] }>("/issues", {
    label: "Failed to fetch issues",
  });
  return data?.issues || [];
}

/** Start (or resume) an issue's session as the signed-in person. */
export function startIssueSession(input: {
  repo: string;
  number: number;
  user: string;
}): Promise<{ sessionId: string }> {
  return request<{ sessionId: string }>("/issues/start", {
    method: "POST",
    body: input,
    label: "Failed to start the session",
  });
}
