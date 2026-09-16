---
name: react-devtools
description: React DevTools CLI for AI agents. Use when the user asks you to debug a React or React Native app at runtime, inspect component props/state/hooks, diagnose render performance, profile re-renders, find slow components, or understand why something re-renders. Triggers include "why does this re-render", "inspect the component", "what props does X have", "profile the app", "find slow components", "debug the UI", "check component state", "the app feels slow", or any React runtime debugging task.
allowed-tools: Bash(agent-react-devtools:*)
---

# agent-react-devtools

CLI that connects to a running React or React Native app via the React DevTools protocol and exposes the component tree, props, state, hooks, and profiling data in a token-efficient format.

## Core Workflow

1. **Ensure connection** — check `agent-react-devtools status`. If the daemon is not running, start it with `agent-react-devtools start`. Use `agent-react-devtools wait --connected` to block until a React app connects.
2. **Inspect** — get the component tree, search for components, inspect props/state/hooks.
3. **Profile** — start profiling, trigger the interaction (or ask the user to), stop profiling, analyze results.
4. **Act** — use the data to fix the bug, optimize performance, or explain what's happening.

## Essential Commands

### Daemon

```bash
agent-react-devtools start              # Start daemon (auto-starts on first command)
agent-react-devtools stop               # Stop daemon
agent-react-devtools status             # Check connection, component count, last event
agent-react-devtools wait --connected   # Block until a React app connects
agent-react-devtools wait --component App # Block until a component appears
```

### Component Inspection

```bash
agent-react-devtools get tree           # Full component hierarchy (labels: @c1, @c2, ...)
agent-react-devtools get tree --depth 3 # Limit depth
agent-react-devtools get component @c5  # Props, state, hooks for a specific component
agent-react-devtools find Button        # Search by display name (fuzzy)
agent-react-devtools find Button --exact # Exact match
agent-react-devtools count              # Count by type: fn, cls, host, memo, ...
agent-react-devtools errors             # List components with errors or warnings
```

### Performance Profiling

```bash
agent-react-devtools profile start              # Start recording
agent-react-devtools profile stop               # Stop and collect data
agent-react-devtools profile slow               # Slowest components by avg render time
agent-react-devtools profile slow --limit 10    # Top 10
agent-react-devtools profile rerenders          # Most re-rendered components
agent-react-devtools profile report @c5         # Detailed report for one component
agent-react-devtools profile timeline --limit 10                        # First 10 commits (use --limit; uncapped can dump 300+ lines)
agent-react-devtools profile timeline --limit 10 --offset 10           # Next 10 (pagination)
agent-react-devtools profile timeline --sort duration --limit 5        # Top 5 most expensive commits
agent-react-devtools profile timeline --sort timeline --limit 5        # Explicit chronological order (same as default)
agent-react-devtools profile commit 3           # Detail for commit #3
agent-react-devtools profile export profile.json # Export as React DevTools Profiler JSON
agent-react-devtools profile diff before.json after.json  # Compare two exports
```

## Understanding the Output

### Component Labels

Every component gets a stable label like `@c1`, `@c2`. Use these to reference components in follow-up commands:

```
@c1 [fn] App
├─ @c2 [fn] Header
├─ @c3 [fn] TodoList
│  ├─ @c4 [fn] TodoItem key=1
│  └─ @c5 [fn] TodoItem key=2
└─ @c6 [host] div
```

Type abbreviations: `fn` = function, `cls` = class, `host` = DOM element, `memo` = React.memo, `fRef` = forwardRef, `susp` = Suspense, `ctx` = context.

Components with errors or warnings show annotations: `⚠2` = 2 warnings, `✗1` = 1 error. Use `agent-react-devtools errors` to list only affected components.

### Inspected Component

```
@c3 [fn] TodoList
props:
  items: [{"id":1,"text":"Buy milk"},{"id":2,"text":"Walk dog"}]
  onDelete: ƒ
state:
  filter: "all"
hooks:
  useState: "all"
  useMemo: [...]
  useCallback: ƒ
```

`ƒ` = function value. Values over 60 chars are truncated.

### Profiling Output

```
Slowest (by avg render time):
  @c3 [fn] ExpensiveList  avg:12.3ms  max:18.1ms  renders:47  causes:props-changed  changed: props: items, filter
  @c4 [fn] TodoItem  avg:2.1ms  max:5.0ms  renders:94  causes:parent-rendered, props-changed  changed: props: onToggle
```

Render causes: `props-changed`, `state-changed`, `hooks-changed`, `parent-rendered`, `force-update`, `first-mount`.

When specific changed keys are available, a `changed:` suffix shows exactly which props, state keys, or hooks triggered the render (e.g. `changed: props: onClick, className  state: count  hooks: #0`).

## Common Patterns

### Wait for the app to connect after a reload

```bash
agent-react-devtools wait --connected --timeout 10
agent-react-devtools get tree
```

Use this after triggering a page reload or HMR update to avoid querying empty state.

### Diagnose slow interactions

```bash
agent-react-devtools profile start
# User interacts with the app (or use agent-browser to drive the UI)
agent-react-devtools profile stop
agent-react-devtools profile slow --limit 5
agent-react-devtools profile rerenders --limit 5
```

Then inspect the worst offenders with `get component @cN` and `profile report @cN`.

### Browse a long timeline in chunks

```bash
agent-react-devtools profile timeline --limit 20               # commits 0–19
agent-react-devtools profile timeline --limit 20 --offset 20   # commits 20–39
agent-react-devtools profile timeline --offset 30 --limit 10   # skip warm-up, show 30–39
```

Use `profile commit <N>` to drill into a specific commit once you spot a spike.

### Find a component and check its state

```bash
agent-react-devtools find SearchBar
agent-react-devtools get component @c12
```

### Verify a fix worked

```bash
agent-react-devtools profile start
# Repeat the interaction
agent-react-devtools profile stop
agent-react-devtools profile slow --limit 5
# Compare render counts and durations to the previous run
```

## Linux browser startup preflight

For Open Session, use the `verify-opensession` skill's isolated demo launcher.
Its bounded CDP browser runs headed Chrome under Xvfb with a short, private
`TMPDIR`; connect your interaction harness to that browser rather than starting
another one. Preserve the browser lease until profiling finishes, then clean up.

For a direct Playwright or agent-browser harness, give the entire harness a
short private temporary directory and close its browser before it exits:

```bash
(
  browser_tmp="$(mktemp -d /tmp/os-chrome-XXXXXX)"
  trap 'rm -rf -- "$browser_tmp"' EXIT
  TMPDIR="$browser_tmp" xvfb-run -a bun /path/to/profiling-harness.ts
)
```

Do not inherit a long session scratch path as Chrome's `TMPDIR`. Chrome adds
`/com.google.Chrome.XXXXXX/SingletonSocket`; Linux socket paths must be shorter
than 108 bytes. An oversized path aborts startup with `SIGTRAP`, even with a
short `--user-data-dir`. This affects both headed and full headless Chrome.
It is not evidence that a VPS cannot run Chrome, and changing browser versions,
disabling the GPU, or moving to a Mac is not the first fix.

Before investing in a candidate, verify browser/CDP startup, app mount, a real
interaction, and `agent-react-devtools wait --connected --timeout 15`. Confirm
that a short profiling recording contains commits. A failure should retain
browser stderr and identify the failed stage. Check the browser's temporary
path before declaring the run blocked by SIGTRAP; do not cycle through binaries
with the same broken environment. Do not claim a performance improvement
without valid before/after measurements.

## Using with agent-browser

When using `agent-browser` to drive the app while profiling or debugging, use
headed mode (`--headed`) for the reproducible profiling setup. A missing DevTools
connection is not, by itself, evidence that headless browsers cannot execute ES
modules; check app mount, instrumentation, and browser startup separately.

```bash
agent-browser --session devtools --headed open http://localhost:5173/
agent-react-devtools status  # Should show 1 connected app
```

## Important Rules

- **Labels reset** when the app reloads or components unmount/remount. After a reload, use `wait --connected` then re-check with `get tree` or `find`.
- **`status` first** — if status shows 0 connected apps, the React app is not connected. The user may need to run `npx agent-react-devtools init` in their project first.
- **Headed profiling baseline** — if using `agent-browser`, use `--headed` mode and the Linux startup preflight above. Verify the DevTools connection rather than inferring it from browser mode.
- **Profile while interacting** — profiling only captures renders that happen between `profile start` and `profile stop`. Make sure the relevant interaction happens during that window.
- **Use `--depth`** on large trees — a deep tree can produce a lot of output. Start with `--depth 3` or `--depth 4` and go deeper only on the subtree you care about.

## References

| File                                                | When to read                                                   |
| --------------------------------------------------- | -------------------------------------------------------------- |
| [commands.md](references/commands.md)               | Full command reference with all flags and edge cases           |
| [profiling-guide.md](references/profiling-guide.md) | Step-by-step profiling workflows and interpreting results      |
| [setup.md](references/setup.md)                     | How to connect different frameworks (Vite, Next.js, Expo, CRA) |
