/** Account names are used in both the GitHub page URL and owner/name registration. */
export function validGithubOwner(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(value);
}

/** Prefill only. The person must review visibility and confirm on GitHub. */
export function githubNewRepoUrl(owner: string, name: string): string {
  const url = new URL("https://github.com/new");
  url.search = new URLSearchParams({
    owner,
    name,
    visibility: "private",
    readme: "1",
  }).toString();
  return url.href;
}

/** GitHub has already created the repository when the person connects it here. */
export function newRepoRegistration(
  name: string,
  owner?: string,
): Record<string, string> {
  return owner
    ? { source: "github", fullName: `${owner}/${name}` }
    : { source: "new", name };
}
