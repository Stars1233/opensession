const { describe, expect, test } = require("bun:test");
const { EventEmitter } = require("node:events");
const {
  validateIntent,
  publicAddress,
  readField,
  sendRequest,
  executeIntent,
} = require("./onepassword");

const intent = {
  account: "my.1password.com",
  reference: "op://Work/Example/token",
  purpose: "Check authentication",
  url: "https://api.example.com/me",
  method: "GET",
  injection: "bearer",
};

describe("1Password native secret boundary", () => {
  test("reads one field with fixed arguments and a non-inherited environment", async () => {
    const old = process.env.OP_SERVICE_ACCOUNT_TOKEN;
    process.env.OP_SERVICE_ACCOUNT_TOKEN = "must-not-inherit";
    try {
      const secret = await readField(intent, {
        findBinary: async () => "/opt/homebrew/bin/op",
        execute: (binary, args, options, callback) => {
          expect(binary).toBe("/opt/homebrew/bin/op");
          expect(args).toEqual([
            "read",
            "--no-newline",
            "--account",
            intent.account,
            intent.reference,
          ]);
          expect(options.env.OP_BIOMETRIC_UNLOCK_ENABLED).toBe("true");
          expect(Object.keys(options.env).sort()).toEqual([
            "HOME",
            "LANG",
            "OP_BIOMETRIC_UNLOCK_ENABLED",
            "PATH",
          ]);
          expect(options.shell).toBeUndefined();
          expect(options.maxBuffer).toBe(16 * 1024);
          expect(options.timeout).toBe(120_000);
          callback(null, "FAKE_SECRET");
        },
      });
      expect(secret).toBe("FAKE_SECRET");
    } finally {
      if (old === undefined) delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
      else process.env.OP_SERVICE_ACCOUNT_TOKEN = old;
    }
  });

  test("CLI errors, multiline fields and network errors never reach the caller", async () => {
    await expect(
      readField(intent, {
        findBinary: async () => "/test/op",
        execute: (_binary, _args, _options, callback) =>
          callback(new Error("FAKE_SECRET"), "FAKE_SECRET"),
      }),
    ).rejects.toThrow("1Password access failed or was cancelled.");
    await expect(
      readField(intent, {
        findBinary: async () => "/test/op",
        execute: (_binary, _args, _options, callback) =>
          callback(null, "injected\r\nHeader: value"),
      }),
    ).rejects.toThrow();
    expect(
      await executeIntent(intent, {
        read: async () => {
          throw new Error("FAKE_SECRET");
        },
      }),
    ).toEqual({ status: "failed" });
    expect(
      await executeIntent(intent, {
        read: async () => "FAKE_SECRET",
        send: async () => {
          throw new Error("FAKE_SECRET");
        },
      }),
    ).toEqual({ status: "failed" });
  });

  test("independently rejects whole-item reads, flags and unsafe targets", () => {
    for (const extra of [
      { reference: "op://Work/Example" },
      { reference: "op://Work/Example/*" },
      { reference: "op://Work/Example/token?x=y" },
      { account: "--account=evil" },
      { url: "http://api.example.com" },
      { url: "https://a:b@api.example.com" },
      { url: "https://127.0.0.1/" },
      { url: "https://[::1]/" },
      { url: "https://localhost/" },
      { url: "https://api.example.com:123/" },
      { body: "not allowed on GET" },
      { command: "echo" },
      { injection: "cookie" },
      { purpose: "safe\u202eevil" },
    ])
      expect(() => validateIntent({ ...intent, ...extra })).toThrow();
    const copy = validateIntent(intent);
    expect(copy).not.toBe(intent);
    expect(Object.isFrozen(copy)).toBe(true);
  });

  test("blocks local, tailnet, metadata, mapped, multicast and rebinding addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "100.64.0.1",
      "169.254.169.254",
      "192.168.0.1",
      "172.16.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "fc00::1",
      "fe80::1",
    ])
      expect(publicAddress(ip)).toBe(false);
    expect(publicAddress("8.8.8.8")).toBe(true);
    expect(publicAddress("2606:4700:4700::1111")).toBe(true);
  });

  test("injects only at HTTPS execution, discards even redirects and secret-echoing responses", async () => {
    let discarded = false;
    const httpStatus = await sendRequest(intent, "FAKE_SECRET", {
      resolveHost: async () => [{ address: "8.8.8.8", family: 4 }],
      request: (url, options, callback) => {
        expect(url.href).toBe(intent.url);
        expect(options.headers).toEqual({
          Authorization: "Bearer FAKE_SECRET",
        });
        expect(options.agent).toBe(false);
        expect(options.signal).toBeInstanceOf(AbortSignal);
        const request = new EventEmitter();
        request.end = () => {
          options.lookup(url.hostname, { all: true }, (err, addresses) => {
            expect(err).toBeNull();
            expect(addresses).toEqual([{ address: "8.8.8.8", family: 4 }]);
            callback({
              statusCode: 302,
              get headers() {
                throw new Error("must not inspect response headers");
              },
              destroy: () => {
                discarded = true;
              },
            });
          });
        };
        return request;
      },
    });
    expect(httpStatus).toBe(302);
    expect(discarded).toBe(true);
    expect(
      await executeIntent(intent, {
        read: async () => "FAKE_SECRET",
        send: async (_intent, secret) => {
          expect(secret).toBe("FAKE_SECRET");
          return 204;
        },
      }),
    ).toEqual({ status: "completed", httpStatus: 204 });
  });

  test("DNS answers cannot redirect execution to the private network", async () => {
    await expect(
      sendRequest(intent, "FAKE_SECRET", {
        resolveHost: async () => [
          { address: "8.8.8.8", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ],
        request: (url, options) => {
          const request = new EventEmitter();
          request.end = () =>
            options.lookup(url.hostname, {}, (error) =>
              request.emit("error", error),
            );
          return request;
        },
      }),
    ).rejects.toThrow("Request failed");
  });
});
