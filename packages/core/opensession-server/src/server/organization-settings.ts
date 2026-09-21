/** Organization artwork stored beside the instance's other durable state. */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { stateDir } from "./paths";

export const MAX_ORGANIZATION_ICON_BYTES = 4 * 1024 * 1024;
const MAX_ICON_SIDE = 2048;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export class OrganizationIconError extends Error {}

export function organizationIconPath(): string {
  return `${stateDir("organization")}/icon.png`;
}

export function organizationIconRevision(): string | null {
  const path = organizationIconPath();
  return existsSync(path)
    ? createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 12)
    : null;
}

export function organizationIconBytes(): Uint8Array | null {
  const path = organizationIconPath();
  return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
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
export function saveOrganizationIcon(bytes: Uint8Array): void {
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
  mkdirSync(stateDir("organization"), { recursive: true });
  writeFileSync(path, bytes);
}

export function removeOrganizationIcon(): void {
  rmSync(organizationIconPath(), { force: true });
}

/** The URL scheme the native apps register; a Web Clip aimed at it opens them. */
export const NATIVE_APP_URL_SCHEME = "os1";

function plistString(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * A stable UUID for one payload: reinstalling the profile replaces the tile
 * instead of adding a second one, because iOS keys profiles on identifier and
 * UUID rather than on content.
 */
function stableUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ]
    .join("-")
    .toUpperCase();
}

/**
 * An iOS configuration profile carrying one Web Clip: the organization icon
 * as a Home Screen tile that opens the native app.
 *
 * iOS lets an app change its own icon only between artwork compiled into the
 * bundle, so the organization's mark cannot become the app icon itself. A
 * Web Clip is the sanctioned way to put arbitrary artwork on the Home Screen,
 * and one aimed at the app's URL scheme launches the app rather than Safari.
 * The profile is unsigned: Settings shows it as such, but installs it.
 */
export function homeScreenProfile(input: {
  label: string;
  icon: Uint8Array;
  /** Distinguishes instances, so two organizations get two tiles. */
  instance: string;
}): string {
  const identifier = `opensession.home-screen-icon.${createHash("sha256")
    .update(input.instance)
    .digest("hex")
    .slice(0, 12)}`;
  const label = plistString(input.label.trim() || "Open Session");
  const icon = Buffer.from(input.icon).toString("base64");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>PayloadContent</key>
	<array>
		<dict>
			<key>FullScreen</key>
			<false/>
			<key>Icon</key>
			<data>${icon}</data>
			<key>IsRemovable</key>
			<true/>
			<key>Label</key>
			<string>${label}</string>
			<key>PayloadDescription</key>
			<string>Opens the ${label} app from the Home Screen.</string>
			<key>PayloadDisplayName</key>
			<string>${label}</string>
			<key>PayloadIdentifier</key>
			<string>${identifier}.webclip</string>
			<key>PayloadType</key>
			<string>com.apple.webClip.managed</string>
			<key>PayloadUUID</key>
			<string>${stableUuid(`${identifier}.webclip`)}</string>
			<key>PayloadVersion</key>
			<integer>1</integer>
			<key>Precomposed</key>
			<true/>
			<key>URL</key>
			<string>${NATIVE_APP_URL_SCHEME}://</string>
		</dict>
	</array>
	<key>PayloadDescription</key>
	<string>Puts the ${label} icon on the Home Screen. Tapping it opens the app.</string>
	<key>PayloadDisplayName</key>
	<string>${label} Home Screen icon</string>
	<key>PayloadIdentifier</key>
	<string>${identifier}</string>
	<key>PayloadRemovalDisallowed</key>
	<false/>
	<key>PayloadType</key>
	<string>Configuration</string>
	<key>PayloadUUID</key>
	<string>${stableUuid(identifier)}</string>
	<key>PayloadVersion</key>
	<integer>1</integer>
</dict>
</plist>
`;
}
