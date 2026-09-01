import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { startFastifyService } from "../src/fastify.ts";

function fakeApp(events: string[], listen: () => Promise<void>): FastifyInstance {
  const onClose: Array<() => void | Promise<void>> = [];
  const app = {
    get() { return app; },
    addHook(name: string, hook: () => void | Promise<void>) {
      assert.equal(name, "onClose");
      onClose.push(hook);
      return app;
    },
    listen,
    async close() {
      events.push("app.close");
      for (const hook of onClose) await hook();
    },
  };
  return app as unknown as FastifyInstance;
}

test("register failure closes the app and invokes already-owned resources", async () => {
  const events: string[] = [];
  const app = fakeApp(events, async () => { events.push("unexpected.listen"); });

  await assert.rejects(
    startFastifyService({
      name: "register-failure-test",
      port: 3000,
      register(server) {
        server.addHook("onClose", async () => { events.push("resources.closed"); });
        events.push("register.failed");
        throw new Error("registration failed");
      },
    }, { createApp: () => app }),
    /registration failed/,
  );

  assert.deepEqual(events, ["register.failed", "app.close", "resources.closed"]);
});

test("listener failure uses the same close path and forwards bodyLimit", async () => {
  const events: string[] = [];
  const app = fakeApp(events, async () => {
    events.push("listen.failed");
    throw new Error("address already in use");
  });

  await assert.rejects(
    startFastifyService({
      name: "listener-failure-test",
      port: 3001,
      bodyLimit: 2 * 1024 * 1024,
      register(server) {
        server.addHook("onClose", async () => { events.push("resources.closed"); });
      },
    }, {
      createApp(options) {
        assert.equal(options.bodyLimit, 2 * 1024 * 1024);
        return app;
      },
    }),
    /address already in use/,
  );

  assert.deepEqual(events, ["listen.failed", "app.close", "resources.closed"]);
});
