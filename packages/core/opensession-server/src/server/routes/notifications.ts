/**
 * The notification inbox (src/server/notifications.ts).
 *
 *   GET  /api/notifications          threads, unread count and alert settings
 *   POST /api/notifications/mark     { ids? | all, unread?, done? }
 *   PUT  /api/notifications/alerts   { alerts: { needsInput?, done?, … } }
 *
 * The person is always the verified identity when sign-in is on. Recording
 * happens where events occur, never through this API.
 */
import { requestUser, type RouteContext } from "./context";
import {
  getNotificationInbox,
  markNotifications,
  setAlertPrefs,
} from "../notifications";
import { conditionalJsonResponse } from "../http-json";

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is string => typeof item === "string")
    .slice(0, 500);
}

export async function handleNotificationsRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, url, path } = ctx;
  if (!path.startsWith("/api/notifications")) return undefined;

  if (path === "/api/notifications" && req.method === "GET") {
    const user = requestUser(ctx, url.searchParams.get("user"));
    return conditionalJsonResponse(req, await getNotificationInbox(user));
  }

  if (path === "/api/notifications/mark" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    const user = requestUser(ctx, body?.user);
    if (!user)
      return Response.json({ error: "user required" }, { status: 400 });
    const ids = stringList(body?.ids);
    const all = body?.all === true;
    if (!all && !ids?.length)
      return Response.json({ error: "ids or all required" }, { status: 400 });
    const changed = await markNotifications(user, {
      ...(all ? { all } : { ids }),
      ...(typeof body?.unread === "boolean" ? { unread: body.unread } : {}),
      ...(typeof body?.done === "boolean" ? { done: body.done } : {}),
    });
    return Response.json({ ok: true, changed });
  }

  if (path === "/api/notifications/alerts" && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    const user = requestUser(ctx, body?.user);
    if (!user)
      return Response.json({ error: "user required" }, { status: 400 });
    if (!body?.alerts || typeof body.alerts !== "object")
      return Response.json({ error: "alerts required" }, { status: 400 });
    return Response.json({ alerts: await setAlertPrefs(user, body.alerts) });
  }

  return undefined;
}
