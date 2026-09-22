import * as React from "react";
import { Collapsible, collapsiblePanelClasses } from "./collapsible";
import { cn } from "./cn";

/**
 * Fold — animates a region's height between open and closed.
 *
 * The session transcript folds whole turns and grouped tool runs: regions
 * whose height is anything from one row to many screens. A fixed-distance
 * animation cannot fit both, so Base UI measures the panel for its open/close
 * keyframes. At rest it uses natural height, letting nested folds and live
 * content grow it. A 40px run and a 4000px turn take the same motion. Content
 * stays mounted through the close animation and unmounts after it, keeping
 * the fold's own perf win.
 *
 * Bring your own trigger: this is the panel half only, for surfaces whose
 * disclosure row is already richer than a title (the turn header carries
 * stats, live status, media labels). For a titled block dropped into a page,
 * `Disclosure` is the opinionated form.
 *
 * Reduced motion is handled globally in base.css, which flattens the
 * animation to ~0ms.
 */
export function Fold({
  open,
  className,
  panelClassName,
  children,
}: {
  open: boolean;
  className?: string;
  panelClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <Collapsible.Root open={open} className={cn("min-w-0", className)}>
      <Collapsible.Panel
        className={cn(collapsiblePanelClasses, panelClassName)}
      >
        {children}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
