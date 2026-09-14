/**
 * Crash-safe JSON persistence: write to a temp file in the same directory,
 * then rename over the target. Rename is atomic on the same filesystem, so a
 * crash/OOM mid-write leaves either the old file or the new one — never a
 * truncated half-JSON that readers silently swallow as `{}`/null.
 *
 * Use this for every state file under ~/.opensession-* (queues, journals,
 * sessions, automations, goals…). Append-only JSONL logs (audit, ledgers)
 * don't need it — a torn line there loses one record, not the file.
 *
 * The async variants keep the same temp-in-directory, `wx` open, rename and
 * cleanup contract without blocking the gateway thread. Prefer them from any
 * request handler or actor continuation; the synchronous ones remain for
 * registries loaded and saved on the caller's own thread.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { mkdir, open, rename, rm } from "fs/promises";
import { dirname } from "path";
import { randomUUID } from "crypto";

function tempPathFor(path: string): string {
  return `${path}.tmp.${process.pid}.${randomUUID()}`;
}

export function writeFileAtomic(
  path: string,
  data: string,
  mode?: number,
): void {
  const tmp = tempPathFor(path);
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(tmp, "wx", mode);
  try {
    writeFileSync(fd, data);
    closeSync(fd);
    renameSync(tmp, path);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {}
    try {
      rmSync(tmp);
    } catch {}
    throw error;
  }
}

export function writeJsonAtomic(
  path: string,
  value: unknown,
  pretty = true,
  mode?: number,
): void {
  writeFileAtomic(
    path,
    JSON.stringify(value, null, pretty ? 2 : undefined),
    mode,
  );
}

/** Async counterpart of writeFileAtomic: same-directory temp file, exclusive
 * create with `mode`, rename over the target once the data is fully written.
 * The temp file never outlives a failure. Resolves once the rename landed, so
 * an awaiting caller knows the target carries the new content. */
export async function writeFileAtomicAsync(
  path: string,
  data: string,
  mode?: number,
): Promise<void> {
  const tmp = tempPathFor(path);
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(tmp, "wx", mode);
  let closed = false;
  try {
    await handle.writeFile(data);
    await handle.close();
    closed = true;
    await rename(tmp, path);
  } catch (error) {
    if (!closed) await handle.close().catch(() => {});
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

export function writeJsonAtomicAsync(
  path: string,
  value: unknown,
  pretty = true,
  mode?: number,
): Promise<void> {
  return writeFileAtomicAsync(
    path,
    JSON.stringify(value, null, pretty ? 2 : undefined),
    mode,
  );
}
