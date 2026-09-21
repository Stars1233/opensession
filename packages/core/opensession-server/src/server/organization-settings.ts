/** Organization artwork stored beside the instance's other durable state. */

import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { createHash } from "crypto";
import { stateDir } from "./paths";

export const MAX_ORGANIZATION_ICON_BYTES = 4 * 1024 * 1024;
const MAX_ICON_SIDE = 2048;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export class OrganizationIconError extends Error {}

export function organizationIconPath(): string {
  return `${stateDir("organization")}/icon.png`;
}

export async function organizationIconRevision(): Promise<string | null> {
  const bytes = await organizationIconBytes();
  return bytes
    ? createHash("sha256").update(bytes).digest("hex").slice(0, 12)
    : null;
}

export async function organizationIconBytes(): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(organizationIconPath()));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function pngDimension(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 +
    bytes[offset + 1] * 0x10000 +
    bytes[offset + 2] * 0x100 +
    bytes[offset + 3]
  );
}

/** Store the square PNG prepared by the web or native image picker. */
export async function saveOrganizationIcon(bytes: Uint8Array): Promise<void> {
  if (!bytes.length) throw new OrganizationIconError("The upload was empty");
  if (bytes.length > MAX_ORGANIZATION_ICON_BYTES) {
    throw new OrganizationIconError(
      "That image is too large. Icons cap at 4 MB.",
    );
  }
  if (
    bytes.length < 24 ||
    PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte) ||
    String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR"
  ) {
    throw new OrganizationIconError("An organization icon has to be a PNG");
  }
  const width = pngDimension(bytes, 16);
  const height = pngDimension(bytes, 20);
  if (!width || width !== height || width > MAX_ICON_SIDE) {
    throw new OrganizationIconError(
      `Use a square icon up to ${MAX_ICON_SIDE} × ${MAX_ICON_SIDE} pixels`,
    );
  }
  const path = organizationIconPath();
  await mkdir(stateDir("organization"), { recursive: true });
  await writeFile(path, bytes);
}

export async function removeOrganizationIcon(): Promise<void> {
  await rm(organizationIconPath(), { force: true });
}
