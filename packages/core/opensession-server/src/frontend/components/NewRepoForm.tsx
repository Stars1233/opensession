import React, { useEffect, useState } from "react";
import { validNewRepoName } from "../../shared/repo-name";
import { fetchGithubOwnersApi, type GithubOwner } from "../lib/api/repos";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select } from "../ui/select";

/** The location picker's value for a repository that lives only here. */
const SERVER_ONLY = "";

/**
 * The fields for starting a repository: where it lives, a name, and the one
 * sentence that says what you get. Shared by Settings → Repositories (as the
 * third source next to Remote and Local folder) and the New session palette's
 * dialog, so the two never ask for different things. The caller owns the
 * request: this only knows when the name is good enough to send.
 *
 * "Where" is a GitHub organization the App is installed on, or this server
 * alone. GitHub lets an installation create repositories only in an
 * organization, so a personal account is not offered; the repository is
 * always private, with no toggle, because a new project has no reason to be
 * public on its first commit.
 */
export function NewRepoForm({
  inputRef,
  busy,
  onCreate,
}: {
  inputRef?: React.RefObject<HTMLInputElement | null>;
  /** A create is in flight: the fields and button wait for it. */
  busy: boolean;
  /** `owner` is the GitHub organization, or undefined for server-only. */
  onCreate: (name: string, owner: string | undefined) => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [owners, setOwners] = useState<GithubOwner[] | null>(null);
  const [ownersError, setOwnersError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  // null until the person picks: the default follows the App's installations
  // once they load, without overriding a choice already made.
  const [chosenOwner, setChosenOwner] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setOwners(null);
    setOwnersError(null);
    fetchGithubOwnersApi()
      .then((result) => {
        if (!live) return;
        setOwners(result.owners ?? []);
        if (result.appConfigured && result.owners === null) {
          setOwnersError(
            "Could not load GitHub owners. Retry or choose this server only.",
          );
        }
      })
      .catch(() => {
        if (!live) return;
        setOwners([]);
        setOwnersError(
          "Could not load GitHub owners. Retry or choose this server only.",
        );
      });
    return () => {
      live = false;
    };
  }, [loadAttempt]);

  const organizations = (owners ?? []).filter(
    (owner) => owner.type === "Organization",
  );
  const defaultOwner =
    organizations.find((owner) => owner.selected)?.login ??
    organizations[0]?.login ??
    SERVER_ONLY;
  const owner = chosenOwner ?? defaultOwner;
  const ownerOptions = [
    ...organizations.map((organization) => ({
      value: organization.login,
      label: `${organization.login} on GitHub`,
    })),
    { value: SERVER_ONLY, label: "This server only" },
  ];
  const trimmed = name.trim();
  const valid = validNewRepoName(trimmed);

  function submit() {
    if (!valid || busy || owners === null) return;
    void onCreate(trimmed, owner === SERVER_ONLY ? undefined : owner);
  }

  return (
    <>
      <div className="text-supporting leading-relaxed text-dim">
        {owners === null ? (
          "Loading GitHub owners…"
        ) : owner === SERVER_ONLY ? (
          <>
            Starts an empty repository on this server with a first commit on{" "}
            <code>main</code>. Sessions get branches, diffs and local review,
            but no GitHub pull requests. Choose a GitHub owner for PR support.
          </>
        ) : (
          <>
            Creates a private repository in <strong>{owner}</strong> on GitHub
            with a first commit, and clones it here. Sessions get branches,
            diffs, pull requests and review right away.
          </>
        )}
      </div>
      {owners !== null && (
        <div className="mt-2.5 flex items-center gap-2 phone:flex-col phone:items-stretch">
          <span className="shrink-0 text-supporting text-dim">Owner</span>
          <Select.Root
            items={ownerOptions}
            value={owner}
            onValueChange={(next) => {
              if (next !== null) setChosenOwner(next);
            }}
            disabled={busy}
          >
            <Select.Trigger
              className="min-w-0 flex-1 phone:min-h-11"
              size="sm"
              aria-label="Repository owner"
            />
            <Select.Popup>
              {ownerOptions.map((option) => (
                <Select.Item
                  key={option.value}
                  value={option.value}
                  className="phone:min-h-11"
                >
                  {option.label}
                </Select.Item>
              ))}
            </Select.Popup>
          </Select.Root>
        </div>
      )}
      {ownersError && (
        <div role="status" className="mt-2.5 text-supporting text-dim">
          {ownersError}{" "}
          <Button
            variant="ghost"
            className="phone:min-h-11"
            disabled={busy}
            onClick={() => setLoadAttempt((attempt) => attempt + 1)}
          >
            Retry
          </Button>
        </div>
      )}
      {owners?.some((account) => account.type === "User") &&
        organizations.length === 0 && (
          <div className="mt-2.5 text-supporting text-dim">
            GitHub Apps can only create repositories in organizations. Install
            the App on an organization, or create on github.com and add a remote
            repository.
          </div>
        )}
      <div className="mt-2.5 flex items-center gap-2 phone:flex-col phone:items-stretch">
        <Input
          ref={inputRef}
          className="min-w-0 flex-1 font-mono phone:min-h-11 phone:text-input-phone"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-project"
          aria-label="Repository name"
          disabled={busy}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
        <Button
          variant="primary"
          className="phone:min-h-11"
          disabled={!valid || busy || owners === null}
          onClick={submit}
        >
          {busy ? "Creating…" : "Create"}
        </Button>
      </div>
      {trimmed && !valid && (
        <div className="mt-1.5 text-meta text-faint">
          Letters, digits, dots, dashes and underscores, starting with a letter
          or digit.
        </div>
      )}
    </>
  );
}
