/**
 * The name a brand-new repository may take. One rule for the server (which
 * turns it into a directory under ~/checkouts and a registry id) and the
 * client (which disables Create until the name would pass), so the form never
 * submits a name the route would refuse.
 *
 * Letters, digits, `.`, `_` and `-`, starting with a letter or digit, at most
 * 100 characters: the GitHub repository-name grammar, so a repo made here can
 * be published under the same name later. `.git` is refused rather than
 * stripped because the bare origin lives beside the checkout as `<name>.git`.
 */
const NEW_REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function validNewRepoName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    NEW_REPO_NAME_RE.test(value) &&
    !value.includes("..") &&
    !/\.git$/i.test(value)
  );
}
