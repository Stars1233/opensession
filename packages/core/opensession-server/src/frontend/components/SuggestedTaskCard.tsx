import React, { use, useRef, useState } from "react";
import {
  suggestedTaskLink,
  type SuggestedTask,
} from "@tellahq/opensession-protocol/tool-presentation";
import { NavigationContext } from "../hooks/useNavigation";
import { createSessionApi } from "../lib/api";
import { BASE_PATH } from "../lib/base";
import { TOOL_CODE_WELL, TOOL_PRE } from "../lib/tool-classes";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { cn } from "../ui/cn";
import { Disclosure } from "../ui/disclosure";
import { toast } from "../ui/toast";
import { IconPlay } from "./icons";
import { getCurrentUser } from "./UserPicker";

/**
 * A follow-up the agent proposed with `suggest_task`: work it judged worth
 * doing but out of scope for what it was asked. The agent proposes, the person
 * decides. Nothing has run until "Start session" is pressed; that creates a
 * new session from the instructions and opens it, so the new session is the
 * person's own rather than a worker the agent spawned. The instructions sit
 * folded under the card for anyone who wants to read them first.
 *
 * The button is an anchor to the same `/new?prompt=` link the tool result
 * carries, so cmd-click, middle-click and copy-link still open a prefilled
 * composer; only a plain click starts the session in place.
 */
export function SuggestedTaskCard({ task }: { task: SuggestedTask }) {
  // Null outside the app shell (a card in a test); the href then does what
  // the in-place start would have.
  const navigation = use(NavigationContext);
  const [starting, setStarting] = useState(false);
  // One id per card, so a second press while the first is in flight, or a
  // retry after a network error, lands on the same session.
  const requestIdRef = useRef<string | null>(null);
  const href = `${BASE_PATH}${suggestedTaskLink(task)}`;

  async function start(e: React.MouseEvent<HTMLAnchorElement>) {
    // A modified click keeps the browser's meaning: cmd-click a tab, shift a
    // window. Only a plain primary click is taken in place.
    if (
      !navigation ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey ||
      e.button !== 0
    )
      return;
    e.preventDefault();
    if (starting) return;
    setStarting(true);
    if (!requestIdRef.current) requestIdRef.current = crypto.randomUUID();
    try {
      const { id } = await createSessionApi({
        prompt: task.instructions,
        user: getCurrentUser(),
        requestId: requestIdRef.current,
        repo: task.repo,
        branch: task.branch,
        mode: task.mode ?? "code",
      });
      navigation.openSession(id);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    }
    setStarting(false);
  }

  return (
    <Card as="article" data-suggested-task className="px-3.5 py-3">
      <div className="flex items-start gap-3 phone:flex-col phone:items-stretch">
        <div className="min-w-0 flex-1">
          <div className="text-meta leading-4 text-faint">
            Suggested task
            {task.repo ? ` · ${task.repo}` : ""}
            {task.mode === "ask" ? " · read-only" : ""}
          </div>
          <div className="mt-0.5 text-label font-semibold leading-5 text-fg">
            {task.title}
          </div>
          {task.description && (
            <p className="m-0 mt-0.5 text-label leading-5 text-dim">
              {task.description}
            </p>
          )}
        </div>
        <Button
          variant="primary"
          size="sm"
          className="shrink-0 phone:min-h-11"
          icon={<IconPlay />}
          disabled={starting}
          render={<a href={href} onClick={start} />}
        >
          {starting ? "Starting" : "Start session"}
        </Button>
      </div>
      <Disclosure title="Instructions" className="mt-1.5">
        <pre className={cn(TOOL_PRE, TOOL_CODE_WELL)}>{task.instructions}</pre>
      </Disclosure>
    </Card>
  );
}
