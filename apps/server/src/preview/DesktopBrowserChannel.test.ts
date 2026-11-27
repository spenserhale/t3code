// @effect-diagnostics nodeBuiltinImport:off - the channel writes its commands to a raw file descriptor.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeStream from "@effect/platform-node/NodeStream";
import { expect, it } from "@effect/vitest";
import type { DesktopBrowserCommand } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as DesktopBrowserChannel from "./DesktopBrowserChannel.ts";

vi.mock("@effect/platform-node/NodeStream", () => ({ fromReadable: vi.fn() }));
vi.mock("node:net", () => ({
  Socket: class {
    destroy() {}
  },
}));

const choicePrompt = {
  providerLabel: "Personal",
  origin: "https://app.rocketmoney.com",
  candidates: [
    {
      id: "first",
      title: "Rocket Money",
      username: "first@example.com",
      websites: ["https://app.rocketmoney.com"],
    },
    {
      id: "second",
      title: "Rocket Money",
      username: "second@example.com",
      websites: ["https://app.rocketmoney.com"],
    },
  ],
};

const choiceFixture = Effect.gen(function* () {
  const input = yield* Queue.unbounded<Uint8Array>();
  const commands = yield* Queue.unbounded<DesktopBrowserCommand>();
  vi.mocked(NodeStream.fromReadable).mockReturnValue(Stream.fromQueue(input));
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      vi
        .spyOn(DesktopTelemetryReceiver, "writeAllToFileDescriptor")
        .mockImplementation((_fd, buffer) =>
          Queue.offer(commands, JSON.parse(buffer.toString())).pipe(Effect.asVoid),
        ),
    ),
    (spy) => Effect.sync(() => spy.mockRestore()),
  );
  const config = yield* ServerConfig.ServerConfig;
  const context = yield* Layer.build(
    DesktopBrowserChannel.layer.pipe(
      Layer.provide(
        ServerConfig.layer({ ...config, desktopBrowserFd: 41, desktopBrowserControlFd: 42 }),
      ),
    ),
  );
  return {
    channel: Context.get(context, DesktopBrowserChannel.DesktopBrowserChannel),
    commands,
    send: (event: object) =>
      Queue.offer(input, new TextEncoder().encode(`${JSON.stringify(event)}\n`)),
  };
});

const testConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "desktop-browser-channel-",
}).pipe(Layer.provide(NodeServices.layer));

it.effect("returns the explicit second native login choice and preserves approval requests", () =>
  Effect.gen(function* () {
    const { channel, commands, send } = yield* choiceFixture;
    expect(channel.chooseLogin).toBeTypeOf("function");
    const key = { threadId: "thread-1", tabId: "tab-1" };
    const result = yield* channel.chooseLogin!(key, 300_000, choicePrompt).pipe(Effect.forkScoped);
    const request = yield* Queue.take(commands);
    expect(request).toMatchObject({
      type: "loginApproval",
      ...key,
      ...choicePrompt,
      timeoutMs: 120_000,
    });
    if (request.type !== "loginApproval") throw new Error("Expected a login request");
    yield* send({
      type: "loginApproval",
      ...key,
      requestId: request.requestId,
      approved: "once",
      selected: "second",
    });
    expect(yield* Fiber.join(result)).toBe("second");
    expect(yield* Queue.take(commands)).toEqual({
      type: "loginApprovalCancel",
      requestId: request.requestId,
    });

    const approval = yield* channel
      .approveLogin(key, 60_000, { providerLabel: "Personal" })
      .pipe(Effect.forkScoped);
    const ask = yield* Queue.take(commands);
    if (ask.type !== "loginApproval") throw new Error("Expected an approval request");
    yield* send({ type: "loginApproval", ...key, requestId: ask.requestId, approved: "thread" });
    expect(yield* Fiber.join(approval)).toBe("thread");
  }).pipe(Effect.scoped, Effect.provide(testConfig)),
);

it.effect("refuses unknown choices and closes expired or interrupted login requests", () =>
  Effect.gen(function* () {
    const { channel, commands, send } = yield* choiceFixture;
    expect(channel.chooseLogin).toBeTypeOf("function");
    const key = { threadId: "thread-1" };
    const invalid = yield* channel.chooseLogin!(key, 60_000, choicePrompt).pipe(Effect.forkScoped);
    const first = yield* Queue.take(commands);
    if (first.type !== "loginApproval") throw new Error("Expected a login request");
    yield* send({
      type: "loginApproval",
      ...key,
      requestId: "unknown-request",
      approved: "once",
      selected: "second",
    });
    yield* send({
      type: "loginApproval",
      ...key,
      requestId: first.requestId,
      approved: "once",
      selected: "unknown-login",
    });
    expect(yield* Fiber.join(invalid)).toBeUndefined();
    expect(yield* Queue.take(commands)).toEqual({
      type: "loginApprovalCancel",
      requestId: first.requestId,
    });

    const expired = yield* channel.chooseLogin!(key, 10.75, choicePrompt).pipe(Effect.forkScoped);
    const second = yield* Queue.take(commands);
    if (second.type !== "loginApproval") throw new Error("Expected a login request");
    yield* TestClock.adjust(11);
    expect(yield* Fiber.join(expired)).toBeUndefined();
    expect(yield* Queue.take(commands)).toEqual({
      type: "loginApprovalCancel",
      requestId: second.requestId,
    });
    yield* send({
      type: "loginApproval",
      ...key,
      requestId: second.requestId,
      approved: "once",
      selected: "second",
    });

    const interrupted = yield* channel.chooseLogin!(key, 60_000, choicePrompt).pipe(
      Effect.forkScoped,
    );
    const third = yield* Queue.take(commands);
    if (third.type !== "loginApproval") throw new Error("Expected a login request");
    yield* Fiber.interrupt(interrupted);
    expect(yield* Queue.take(commands)).toEqual({
      type: "loginApprovalCancel",
      requestId: third.requestId,
    });
  }).pipe(Effect.scoped, Effect.provide(testConfig)),
);

it.effect("protects unknown desktop visibility until an explicit hidden report arrives", () =>
  Effect.gen(function* () {
    const input = yield* Queue.unbounded<Uint8Array>();
    vi.mocked(NodeStream.fromReadable).mockReturnValue(Stream.fromQueue(input));
    const config = yield* ServerConfig.ServerConfig;
    yield* Effect.gen(function* () {
      const channel = yield* DesktopBrowserChannel.DesktopBrowserChannel;
      const key = { threadId: "thread-1", tabId: "tab-1" };
      const send = (event: object) =>
        Queue.offer(input, new TextEncoder().encode(`${JSON.stringify(event)}\n`));

      expect(channel.isShown(key)).toBe(true);
      yield* send({ type: "attached", ...key });
      yield* channel.awaitAttached(key, "5 seconds");
      expect(channel.isShown(key)).toBe(true);

      yield* send({ type: "shown", ...key, shown: false });
      yield* send({ type: "attached", threadId: key.threadId, tabId: "sentinel-1" });
      yield* channel.awaitAttached({ threadId: key.threadId, tabId: "sentinel-1" }, "5 seconds");
      expect(channel.isShown(key)).toBe(false);

      const shown = yield* channel.awaitShown(key, "5 seconds").pipe(Effect.forkChild);
      yield* send({ type: "shown", ...key, shown: true });
      expect(yield* Fiber.join(shown)).toBe(true);
      expect(channel.isShown(key)).toBe(true);

      yield* send({ type: "shown", ...key, shown: false });
      yield* send({ type: "detached", ...key });
      yield* send({ type: "attached", threadId: key.threadId, tabId: "sentinel-3" });
      yield* channel.awaitAttached({ threadId: key.threadId, tabId: "sentinel-3" }, "5 seconds");
      expect(channel.isShown(key)).toBe(true);
    }).pipe(
      Effect.provide(
        DesktopBrowserChannel.layer.pipe(
          Layer.provide(
            ServerConfig.layer({ ...config, desktopBrowserFd: 41, desktopBrowserControlFd: 42 }),
          ),
        ),
      ),
    );
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "desktop-browser-channel-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);

it.live("closes a tab's relay connection when the desktop detaches the tab", () =>
  Effect.gen(function* () {
    const input = yield* Queue.unbounded<Uint8Array>();
    vi.mocked(NodeStream.fromReadable).mockReturnValue(Stream.fromQueue(input));
    const config = yield* ServerConfig.ServerConfig;
    yield* Effect.gen(function* () {
      const channel = yield* DesktopBrowserChannel.DesktopBrowserChannel;
      const key = { threadId: "thread-1", tabId: "tab-1" };
      const send = (event: object) =>
        Queue.offer(input, new TextEncoder().encode(`${JSON.stringify(event)}\n`));

      yield* send({ type: "attached", ...key });
      yield* channel.awaitAttached(key, "5 seconds");
      const url = yield* channel.endpoint(key);
      const socket = new WebSocket(url);
      yield* Effect.addFinalizer(() => Effect.sync(() => socket.close()));
      const closed = new Promise<void>((resolve) =>
        socket.addEventListener("close", () => resolve()),
      );
      yield* Effect.promise(
        () => new Promise<void>((resolve) => socket.addEventListener("open", () => resolve())),
      );

      // Playwright waits on this socket for CDP replies; it must learn the tab is gone.
      yield* send({ type: "detached", ...key });
      yield* Effect.promise(() => closed).pipe(Effect.timeout("2 seconds"));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        DesktopBrowserChannel.layer.pipe(
          Layer.provide(
            ServerConfig.layer({ ...config, desktopBrowserFd: 41, desktopBrowserControlFd: 42 }),
          ),
        ),
      ),
    );
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "desktop-browser-channel-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("tells the desktop which page a login is filled into by the browser's own id", () =>
  Effect.gen(function* () {
    vi.mocked(NodeStream.fromReadable).mockReturnValue(Stream.never);
    const config = yield* ServerConfig.ServerConfig;
    const commands = NodePath.join(config.baseDir, "desktop-commands");
    const controlFd = yield* Effect.acquireRelease(
      Effect.sync(() => NodeFS.openSync(commands, "w")),
      (fd) => Effect.sync(() => NodeFS.closeSync(fd)),
    );
    yield* Effect.gen(function* () {
      const channel = yield* DesktopBrowserChannel.DesktopBrowserChannel;
      // A fill names its page by the main document's id, then the origins of its frames.
      yield* channel.loginFilled(
        { threadId: "thread-1", tabId: "tab-1" },
        "document-1 https://good.test https://frame.test",
      );
    }).pipe(
      Effect.provide(
        DesktopBrowserChannel.layer.pipe(
          Layer.provide(
            ServerConfig.layer({
              ...config,
              desktopBrowserFd: 41,
              desktopBrowserControlFd: controlFd,
            }),
          ),
        ),
      ),
    );
    // The desktop compares it with the id its browser gives the page, and knows nothing more.
    expect(JSON.parse(NodeFS.readFileSync(commands, "utf8"))).toEqual({
      type: "loginFilled",
      threadId: "thread-1",
      tabId: "tab-1",
      document: "document-1",
    });
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "desktop-browser-channel-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);
