import { UNDO_SHORTCUT_KEYS } from "../../lib/undo";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { Tooltip } from "../../ui/tooltip";
import { IconUndo } from "../icons";

/**
 * The undo glyph that sits in front of the merge button during its
 * five-second window. The merge button itself stays put and reads
 * "Merging…", so cancelling never moves the thing the user just pressed.
 */
export function MergeUndoControl({
  onUndo,
  compact = false,
  className,
}: {
  onUndo: () => void;
  compact?: boolean;
  className?: string;
}) {
  return (
    <Tooltip label="Undo merge" shortcut={UNDO_SHORTCUT_KEYS}>
      <Button
        variant="ghost"
        size={compact ? "sm" : "md"}
        aria-label="Undo merge"
        onClick={onUndo}
        icon={<IconUndo size={compact ? 18 : 20} />}
        className={cn("shrink-0 text-dim", className)}
      />
    </Tooltip>
  );
}
