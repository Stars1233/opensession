import React, { useState } from "react";
import { validNewRepoName } from "../../shared/repo-name";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/**
 * The fields for starting a repository on this server: a name, and the one
 * sentence that says what you get. Shared by Settings → Repositories (as the
 * third source next to Remote and Local folder) and the New session palette's
 * dialog, so the two never ask for different things. The caller owns the
 * request: this only knows when the name is good enough to send.
 */
export function NewRepoForm({
  inputRef,
  busy,
  onCreate,
}: {
  inputRef?: React.RefObject<HTMLInputElement | null>;
  /** A create is in flight: the field and button wait for it. */
  busy: boolean;
  onCreate: (name: string) => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const trimmed = name.trim();
  const valid = validNewRepoName(trimmed);

  function submit() {
    if (!valid || busy) return;
    void onCreate(trimmed);
  }

  return (
    <>
      <div className="text-supporting leading-relaxed text-dim">
        Starts an empty repository on this server with a first commit on{" "}
        <code>main</code>. Sessions get branches, diffs and review right away.
        Publish it to GitHub from a session whenever you are ready.
      </div>
      <div className="mt-2.5 flex items-center gap-2 phone:flex-col phone:items-stretch">
        <Input
          ref={inputRef}
          className="min-w-0 flex-1 font-mono"
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
        <Button variant="primary" disabled={!valid || busy} onClick={submit}>
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
