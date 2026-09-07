import React, { use, useCallback, useEffect, useState } from "react";
import { NavigationContext } from "../hooks/useNavigation";
import { Popover } from "../ui/popover";
import { cn } from "../ui/cn";
import { fetchSandboxStatus } from "../lib/api/automations";
import { ApiError } from "../lib/api/request";
import {
  attachSandbox,
  fetchSessionSandbox,
  openSandboxDesktop,
  sandboxAction,
  type SessionSandboxStatus,
} from "../lib/api/sandboxes";
import {
  readySandboxProviders,
  sandboxProviderLabel,
} from "../lib/ready-sandbox-providers";
import { IconBox, IconConnections, IconServer } from "./icons";
import { errorMessage } from "../lib/error-message";
import { getCurrentUser } from "./UserPicker";

type SandboxRef = {
  provider: string;
  sandboxId?: string;
  workspace?: "bind" | "volume";
  lifecycle?: NonNullable<SessionSandboxStatus["lifecycle"]>;
};

/** What decides whether a host session may move into a Sandbox. */
type HostRef = {
  mode?: string;
  repo?: string;
  automation?: string;
  automationId?: string;
  isRunning?: boolean;
};

type RunnerRef = {
  id: string;
  name: string;
  workspacePath: string;
  lifecycle?: "preparing" | "awake" | "offline" | "needs_attention";
  lastLifecycleError?: string;
};

const actionClass =
  "flex min-h-10 w-full items-center rounded-md px-2.5 text-left text-xs font-semibold text-dim outline-none transition-[color,background-color,scale] hover:bg-hover hover:text-fg focus-visible:bg-hover focus-visible:text-fg active:scale-[0.96] disabled:pointer-events-none disabled:opacity-45";

const triggerClass =
  "flex h-8 flex-none items-center gap-1.5 rounded-md border border-line bg-surface px-2 text-meta font-medium text-dim outline-none transition-[color,background-color,border-color,scale] hover:border-line-strong hover:text-fg focus-visible:border-line-strong active:scale-[0.96]";

/** The host counterpart of the Sandbox badge: where a code session runs when
 * it has no Sandbox, and the way to move it into one. Once the move lands the
 * session carries a `sandbox` record and the parent renders the Sandbox badge
 * instead, so this never has to show the provisioning itself. */
function HostBadge({ sessionId, host }: { sessionId: string; host: HostRef }) {
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState<string[] | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [moved, setMoved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchSandboxStatus(getCurrentUser())
      .then((status) => {
        if (!cancelled) setProviders(readySandboxProviders(status));
      })
      .catch(() => {
        if (!cancelled) setProviders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function move(provider: string) {
    setWorking(provider);
    setError(null);
    await attachSandbox(sessionId, provider)
      .catch(async (cause: unknown) => {
        // 428: work that exists only here would stay behind. Ask, then move.
        if (!(cause instanceof ApiError) || cause.status !== 428) throw cause;
        if (!window.confirm(cause.message)) return null;
        return attachSandbox(sessionId, provider, { confirm: true });
      })
      .then(async (status) => {
        if (status) setMoved(provider);
      })
      .catch(async (cause: unknown) => {
        setError(errorMessage(cause, "Could not move to a Sandbox"));
      })
      .finally(async () => {
        setWorking(null);
      });
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className={triggerClass}
        data-testid="host-badge"
        aria-label="Runs on this machine"
      >
        <IconServer size={20} className="text-faint" />
        <span>This machine</span>
      </Popover.Trigger>
      <Popover.Popup
        side="bottom"
        align="start"
        initialFocus
        className="w-[300px] p-2.5"
      >
        <div className="px-2 pb-2 pt-1">
          <div className="flex items-center gap-2 text-xs font-semibold text-fg">
            <span>This machine</span>
            <span className="ml-auto font-medium text-faint">Runtime</span>
          </div>
          <div className="mt-1 text-meta text-dim">
            {moved
              ? `Moving to ${sandboxProviderLabel(moved)}. The Sandbox is starting; the next message runs there.`
              : "Runs on the Open Session host, in this session's worktree"}
          </div>
        </div>
        {moved ? null : providers === null ? (
          <div className="px-2.5 py-2 text-meta text-dim">
            Checking Sandboxes…
          </div>
        ) : providers.length === 0 ? (
          <div className="px-2.5 py-2 text-meta text-dim">
            No Sandbox is ready. Connect Daytona or Box in Workspace &gt;
            Sandboxes.
          </div>
        ) : (
          <>
            <div className="px-2.5 pb-1.5 text-meta text-dim">
              The Sandbox starts now, clones this branch from origin, and takes
              over on the next message. Portals on this machine stop.
            </div>
            {providers.map((provider) => (
              <button
                key={provider}
                className={actionClass}
                disabled={Boolean(working) || host.isRunning}
                onClick={() => void move(provider)}
              >
                {working === provider
                  ? `Moving to ${sandboxProviderLabel(provider)}…`
                  : `Move to ${sandboxProviderLabel(provider)}`}
              </button>
            ))}
            {host.isRunning ? (
              <div className="px-2.5 py-1.5 text-meta text-dim">
                Available once the agent finishes.
              </div>
            ) : null}
          </>
        )}
        {error ? (
          <div className="px-2 py-1.5 text-meta font-medium text-red">
            {error}
          </div>
        ) : null}
      </Popover.Popup>
    </Popover.Root>
  );
}

function canMoveToSandbox(host: HostRef | undefined): host is HostRef {
  return (
    !!host &&
    host.mode === "code" &&
    !!host.repo &&
    !host.automation &&
    !host.automationId
  );
}

/** Live sandbox status + lifecycle controls. The compact trigger remains the
 * old provider badge; opening it resolves provider state without polling every
 * session row in the background. */
export function SandboxBadge({
  sessionId,
  sandbox,
  runner,
  host,
}: {
  sessionId: string;
  sandbox?: SandboxRef;
  runner?: RunnerRef;
  /** Pass the session to offer "This machine" with a move into a Sandbox
   * when it has neither a Sandbox nor a Runner. */
  host?: HostRef;
}) {
  const [open, setOpen] = useState(false);
  // Null outside the app shell (a bare badge in a test); then the desktop
  // falls back to a browser tab.
  const navigation = use(NavigationContext);
  const [status, setStatus] = useState<SessionSandboxStatus | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    await (async () => {
      setStatus(await fetchSessionSandbox(sessionId));
      setError(null);
    })().catch(async (cause) => {
      setError(errorMessage(cause, "Sandbox status unavailable"));
    });
  }, [sessionId]);

  useEffect(() => {
    if (runner) return;
    if (!open) return;
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [open, load, runner]);

  if (runner) {
    const label =
      runner.lifecycle === "awake"
        ? "Ready"
        : runner.lifecycle === "offline"
          ? "Offline"
          : runner.lifecycle === "needs_attention"
            ? "Needs attention"
            : "Preparing";
    const dot =
      runner.lifecycle === "awake"
        ? "bg-green"
        : runner.lifecycle === "offline" ||
            runner.lifecycle === "needs_attention"
          ? "bg-faint"
          : "bg-yellow";
    return (
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          className="flex h-8 flex-none items-center gap-1.5 rounded-md border border-line bg-surface px-2 text-meta font-medium text-dim outline-none transition-[color,background-color,border-color,scale] hover:border-line-strong hover:text-fg focus-visible:border-line-strong active:scale-[0.96]"
          aria-label={`Runner · ${runner.name} · ${label}`}
        >
          <span className={cn("size-2 rounded-full", dot)} aria-hidden="true" />
          <IconConnections size={20} className="text-faint" />
          <span>{runner.name}</span>
        </Popover.Trigger>
        <Popover.Popup
          side="bottom"
          align="start"
          initialFocus
          className="w-[300px] p-2.5"
        >
          <div className="px-2 pb-2 pt-1">
            <div className="flex items-center gap-2 text-xs font-semibold text-fg">
              <span className={cn("size-2 rounded-full", dot)} />
              <span>{label}</span>
              <span className="ml-auto font-medium text-faint">Runtime</span>
            </div>
            <div className="mt-1 text-meta text-dim">
              Runner · trusted machine
            </div>
            <div
              className="mt-1 truncate font-mono text-meta text-faint"
              title={runner.workspacePath}
            >
              {runner.workspacePath}
            </div>
          </div>
          {runner.lastLifecycleError ? (
            <div className="px-2 py-1.5 text-meta font-medium text-red">
              {runner.lastLifecycleError}
            </div>
          ) : null}
        </Popover.Popup>
      </Popover.Root>
    );
  }

  if (!sandbox?.provider || sandbox.provider === "local") {
    return canMoveToSandbox(host) ? (
      <HostBadge sessionId={sessionId} host={host} />
    ) : null;
  }
  const state = status?.status || (sandbox.sandboxId ? "running" : "gone");
  // Before the popover has fetched anything, the session row's recorded
  // lifecycle is the truth: a Sandbox with no id yet is Preparing, not gone.
  const lifecycle =
    status?.lifecycle ||
    sandbox.lifecycle ||
    (state === "running"
      ? "awake"
      : state === "stopped"
        ? "sleeping"
        : "needs_attention");
  const lifecycleLabel: Record<typeof lifecycle, string> = {
    preparing: "Preparing",
    awake: "Awake",
    sleeping: "Sleeping",
    waking: "Waking",
    needs_attention: "Needs attention",
  };
  const dot =
    lifecycle === "awake"
      ? "bg-green"
      : lifecycle === "sleeping" || lifecycle === "waking"
        ? "bg-yellow"
        : "bg-faint";

  async function act(action: "pause" | "resume" | "recreate") {
    if (
      action === "recreate" &&
      !window.confirm(
        "Recreate this sandbox? Unpushed files that exist only inside it will be deleted.",
      )
    )
      return;
    setWorking(action);
    setError(null);
    await (async () => {
      setStatus(await sandboxAction(sessionId, action));
    })()
      .catch(async (cause) => {
        setError(errorMessage(cause, `Could not ${action} sandbox`));
      })
      .finally(async () => {
        setWorking(null);
      });
  }

  async function openDesktop() {
    // Inside the app the desktop is a view tab next to Review and Terminal.
    if (navigation) {
      setOpen(false);
      navigation.openDesktop();
      return;
    }
    // Without a workspace to host the tab, open the desktop in a browser tab
    // inside the click so popup blockers allow it, then point it at the
    // minted URL once the provider answers.
    const tab = window.open("", "_blank");
    setWorking("desktop");
    setError(null);
    await (async () => {
      const desktop = await openSandboxDesktop(sessionId);
      if (tab) {
        tab.opener = null;
        tab.location.href = desktop.url;
      } else {
        window.location.assign(desktop.url);
      }
    })()
      .catch(async (cause) => {
        tab?.close();
        setError(errorMessage(cause, "Could not open the desktop"));
      })
      .finally(async () => {
        setWorking(null);
      });
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className="flex h-8 flex-none items-center gap-1.5 rounded-md border border-line bg-surface px-2 text-meta font-medium text-dim outline-none transition-[color,background-color,border-color,scale] hover:border-line-strong hover:text-fg focus-visible:border-line-strong active:scale-[0.96]"
        data-testid="sandbox-badge"
        aria-label={`Sandbox · ${lifecycleLabel[lifecycle]}`}
      >
        <span className={cn("size-2 rounded-full", dot)} aria-hidden="true" />
        <IconBox size={20} className="text-faint" />
        <span>Sandbox</span>
      </Popover.Trigger>
      <Popover.Popup
        side="bottom"
        align="start"
        initialFocus
        className="w-[300px] p-2.5"
      >
        <div className="px-2 pb-2 pt-1">
          <div className="flex items-center gap-2 text-xs font-semibold text-fg">
            <span className={cn("size-2 rounded-full", dot)} />
            <span>{lifecycleLabel[lifecycle]}</span>
            <span className="ml-auto font-medium text-faint">Runtime</span>
          </div>
          <div className="mt-1 text-meta text-dim">
            Its own machine · sleeps between turns
          </div>
          {status?.cwd ? (
            <div
              className="mt-1 truncate font-mono text-meta text-faint"
              title={status.cwd}
            >
              {status.cwd}
            </div>
          ) : null}
        </div>
        {lifecycle === "awake" && status?.canDesktop ? (
          <button
            className={actionClass}
            disabled={Boolean(working)}
            onClick={() => void openDesktop()}
          >
            {working === "desktop" ? "Opening desktop…" : "Open desktop"}
          </button>
        ) : null}
        {lifecycle === "awake" && status?.canPause ? (
          <button
            className={actionClass}
            disabled={Boolean(working || status.busy)}
            onClick={() => void act("pause")}
          >
            {working === "pause" ? "Sleeping…" : "Sleep sandbox"}
          </button>
        ) : null}
        {(lifecycle === "sleeping" || lifecycle === "needs_attention") &&
        status?.canResume ? (
          <button
            className={actionClass}
            disabled={Boolean(working)}
            onClick={() => void act("resume")}
          >
            {working === "resume" ? "Waking…" : "Wake sandbox"}
          </button>
        ) : null}
        {status?.materialized !== false || state !== "gone" ? (
          <button
            className={cn(actionClass, "text-red hover:text-red")}
            disabled={Boolean(working || status?.busy)}
            onClick={() => void act("recreate")}
          >
            {working === "recreate"
              ? "Recreating…"
              : "Recreate from clean image"}
          </button>
        ) : null}
        {status?.logs?.setup || status?.logs?.resume ? (
          <details className="mt-1 rounded-md bg-surface px-2.5 py-2 text-meta text-dim">
            <summary className="cursor-pointer font-semibold text-fg">
              Lifecycle logs
            </summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-meta leading-relaxed">
              {status.logs.setup ? `setup\n${status.logs.setup}` : ""}
              {status.logs.resume ? `\nresume\n${status.logs.resume}` : ""}
            </pre>
          </details>
        ) : null}
        {status?.lastLifecycleError || error ? (
          <div className="px-2 py-1.5 text-meta font-medium text-red">
            {status?.lastLifecycleError || error}
          </div>
        ) : null}
      </Popover.Popup>
    </Popover.Root>
  );
}
