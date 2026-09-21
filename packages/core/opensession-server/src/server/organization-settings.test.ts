import { expect, test } from "bun:test";
import { homeScreenProfile } from "./organization-settings";

const icon = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

test("home screen profile wraps the icon in a Web Clip that opens the app", () => {
  const plist = homeScreenProfile({
    label: "Acme & Co <dev>",
    icon,
    instance: "https://os.example.test",
  });
  expect(plist).toContain("<string>com.apple.webClip.managed</string>");
  expect(plist).toContain("<string>os1://</string>");
  expect(plist).toContain("<string>Acme &amp; Co &lt;dev&gt;</string>");
  expect(plist).toContain(
    `<data>${Buffer.from(icon).toString("base64")}</data>`,
  );
  expect(plist).toContain("<key>Precomposed</key>\n\t\t\t<true/>");
  expect(plist).toContain("<key>IsRemovable</key>\n\t\t\t<true/>");
});

test("home screen profile identity is stable per instance", () => {
  const args = { label: "Acme", icon, instance: "https://os.example.test" };
  expect(homeScreenProfile(args)).toBe(homeScreenProfile(args));
  const other = homeScreenProfile({ ...args, instance: "https://other.test" });
  const ids = (plist: string) =>
    [
      ...plist.matchAll(
        /<key>Payload(?:Identifier|UUID)<\/key>\s*<string>([^<]+)/g,
      ),
    ].map((m) => m[1]);
  expect(ids(homeScreenProfile(args))).toHaveLength(4);
  expect(ids(homeScreenProfile(args))).not.toEqual(ids(other));
  const uuids = [
    ...homeScreenProfile(args).matchAll(
      /<key>PayloadUUID<\/key>\s*<string>([^<]+)/g,
    ),
  ].map((m) => m[1]);
  expect(uuids).toHaveLength(2);
  for (const uuid of uuids) {
    expect(uuid).toMatch(
      /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-8[0-9A-F]{3}-[0-9A-F]{12}$/,
    );
  }
});

test("home screen profile falls back to a label when the name is blank", () => {
  expect(homeScreenProfile({ label: "  ", icon, instance: "x" })).toContain(
    "<string>Open Session</string>",
  );
});
