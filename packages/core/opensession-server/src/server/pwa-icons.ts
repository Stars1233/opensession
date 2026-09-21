import { createHash } from "crypto";
import { organizationIconBytes } from "./organization-settings";

// Bound the cache to the current artwork and three install sizes. Cache the
// promise too, so simultaneous install requests share the image conversion.
let cachedRevision: string | null = null;
const rendered = new Map<number, Promise<Uint8Array | null>>();

/** Resize off-thread via sharp; invalid artwork keeps the bundled fallback. */
export async function organizationPwaIcon(
  size: number,
): Promise<Uint8Array | null> {
  if (![180, 192, 512].includes(size)) return null;
  const bytes = await organizationIconBytes();
  if (!bytes) {
    cachedRevision = null;
    rendered.clear();
    return null;
  }
  const revision = createHash("sha256").update(bytes).digest("hex");
  if (revision !== cachedRevision) {
    cachedRevision = revision;
    rendered.clear();
  }
  let result = rendered.get(size);
  if (!result) {
    result = (async () => {
      // Optional native dependency: installations without sharp still have
      // the shipped icons, rather than losing their install surface.
      const { default: sharp } = await import("sharp");
      return new Uint8Array(
        await sharp(bytes, { limitInputPixels: 2048 * 2048 })
          .resize(size, size, { fit: "contain" })
          // iOS Home Screen icons are opaque. Preserve the full logo canvas.
          .flatten({ background: "#ffffff" })
          .png()
          .toBuffer(),
      );
    })().catch(() => null);
    rendered.set(size, result);
  }
  return result;
}
