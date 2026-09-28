/**
 * Web Push: phone/desktop notifications that work with the app closed.
 * Requires the app to be opened over a secure origin; plain HTTP origins have
 * no service workers.
 *
 * This is a delivery channel only. What to notify, and whether an event was
 * already delivered, is decided by src/server/notifications.ts; call
 * `notifyUser` there rather than pushing directly.
 *
 * VAPID keys are generated once and persisted; subscriptions are stored per
 * user (a person can have several devices). Dead subscriptions (404/410 from
 * the push service) are pruned on send. All file access is asynchronous and
 * serialized, so the gateway thread never blocks on it and two writers cannot
 * lose each other's update.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import webpush from "web-push";
import { writeJsonAtomicAsync } from "./shared/atomic-write";
import { legacyCatalogDirectory } from "./catalog-documents";
import { configuredIntegration } from "./config";

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

let vapid: Promise<VapidKeys> | null = null;

async function pushPath(file: string): Promise<string> {
  return join(await legacyCatalogDirectory("push"), file);
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(await pushPath(file), "utf-8"));
  } catch {
    return null;
  }
}

function ensureVapid(): Promise<VapidKeys> {
  vapid ??= (async () => {
    const stored = await readJson("vapid.json");
    let keys: VapidKeys;
    if (
      stored &&
      typeof stored === "object" &&
      "publicKey" in stored &&
      "privateKey" in stored &&
      typeof stored.publicKey === "string" &&
      typeof stored.privateKey === "string"
    ) {
      keys = { publicKey: stored.publicKey, privateKey: stored.privateKey };
    } else {
      keys = webpush.generateVAPIDKeys();
      await writeJsonAtomicAsync(await pushPath("vapid.json"), keys);
      console.log("[push] generated VAPID keypair");
    }
    const subject = configuredIntegration("push").vapidSubject;
    webpush.setVapidDetails(
      typeof subject === "string" && subject.trim()
        ? subject.trim()
        : "mailto:admin@example.com",
      keys.publicKey,
      keys.privateKey,
    );
    return keys;
  })().catch((error) => {
    vapid = null;
    throw error;
  });
  return vapid;
}

export async function getVapidPublicKey(): Promise<string> {
  return (await ensureVapid()).publicKey;
}

export interface PushSubscriptionRecord {
  user: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
  createdAt: string;
}

function isSubscription(value: unknown): value is PushSubscriptionRecord {
  return (
    value !== null &&
    typeof value === "object" &&
    "user" in value &&
    typeof value.user === "string" &&
    "endpoint" in value &&
    typeof value.endpoint === "string" &&
    "keys" in value &&
    value.keys !== null &&
    typeof value.keys === "object" &&
    "p256dh" in value.keys &&
    typeof value.keys.p256dh === "string" &&
    "auth" in value.keys &&
    typeof value.keys.auth === "string"
  );
}

async function readSubs(): Promise<PushSubscriptionRecord[]> {
  const stored = await readJson("subscriptions.json");
  if (
    stored &&
    typeof stored === "object" &&
    "subscriptions" in stored &&
    Array.isArray(stored.subscriptions)
  )
    return stored.subscriptions.filter(isSubscription);
  return [];
}

// Read-modify-write under one queue: a subscribe racing a prune must not
// write back a list that lost the other's change.
let writes: Promise<unknown> = Promise.resolve();
function updateSubs(
  mutate: (subs: PushSubscriptionRecord[]) => PushSubscriptionRecord[] | null,
): Promise<void> {
  const next = writes.then(async () => {
    const subs = mutate(await readSubs());
    if (subs)
      await writeJsonAtomicAsync(await pushPath("subscriptions.json"), {
        subscriptions: subs,
      });
  });
  writes = next.catch(() => {});
  return next;
}

export async function listPushSubscriptions(
  user?: string,
): Promise<PushSubscriptionRecord[]> {
  const all = await readSubs();
  if (!user) return all;
  const wanted = user.trim().toLowerCase();
  return all.filter((s) => s.user.trim().toLowerCase() === wanted);
}

export async function addPushSubscription(input: {
  user: string;
  subscription: {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };
  userAgent?: string;
}): Promise<{ ok: true } | { error: string }> {
  const { endpoint, keys } = input.subscription || {};
  if (!input.user?.trim()) return { error: "user required" };
  if (!endpoint || !keys?.p256dh || !keys?.auth)
    return { error: "subscription must carry endpoint + p256dh/auth keys" };
  const record: PushSubscriptionRecord = {
    user: input.user.trim(),
    endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    userAgent: input.userAgent?.slice(0, 200),
    createdAt: new Date().toISOString(),
  };
  await updateSubs((subs) => [
    ...subs.filter((s) => s.endpoint !== endpoint),
    record,
  ]);
  return { ok: true };
}

export async function removePushSubscription(
  endpoint: string,
): Promise<boolean> {
  let removed = false;
  await updateSubs((subs) => {
    const next = subs.filter((s) => s.endpoint !== endpoint);
    removed = next.length !== subs.length;
    return removed ? next : null;
  });
  return removed;
}

export interface PushPayload {
  title: string;
  body?: string;
  /** In-app path to open on tap, e.g. /session/<id>. */
  url?: string;
  tag?: string;
  /** Notification thread id, so a tap can mark the right row read. */
  id?: string;
}

/**
 * Send a push to every device `user` has registered (matched by display name,
 * case-insensitively). Prunes dead subscriptions. Use notifyUser instead of
 * calling this directly: it records the event and applies alert settings.
 */
export async function sendPushToUser(
  user: string,
  payload: PushPayload,
): Promise<void> {
  const subs = await listPushSubscriptions(user);
  if (subs.length === 0) return;
  await ensureVapid();
  const body = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: s.keys },
          body,
          { TTL: 60 * 60 },
        );
      } catch (e: unknown) {
        const code =
          e && typeof e === "object" && "statusCode" in e
            ? e.statusCode
            : undefined;
        if (code === 404 || code === 410) {
          await removePushSubscription(s.endpoint);
          console.log(`[push] pruned dead subscription for ${s.user}`);
        } else {
          console.error(
            `[push] send failed for ${s.user}:`,
            e instanceof Error ? e.message : e,
          );
        }
      }
    }),
  );
}
