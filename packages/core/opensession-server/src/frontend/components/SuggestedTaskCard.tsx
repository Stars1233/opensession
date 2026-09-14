import React, { use } from "react";
import {
  suggestedTaskLink,
  type SuggestedTask,
} from "@tellahq/opensession-protocol/tool-presentation";
import { NavigationContext } from "../hooks/useNavigation";
import { BASE_PATH } from "../lib/base";
import { TOOL_CODE_WELL, TOOL_PRE } from "../lib/tool-classes";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { cn } from "../ui/cn";
import { AnimatedCheck, useCopy } from "../ui/copy";
import { Disclosure } from "../ui/disclosure";
import { IconCopy, IconPlay } from "./icons";

/**
 * A follow-up the agent proposed with `suggest_task`: work it judged worth
 * doing but out of scope for what it was asked. The agent proposes, the person
 * decides. Nothing has run: "Start in a new session" opens the composer
 * prefilled with the instructions, so the prompt is read and adjustable before
 * it is sent, and the new session is the person's own rather than a worker
 * the agent spawned.
 *
 * The button is an anchor to the same `/new?prompt=` link the tool result
 * carries, so cmd-click, middle-click and copy-link keep their meaning; a
 * plain click opens the palette in place through the app's navigation.
 */
export function SuggestedTaskCard({ task }: { task: SuggestedTask }) {
  // Null outside the app shell (a card in a test); the href then does what
  // the in-place open would have.
  const navigation = use(NavigationContext);
  const { copied, copy } = useCopy();
  const href = `${BASE_PATH}${suggestedTaskLink(task)}`;

  function start(e: React.MouseEvent<HTMLAnchorElement>) {
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
    navigation.openPrefilledSession({
      prompt: task.instructions,
      repo: task.repo,
      branch: task.branch,
      mode: task.mode ?? "code",
    });
  }

  return (
    <Card as="article" data-suggested-task className="px-4 py-3.5 phone:px-3.5">
      <div className="text-meta font-medium leading-4 text-faint">
        Suggested task
        {task.repo ? ` · ${task.repo}` : ""}
        {task.mode === "ask" ? " · read-only" : ""}
      </div>
      <div className="mt-1 text-item-title font-semibold leading-5 text-fg">
        {task.title}
      </div>
      {task.description && (
        <p className="m-0 mt-1 text-label leading-5 text-dim">
          {task.description}
        </p>
      )}
      <Disclosure title="Instructions" className="mt-2">
        <pre className={cn(TOOL_PRE, TOOL_CODE_WELL)}>{task.instructions}</pre>
      </Disclosure>
      {/* One answer on the card, so one primary; the copy beside it is a
          plate, not a second raised control. Phones stack the pair full
          width so both clear the 44px touch target. */}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2 phone:flex-col phone:items-stretch">
        <Button
          variant="soft"
          className="phone:min-h-11"
          icon={copied ? <AnimatedCheck size={20} /> : <IconCopy />}
          onClick={() =>
            copy(task.instructions, { toast: "Instructions copied" })
          }
        >
          Copy instructions
        </Button>
        <Button
          variant="primary"
          className="phone:min-h-11"
          icon={<IconPlay />}
          render={<a href={href} onClick={start} />}
        >
          Start in a new session
        </Button>
      </div>
    </Card>
  );
}
