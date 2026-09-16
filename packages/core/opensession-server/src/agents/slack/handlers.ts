/** Slack event admission and presentation. Agent execution belongs to native sessions. */
import { configuredServer, productName } from "../../server/config";
import {
  sendSlackMessage,
  addReaction,
  getUserInfo,
  fetchThreadContext,
  postSlackBlocks,
  updateSlackBlocks,
  getChannelKind,
  slackFileRefs,
  downloadSlackImages,
} from "./slack-api";
import type { SlackFileRef, ThreadContext } from "./slack-api";
import {
  matchReply as matchHumanAskReply,
  noteAskThreadReply,
} from "../../server/human-asks";
import { triggerPrAction } from "../github/trigger";
import { classifyMention } from "./mention-intent";
import { enqueueMessage, getOrCreateQueue, isRestartAbort } from "./queue";
import type { QueuedMessage } from "./queue";
import { isStopMessage, cancelSession } from "./cancel";
import { slackIdToFirstName } from "../../server/shared/user-mappings";
import { getRepo } from "../../server/worktree";
import {
  sessionForThread,
  sessionForSlackConversation,
} from "../../server/slack-links";
import { tryGetSessionControl } from "../../server/session-control";
import { pinForUser } from "../../server/pins";
import { getUiPrefs } from "../../server/ui-prefs";
import { publishSessionChange } from "../../server/session-cache";
import {
  getDefaultModel,
  providerFor,
  resolveModel,
  formatModelList,
} from "../../server/models";
import {
  isWorktreeChannel,
  getWorktreeDirForChannel,
  worktreeChannels,
} from "./worktree-channels";
import {
  activeSessions,
  getSessionKey,
  saveSession,
  loadSession,
} from "./state";
import type { SlackSession } from "./state";

const ALLOWED_USER_ID = process.env.ALLOWED_SLACK_USER_ID;

async function pinSlackSession(
  sessionId: string,
  slackUserId: string,
): Promise<void> {
  const user = slackIdToFirstName(slackUserId);
  // Opt-in, matching the web UI's "Pin new sessions" default.
  if (!user || getUiPrefs(user)["pin-new-sessions"] !== "on") return;
  await pinForUser(user, sessionId);
}

async function postOpenSessionCard(
  channel: string,
  threadTs: string,
  sessionId: string,
): Promise<void> {
  const result = await postSlackBlocks(
    channel,
    `Continuing in ${productName()}.`,
    [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Open Session*",
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: `:desktop_computer: Open in ${productName()}`,
              emoji: true,
            },
            url: `${UI_BASE}/session/${encodeURIComponent(sessionId)}`,
            action_id: `opensession:${sessionId}`,
          },
        ],
      },
    ],
    threadTs,
  );
  if (!result?.ok) throw new Error(result?.error || "chat.postMessage failed");
}

async function activateLinkedSession(
  sessionId: string,
  text: string,
  channel: string,
  threadTs: string,
  messageTs: string,
  slackUserId: string,
  files?: SlackFileRef[],
): Promise<{ status: string; message: string }> {
  const control = tryGetSessionControl();
  if (!control)
    return { status: "error", message: "Session control unavailable." };
  if (isStopMessage(text)) {
    const cancelled = await control.cancelSession(sessionId);
    await sendSlackMessage(
      channel,
      cancelled ? "Cancelled." : "Nothing to cancel.",
      threadTs,
    );
    return { status: "handled", message: "Stop handled." };
  }
  const origin = control.getSession(sessionId)?.slackOrigin;
  if (origin?.channel === channel && origin.messageTs === messageTs)
    return { status: "handled", message: "Opening message already accepted." };
  const attachments = files?.length
    ? await downloadSlackImages(files)
    : undefined;
  const res = await control.deliverToSession(
    sessionId,
    text + (attachments?.note ? `\n\n${attachments.note}` : ""),
    slackIdToFirstName(slackUserId) || slackUserId,
    {
      busy: "queue",
      images: attachments?.images,
      imageUrls: attachments?.images.map(
        (image) => `data:${image.mediaType};base64,${image.data}`,
      ),
      slackReplyTo: { channel, threadTs },
      deliveryId: `slack:${channel}:${messageTs}`,
    },
  );
  if (res.status === "handled") {
    await sendSlackMessage(channel, res.message, threadTs);
  } else if (res.status !== "error") {
    await pinSlackSession(sessionId, slackUserId);
    await postOpenSessionCard(channel, threadTs, sessionId).catch((e) =>
      console.warn(
        `[slack] Failed to post linked-session card for ${sessionId}:`,
        e,
      ),
    );
  }
  return res;
}

// Cache thread context per channel+threadTs (30s TTL)
const threadContextCache = new Map<
  string,
  { context: ThreadContext; expiresAt: number }
>();

// Cached thread context (TTL 30s) — avoids refetching the same thread multiple times
async function cachedFetchThreadContext(
  channel: string,
  threadTs: string,
): Promise<ThreadContext> {
  const cacheKey = `${channel}:${threadTs}`;
  const cached = threadContextCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.context;
  const context = await fetchThreadContext(channel, threadTs);
  threadContextCache.set(cacheKey, { context, expiresAt: Date.now() + 30000 });
  return context;
}

/**
 * Attachments for a queued message: the triggering message's own files first,
 * then any other files seen in the thread context (deduped by id) — so an
 * image posted earlier in the thread also reaches the prompt.
 */
function mergeFileRefs(
  own: SlackFileRef[],
  threadFiles: SlackFileRef[] | undefined,
): SlackFileRef[] | undefined {
  const seen = new Set(own.map((f) => f.id));
  const merged = [
    ...own,
    ...(threadFiles || []).filter((f) => f.id && !seen.has(f.id)),
  ];
  return merged.length ? merged : undefined;
}

// Save the session and refresh its list index row. The index learns rows
// from targeted publishes and full rebuilds only, never from this file write:
// without the publish a thread created after boot stayed invisible to the
// sidebar and to the worktree reaper's session snapshot, which reaped its
// fresh checkout hourly as "tip in origin/main" (2026-09-10).
async function saveAndPublishSession(session: SlackSession): Promise<void> {
  await saveSession(session);
  await publishSessionChange(
    `slack-${getSessionKey(session.channel, session.threadTs)}`,
  );
}

export async function handleModelCommand(
  sessionKey: string,
  text: string,
  channel: string,
  threadTs: string,
): Promise<boolean> {
  if (!/^\/model(\s|$)/i.test(text.trim())) return false;

  let session: SlackSession | undefined = activeSessions.get(sessionKey);
  if (!session) {
    session = (await loadSession(sessionKey)) ?? undefined;
    if (session) activeSessions.set(sessionKey, session);
  }

  const arg = text
    .trim()
    .replace(/^\/model\s*/i, "")
    .trim();

  if (!arg || arg === "show" || arg === "list") {
    const current = session?.model || getDefaultModel();
    await sendSlackMessage(
      channel,
      `Current model: \`${current}\`${session?.model ? "" : " (default)"}\n\nAvailable (set with \`/model <name>\`):\n\`\`\`\n${formatModelList(session?.model)}\n\`\`\``,
      threadTs,
    );
    return true;
  }

  const resolved = resolveModel(arg);
  if (!resolved) {
    await sendSlackMessage(
      channel,
      `Unknown model \`${arg}\`. Available:\n\`\`\`\n${formatModelList(session?.model)}\n\`\`\``,
      threadTs,
    );
    return true;
  }

  if (!session) {
    await sendSlackMessage(
      channel,
      `No session in this thread yet — send the task first, then \`/model ${resolved.id}\`. (New sessions start on \`${getDefaultModel()}\`.)`,
      threadTs,
    );
    return true;
  }

  // No busy gate: the switch applies from the next message either way (the
  // model is read at dispatch), and refusing blocked the moment people most
  // want it — right after a run died on a usage limit. See the same removal
  // in src/server/slash-commands.ts for the race this used to stand in for.

  const prevProvider = providerFor(session.model);
  session.model = resolved.id;
  session.lastActivity = new Date().toISOString();
  await saveAndPublishSession(session);

  let note = "";
  if (prevProvider !== resolved.provider) {
    note =
      " Switching model families starts a fresh engine session (with a transcript handoff when available); the worktree state carries over.";
  }
  await sendSlackMessage(
    channel,
    `Model set to \`${resolved.id}\`. Applies from the next message.${note}`,
    threadTs,
  );
  return true;
}

export async function processMessage(
  sessionKey: string,
  msg: QueuedMessage,
): Promise<void> {
  const { dispatchSlackSessionMessage } = await import("./session-dispatch");
  const queue = getOrCreateQueue(sessionKey);
  const controller = new AbortController();
  queue.abortController = controller;
  try {
    const sessionId = await dispatchSlackSessionMessage(
      sessionKey,
      msg,
      () => controller.signal.aborted && !isRestartAbort(controller.signal),
    );
    if (controller.signal.aborted) return;
    await pinSlackSession(sessionId, msg.userId);
    await postOpenSessionCard(msg.channel, msg.threadTs, sessionId).catch(
      (error) => console.warn("[slack] Could not post session link:", error),
    );
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    if (queue.abortController === controller) queue.abortController = null;
  }
}

// ---------------------------------------------------------------------------
// handleMessageEvent — DM messages
// ---------------------------------------------------------------------------

export async function handleMessageEvent(event: any): Promise<void> {
  const { channel, user, ts, thread_ts } = event;
  const files = slackFileRefs(event.files);
  // An image-only message (no text) is still a real request — the attachment
  // IS the message.
  const text =
    (event.text || "").trim() ||
    (files.length ? "(no message text — see the attached files)" : "");

  if (!text) return;

  // Human-in-the-loop: is this a teammate replying to a question the bot DM'd
  // them on behalf of a session? If so, route it back into that session and stop
  // — do NOT treat it as a new request to the bot. This is the one path that
  // deliberately accepts a message from someone other than the trusted user
  // (matchReply only matches the exact person asked, in that ask's DM). Runs
  // before the allow-list gate below for exactly that reason; it's tightly
  // scoped and every accepted reply is audited.
  const matchedAsk = matchHumanAskReply({
    channel,
    user,
    threadTs: thread_ts,
    text,
  });
  if (matchedAsk) {
    console.log(
      `[slack] Routed reply from ${user} into session ${matchedAsk.sessionId} (ask ${matchedAsk.id})`,
    );
    await addReaction(channel, ts, "white_check_mark").catch(() => {});
    await sendSlackMessage(
      channel,
      ":inbox_tray: Got it — passing that straight to the session. Thanks!",
      thread_ts || ts,
    ).catch(() => {});
    return;
  }

  // For DMs: thread_ts means a reply in an existing thread; no thread_ts means
  // a new top-level message (e.g. Slack's "New Chat"). Use ts as the thread
  // anchor so each top-level DM starts its own session/worktree.
  const threadTs = thread_ts || ts;
  const sessionKey = getSessionKey(channel, threadTs);

  console.log(
    `[slack] Message from ${user} in ${channel}: ${text.substring(0, 50)}...`,
  );

  // A DM reply under a message a opensession session posted (automation DMs like
  // the daily recap) drives that session, answered back in the same thread —
  // same rule as channel threads. Before the allow-list gate for the same
  // reason as the human-ask path above: the DM'd person must be able to follow
  // up on a message the bot sent them, and the scope is just as tight (only
  // threads whose anchor message a session posted, only in that person's DM).
  if (thread_ts) {
    const threadSessionId = sessionForThread(channel, thread_ts);
    if (threadSessionId) {
      if (
        await maybeRetriggerAutomation(
          threadSessionId,
          text,
          channel,
          ts,
          thread_ts,
        )
      )
        return;
      if (tryGetSessionControl()) {
        console.log(
          `[slack] DM thread reply in ${channel}/${thread_ts} → session ${threadSessionId}`,
        );
        void addReaction(channel, ts, "eyes").catch(() => {});
        const res = await activateLinkedSession(
          threadSessionId,
          text,
          channel,
          thread_ts,
          ts,
          user,
          files,
        );
        if (res.status !== "error")
          noteAskThreadReply({ channel, threadTs: thread_ts, user });
        // Stale link (session deleted) → fall through to the normal DM flow.
        if (res.status !== "error") return;
        console.warn(
          `[slack] Thread-linked session ${threadSessionId} rejected delivery (${res.message}) — falling back`,
        );
      }
    }
  }

  if (ALLOWED_USER_ID && user !== ALLOWED_USER_ID) {
    console.log(`[slack] Ignoring message from non-allowed user: ${user}`);
    return;
  }

  // Handle stop/cancel keywords
  if (isStopMessage(text)) {
    const didCancel = cancelSession(sessionKey);
    if (didCancel) {
      await addReaction(channel, ts, "octagonal_sign");
      await sendSlackMessage(
        channel,
        "Cancelled. Queue cleared.",
        threadTs || ts,
      );
    } else {
      await sendSlackMessage(channel, "Nothing to cancel.", threadTs || ts);
    }
    return;
  }

  // Handle /model — set or show this session's model
  if (await handleModelCommand(sessionKey, text, channel, threadTs || ts)) {
    return;
  }

  // Add eyes reaction to acknowledge
  await addReaction(channel, ts, "eyes");

  // Check for existing session
  let session: SlackSession | undefined = activeSessions.get(sessionKey);
  if (!session) {
    session = (await loadSession(sessionKey)) ?? undefined;
    if (session) {
      activeSessions.set(sessionKey, session);
    }
  }

  const userInfo = await getUserInfo(user);
  const userName = userInfo?.real_name || user;

  if (session) {
    // Continue existing session
    console.log(`[slack] Continuing session: ${sessionKey}`);
    session.lastActivity = new Date().toISOString();

    enqueueMessage(sessionKey, {
      prompt: text,
      cardTitle: text,
      channel,
      threadTs: threadTs || ts,
      messageTs: ts,
      userName,
      userId: user,
      isNewSession: false,
      files: files.length ? files : undefined,
    });
  } else {
    enqueueMessage(sessionKey, {
      prompt: text,
      cardTitle: text,
      channel,
      threadTs,
      messageTs: ts,
      userName,
      userId: user,
      isNewSession: true,
      files: files.length ? files : undefined,
    });
  }
}

// ---------------------------------------------------------------------------
// handleMentionEvent — @mention in channels
// ---------------------------------------------------------------------------

const UI_BASE =
  process.env.OPENSESSION_UI_BASE || configuredServer().publicBaseUrl;

/**
 * Slack card for a triggered PR action. While running: "Open in Open Session" + Stop.
 * Once done: Stop is dropped (it's useless) and a "finished" note is added.
 */
function prActionCardBlocks(
  message: string,
  bksId: string,
  running: boolean,
): any[] {
  const opensessionButton = {
    type: "button",
    text: {
      type: "plain_text",
      text: `:desktop_computer: Open in ${productName()}`,
      emoji: true,
    },
    url: `${UI_BASE}/session/${bksId}`,
    action_id: `opensession:${bksId}`,
  };
  const stopButton = {
    type: "button",
    text: { type: "plain_text", text: ":octagonal_sign: Stop", emoji: true },
    style: "danger",
    action_id: `pr-stop:${bksId}`,
    value: bksId,
  };
  // On completion we just drop the Stop button — the separate "✓ Finished" reply
  // (posted by the caller) is the completion signal, so no redundant footer here.
  return [
    { type: "section", text: { type: "mrkdwn", text: message } },
    {
      type: "actions",
      block_id: `pr-action-${bksId}`,
      elements: running ? [opensessionButton, stopButton] : [opensessionButton],
    },
  ];
}

/**
 * A thread reply of "retrigger" under an automation-posted message re-fires
 * that automation with its original trigger payload (a brand-new run/session)
 * instead of steering the old session. Returns true when the reply was
 * consumed here — including a failed retrigger, which is answered in-thread
 * rather than delivered to the session as a prompt.
 */
async function maybeRetriggerAutomation(
  threadSessionId: string,
  replyText: string,
  channel: string,
  ts: string,
  threadTs: string,
): Promise<boolean> {
  if (!/^retrigger\b/i.test(replyText.trim())) return false;
  // Dynamic import: handlers.ts is pulled in by the agent loop at startup and
  // automations.ts pulls in several slack tool modules — avoid a load cycle.
  const { retriggerAutomationSession } =
    await import("../../server/automations");
  const res = await retriggerAutomationSession(threadSessionId);
  if (res.ok) {
    console.log(
      `[slack] Retrigger in ${channel}/${threadTs} → automation "${res.name}"`,
    );
    await addReaction(channel, ts, "repeat");
    await sendSlackMessage(
      channel,
      `:repeat: Re-running *${res.name}* with the original trigger — it'll post fresh results when done.`,
      threadTs,
    );
  } else {
    console.warn(
      `[slack] Retrigger in ${channel}/${threadTs} failed: ${res.reason}`,
    );
    await sendSlackMessage(
      channel,
      `:warning: Couldn't retrigger this run: ${res.reason}`,
      threadTs,
    );
  }
  return true;
}

export async function handleMentionEvent(event: any): Promise<void> {
  const { channel, user, ts, thread_ts } = event;
  const text = event.text || "";
  const files = slackFileRefs(event.files);

  const cleanText =
    text.replace(/<@[A-Z0-9]+>/g, "").trim() ||
    (files.length ? "(no message text — see the attached files)" : "");

  if (!cleanText) return;

  console.log(
    `[slack] Mention from ${user} in ${channel}: ${cleanText?.substring(0, 50)}...`,
  );

  // Worktree channels bypass the ALLOWED_USER_ID check so the whole team can
  // drive the work from the channel.
  const inWorktreeChannel = isWorktreeChannel(channel);
  // A mention in a thread anchored by a message some opensession session posted
  // (automation summaries etc.) drives THAT session instead of starting a new
  // one. Same team-wide bypass as worktree channels: anyone in the thread can
  // follow up.
  const threadSessionId =
    (thread_ts ? sessionForThread(channel, thread_ts) : undefined) ||
    (inWorktreeChannel ? sessionForSlackConversation(channel) : undefined);

  if (
    !inWorktreeChannel &&
    !threadSessionId &&
    ALLOWED_USER_ID &&
    user !== ALLOWED_USER_ID
  ) {
    console.log(`[slack] Ignoring mention from non-allowed user: ${user}`);
    return;
  }

  // Thread posted by a session (e.g. an automation's Slack summary): deliver
  // the reply into that session and answer back in this thread. busy: "queue"
  // — if the automation run is still going, the follow-up waits for it rather
  // than steering (the in-thread answer mirror rides the queued message).
  if (threadSessionId) {
    if (
      await maybeRetriggerAutomation(
        threadSessionId,
        cleanText,
        channel,
        ts,
        thread_ts || ts,
      )
    )
      return;
    if (tryGetSessionControl()) {
      console.log(
        `[slack] Thread reply in ${channel}/${thread_ts} → session ${threadSessionId}`,
      );
      void addReaction(channel, ts, "eyes").catch(() => {});
      const res = await activateLinkedSession(
        threadSessionId,
        cleanText,
        channel,
        thread_ts || ts,
        ts,
        user,
        files,
      );
      // A stale link (session deleted since the index was built) falls through
      // to the normal mention flow instead of eating the message.
      if (res.status !== "error") return;
      console.warn(
        `[slack] Thread-linked session ${threadSessionId} rejected delivery (${res.message}) — falling back`,
      );
    }
  }

  // For worktree channels, use channel ID as session key (one session per worktree)
  // so all threads share the same Claude session context
  const threadTs = thread_ts || ts;
  const sessionKey = inWorktreeChannel
    ? channel
    : getSessionKey(channel, threadTs);

  // Handle stop/cancel keywords
  if (isStopMessage(cleanText)) {
    const didCancel = cancelSession(sessionKey);
    if (didCancel) {
      await addReaction(channel, ts, "octagonal_sign");
      await sendSlackMessage(channel, "Cancelled. Queue cleared.", threadTs);
    }
    return;
  }

  // Handle /model — set or show this session's model
  if (await handleModelCommand(sessionKey, cleanText, channel, threadTs)) {
    return;
  }

  await addReaction(channel, ts, "eyes");

  const userInfo = await getUserInfo(user);
  const userName = userInfo?.real_name || user;

  // Worktree channel: route to existing worktree session
  if (inWorktreeChannel) {
    const worktreeDir = getWorktreeDirForChannel(channel)!;
    const branch = worktreeChannels.get(channel)!;

    console.log(
      `[slack] Worktree channel mention from ${userName} for branch ${branch} (session: ${sessionKey})`,
    );

    // Check for existing session
    let session: SlackSession | undefined = activeSessions.get(sessionKey);
    if (!session) {
      session = (await loadSession(sessionKey)) ?? undefined;
      if (session) {
        activeSessions.set(sessionKey, session);
      }
    }

    // Fetch thread/channel context
    let context = "";
    let threadFiles: SlackFileRef[] = [];
    if (thread_ts) {
      const tc = await cachedFetchThreadContext(channel, thread_ts);
      context = tc.text;
      threadFiles = tc.files;
    }

    let prompt: string;
    if (session) {
      // Continue existing session
      prompt = context
        ? `${userName} said (in a thread):\n\nThread context:\n---\n${context}\n---\n\nTheir message: "${cleanText}"`
        : `${userName} said: "${cleanText}"`;
    } else {
      // New session for this worktree channel
      prompt = `${userName} tagged me in the #worktree-${branch} Slack channel.

I'm working in worktree branch \`${branch}\` at \`${worktreeDir}\`.
${context ? `\nThread context:\n---\n${context}\n---\n` : ""}
Their message: "${cleanText}"

Please help with this request. Start by exploring the codebase to understand what's relevant.`;
    }

    enqueueMessage(sessionKey, {
      prompt,
      cardTitle: cleanText,
      channel,
      threadTs,
      messageTs: ts,
      userName,
      userId: user,
      isNewSession: !session,
      worktreeDir,
      branch,
      files: mergeFileRefs(files, threadFiles),
    });
    return;
  }

  // Regular (non-worktree) channel mention. A quick Haiku classifier decides the
  // route: an explicit PR action runs directly; questions and coding tasks
  // both use native sessions. The question verdict only adds a no-edit
  // instruction, not a reduced capability set. Repo selection uses the shared
  // Auto router (message + channel name + thread context; no match → default).
  // Fail-open: a null verdict falls through to the default-repo code path.
  //
  // Only thread mentions get surrounding context: a thread is one coherent
  // conversation, while channel history is mostly other people's unrelated
  // requests and would leak into the session prompt. Fetched before the
  // classifier so the repo verdict sees it too (cached, so no extra call).
  let context = "";
  let threadFiles: SlackFileRef[] = [];
  if (thread_ts) {
    const tc = await cachedFetchThreadContext(channel, thread_ts);
    context = tc.text;
    threadFiles = tc.files;
  }
  const channelName = channel.startsWith("D")
    ? null
    : (await getChannelKind(channel).catch(() => null))?.name || null;
  const intent = await classifyMention(cleanText, { channelName, context });
  // The router's verdict; getRepo(null/undefined) = the default repo.
  const repo = getRepo(intent?.repo || undefined);
  const isDefaultRepo = repo.id === getRepo().id;
  if (!isDefaultRepo) console.log(`[slack] mention routed to repo ${repo.id}`);

  if (intent && intent.action !== "none" && intent.prNumber) {
    // Carry the message text as steer so any specific guidance reaches the run.
    const res = await triggerPrAction(
      intent.action,
      intent.prNumber,
      user,
      cleanText,
    );
    if (res.ok && res.bksId) {
      const msg = `On it — ${res.message}`;
      const bksId = res.bksId;
      const posted = await postSlackBlocks(
        channel,
        msg,
        prActionCardBlocks(msg, bksId, true),
        threadTs,
      );
      const cardTs = posted?.ts;
      // When the run finishes: drop the Stop button and report back in-thread.
      if (res.done) {
        const url = res.url;
        void res.done.finally(() => {
          if (cardTs) {
            void updateSlackBlocks(
              channel,
              cardTs,
              msg,
              prActionCardBlocks(msg, bksId, false),
            ).catch(() => {});
          }
          void sendSlackMessage(
            channel,
            `✓ Finished — results are on the PR${url ? `: ${url}` : ""}`,
            threadTs,
          ).catch(() => {});
        });
      }
    } else {
      await sendSlackMessage(channel, res.message, threadTs);
    }
    return;
  }

  const intro = context
    ? `${userName} asked in a Slack thread:\n\n---\n${context}\n---\n\n${cleanText}`
    : cleanText;
  enqueueMessage(sessionKey, {
    prompt:
      intent?.mode === "ask"
        ? `${intro}\n\nInvestigate and answer the question. Do not change repository code unless asked. Runtime verification is allowed when needed.`
        : intro,
    cardTitle: cleanText,
    channel,
    threadTs: thread_ts || ts,
    messageTs: ts,
    userName,
    userId: user,
    isNewSession: true,
    repoId: repo.id,
    files: mergeFileRefs(files, threadFiles),
  });
}
