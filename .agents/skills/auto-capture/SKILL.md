---
name: auto-capture
description: Record a short production demo of this session's shipped PR using Tella's remote auto capture. Use when the user says "run auto capture", "auto capture", "record the PR on prod", or invokes /auto-capture. Infer the demo from session context, verify it is live and publicly accessible without login, capture a source, and place it in a private video to return its link.
---

# Auto capture

Turn the work in this session into a short screen demo on production. The user
should not need to write a script or repeat the PR context. This is an explicit,
on-demand action, not something to run automatically after every merge.

## 1. Recover the context and check production

- Read the session's goal, implementation summary, linked PR, and verification
  notes. Inspect the PR description and changed files if necessary. In a
  multi-repo session, use the repo that owns the change, not whichever checkout
  happens to be primary. Qualify PR references outside the primary repo as
  `<repo>#<number>`.
- Infer the production origin, exact feature route, intended audience, and one
  user-visible benefit. Use known deployment configuration or session evidence;
  never invent the URL, fixture IDs, or navigation. If multiple PRs or targets
  remain plausible, ask one focused question.
- Verify the PR is merged **and its change is deployed to production**, using
  deployment/release evidence for the merged revision and, where accessible,
  the live feature. A merged PR or green CI alone is not deployment proof. For
  direct-to-main work, use the published commit instead of requiring a PR.
  A user's explicit confirmation that this change is live is usable evidence;
  record that basis rather than claiming you independently verified it.
- If it is not live or production cannot be identified, stop with the specific
  blocker. Do not merge, deploy, flip feature flags, or substitute a preview,
  localhost, Portal, or staging URL just to make a recording possible.
- **The target must load without signing in.** The current tool films public
  web pages; a page behind login films the login page. Check the feature route
  without authenticated cookies. MCP authorization grants access to Tella's
  recording tools, not a logged-in browser on the target site. Even approved
  test-account credentials do not make authenticated capture supported. Do not
  put passwords, cookies, tokens, or customer data in the skill, target URL,
  capture instructions, or scheduled prompts. For authenticated screens, stop
  and ask for an approved public demo surface with synthetic data; do not expose
  private data or weaken authentication to produce one. Clearly label such a
  demo as a demo surface, not a recording of the live private workspace.
- If the change has no meaningful visible demo (for example, an internal
  refactor), explain that rather than inventing a product benefit or filming
  an unrelated page.

## 2. Write an outcome-focused brief

Aim for **30–60 seconds** and one focused user journey. This is a pacing request,
not a guaranteed clip duration; generating the take typically takes **3–6
minutes**. Briefly tell the user what you will record, then proceed without
requiring script approval unless a blocking access or safety decision remains.

The remote author does **not** have this conversation. Supply self-contained
`instructions` distilled from the PR, not a raw diff, transcript, click script,
or selector list. Describe the outcome a viewer should see; the agent finds
the clicks itself. Include the starting and ending state, what to dwell on,
and what to skip:

```text
Make a concise 30–60 second screen demo of [feature] on production.
Audience: [who benefits]. Main point: [observable improvement].
Start at [exact public production URL] with [safe starting state].
Show the viewer how [one user journey] leads to [observable new result].
Dwell on [important visual detail] long enough to read it. End on [result].
Skip [unrelated navigation or settings]. Keep the cursor deliberate and text
readable. Do not claim behavior you cannot see.
Use only approved demo data. Do not send, publish, purchase, invite, delete,
or change access or account settings. Do not show secrets or private records.
If login, missing data, a feature flag, or an unexpected state blocks the demo,
stop and ask for guidance rather than guessing or working around access controls.
```

Default to read-only interactions; production mutations require explicit
permission for the exact demo action and resource. Include those limits in the
remote brief too. Do not promise voiceover, captions, or editing controls the
tool does not offer. One capture is one page or flow. Multiple takes require a
clear multi-flow request, not an unsolicited longer tour.

## 3. Create the capture source

Discover the **production Tella MCP** tools with `mcp_search` before calling
`mcp_call`. Use the returned names and live schemas exactly. Do not substitute
staging or internal support recording-recovery tools.

The current contract is:

- `create_auto_capture`: `targetUrl`, optional `instructions` and `model`.
  Returns `sourceId`. Leave the model at its default unless requested otherwise.
- `get_auto_capture`: `sourceId`. Returns status and progress; terminal results
  include a `handoff`, `question`, or `error` as appropriate.
- `cancel_auto_capture`: `sourceId`. Stops a running take; an already-ended take
  is returned unchanged.

The live schema is authoritative. If these tools are unavailable, report the
connection or permission blocker. Do not assume a particular feature flag is
missing or bypass MCP controls with direct HTTP calls.

Create **one** take with the production `targetUrl` and the outcome brief in
`instructions`. It records a 4K source; it does **not** create a video or append
any clip yet. Save the `sourceId`, target URL, brief, and PR/commit reference in
the conversation for continuation. Creation is not idempotent: a timeout or lost
response is not permission to create another take. Recover the existing source
if possible; otherwise report the uncertainty.

Use only organization-controlled storage and keep resulting videos private.
Never upload recordings or data to public hosts, enable public sharing, or
export elsewhere as part of this skill.

## 4. Follow the take without blocking the session

Use `opensession-schedule` to check `get_auto_capture` in this same session
**every 30–60 seconds**, starting 30–60 seconds after creation. Include the
source ID, brief, PR/commit reference, and instruction to check the existing
take, not create another. End the turn with an honest “recording in progress”
update. Do not sleep, busy-poll, or leave a shell loop running. If scheduling is
unavailable, report the source ID and that another status check is needed; do
not promise an automatic follow-up you did not arrange.

Handle the result explicitly:

- `queued`, `authoring`, `validating`, `recording`, `processing`: still running.
  Read `progress` and schedule the next check 30–60 seconds later. Queued can
  include waiting a few minutes for a machine; 3–6 minutes is an estimate, not
  a timeout or reason to start a duplicate.
- `delivered`: read `handoff` **before placing the source**. It explains what the
  clip shows and where it departed from the instructions. If it missed the core
  feature, filmed login, or contains unsafe material, report that and do not
  place it as a successful demo. Otherwise continue to video placement below.
  A delivered source is not yet a video link.
- `needs_guidance`: ask the user the returned `question`. Once answered, start
  a new take with the original brief plus their answer in `instructions`, then
  track its new source ID. Do not invent separate guidance fields or silently
  retry. If the question requires login, retain the public-page restriction.
- `failed`: report `error` and the source ID. Do not retry automatically.
- `cancelled`: report cancellation; there is nothing to place.
- Unknown or missing status: report the unexpected response, preserve the source
  ID, and do not place it or declare success.

If the user asks to stop, or the take was started with the wrong URL or brief,
call `cancel_auto_capture` with that source ID and cancel its scheduled status
checks. Inspect the returned status: an already-ended take was not cancelled.
Do not place a source after a stop request, even if it completed first.

## 5. Place the source and return the video

Discover `create_video`, `upload_clip`, and the video lookup tool when needed.
The delivered capture's `sourceId` is already usable: do **not** call
`create_source`, upload bytes, download, or re-upload the recording.

- By default call `create_video` with the delivered `sourceId`, a short feature
  title in `name`, and `linkScope: "private"`. Disable search indexing with
  `searchEngineIndexingEnabled: false`. These fields must still match the live
  schema. If private creation is unsupported, stop rather than use public defaults.
- Only when the user explicitly asked to append to an existing video, verify
  that video's access is restricted before calling `upload_clip` with its
  `videoId` and the delivered `sourceId`. Do not change an existing video's
  sharing policy without permission. Place multiple requested takes in order.
- Record the placement result and returned video/clip identifiers before ending
  the turn. Never repeat a successful placement on the next scheduled check.
  If placement times out, inspect the existing video/source linkage before
  retrying to avoid duplicate videos or clips. A placement failure is not a
  reason to record the source again.

Get the actual viewer/editor URL from the placement response or a video lookup;
do not fabricate a URL or make a private video public to obtain a link. Review
playback if available and distinguish that from reading the agent's handoff.
Finish concisely with the Tella video link, what it demonstrates, and the PR or
commit reference. Mention deviations or unreviewed playback. Do not post to
Slack, comment on the PR, or export/upload elsewhere unless separately requested.
