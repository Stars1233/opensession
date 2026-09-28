import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { useResolvedTheme } from "./CodeHighlight";
import { ensureDiffLanguages } from "../lib/diff-languages";

/**
 * A compact, read-only version of the Files changed renderer for one tool
 * step. Line numbers stay hidden because Edit inputs carry replacement
 * snippets, not their real source positions.
 */
export function ToolInputDiff({ patch }: { patch: string }) {
  ensureDiffLanguages();
  const theme = useResolvedTheme();
  const file = (() => {
    try {
      return parsePatchFiles(patch)[0]?.files[0] ?? null;
    } catch {
      return null;
    }
  })();

  if (!file) return null;
  return (
    <div className="max-h-80 overflow-auto rounded-md bg-code-well text-label">
      <FileDiff
        key={theme}
        fileDiff={file}
        options={{
          diffStyle: "unified",
          disableFileHeader: true,
          disableLineNumbers: true,
          overflow: "wrap",
          theme: theme === "light" ? "pierre-light" : "pierre-dark",
          themeType: theme,
        }}
        disableWorkerPool
      />
    </div>
  );
}
