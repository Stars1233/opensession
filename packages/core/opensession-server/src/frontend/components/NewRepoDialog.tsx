import React, { useEffect, useRef, useState } from "react";
import { createRepoApi, type CreatedRepo } from "../lib/api";
import { errorMessage } from "../lib/error-message";
import { Modal } from "../ui/modal";
import { InlineAlert } from "../ui/state";
import { NewRepoForm } from "./NewRepoForm";

/**
 * "New repository" from the New session palette's Project picker: the same
 * form Settings offers, in a dialog of its own so the palette can hand the
 * new repo straight back to the picker. Creation is a few git commands on
 * the server, so unlike a clone it finishes while the dialog is still up.
 */
export function NewRepoDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (repo: CreatedRepo) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  async function create(name: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    // A promise chain rather than try/finally: the React Compiler skips a
    // component whose function carries a `finally` clause.
    await createRepoApi({ name })
      .then((repo) => {
        onOpenChange(false);
        onCreated(repo);
      })
      .catch((cause: unknown) => {
        setError(errorMessage(cause, "Failed to create the repository"));
      });
    setBusy(false);
  }

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      disablePointerDismissal={busy}
    >
      <Modal.Content widthClassName="max-w-[28rem]" initialFocus={inputRef}>
        {/* The form's own sentence says what you get; a second line here
            only repeated it. */}
        <Modal.Header title="New repository" />
        <div>
          <NewRepoForm inputRef={inputRef} busy={busy} onCreate={create} />
          {error && <InlineAlert className="mt-2.5">{error}</InlineAlert>}
        </div>
      </Modal.Content>
    </Modal.Root>
  );
}
