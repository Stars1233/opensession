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
 *
 * The registry is a plain object keyed by the lower-cased name, and the update
 * route refuses the three ids that collide with Object's prototype, so they
 * are not names either: a repo you could create but never edit is worse than
 * a refused name.
 */
const NEW_REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const PROTOTYPE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function validNewRepoName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    NEW_REPO_NAME_RE.test(value) &&
    !value.includes("..") &&
    !/\.git$/i.test(value) &&
    !PROTOTYPE_KEYS.has(value.toLowerCase())
  );
}
