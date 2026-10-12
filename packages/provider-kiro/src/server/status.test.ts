import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { KiroSettings } from "../settings.ts";
import { applyKiroModelSelection, makeKiroAcpRuntime } from "./acpSupport.ts";
import { checkKiroProviderStatus, parseKiroWhoamiOutput } from "./status.ts";
import { writeFakeKiroCli } from "./fakeKiroCli.testkit.ts";

const decodeSettings = Schema.decodeSync(KiroSettings);

const fakeKiro = (options: { readonly loggedIn?: boolean } = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kiro-" });
    const logPath = path.join(directory, "requests.jsonl");
    const binaryPath = writeFakeKiroCli({
      directory,
      logPath,
      platform: yield* HostProcess.Platform,
      ...options,
    });
    const readLog = fs.readFileString(logPath).pipe(
      Effect.map((text) =>
        text
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { argv?: string[]; method?: string; params?: any }),
      ),
    );
    return { directory, binaryPath, readLog };
  });

it.layer(NodeServices.layer)("Kiro provider", (it) => {
  it.effect("probes Kiro V3: version, login, and models from session config options", () =>
    Effect.gen(function* () {
      const kiro = yield* fakeKiro();
      const settings = decodeSettings({ enabled: true, binaryPath: kiro.binaryPath });

      const snapshot = yield* checkKiroProviderStatus(settings, process.env, kiro.directory);

      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("2.29.0");
      expect(snapshot.auth).toMatchObject({ status: "authenticated", email: "dev@example.com" });
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "default",
        "auto",
        "claude-sonnet-5.5",
        "claude-opus-5.5",
      ]);
      expect(snapshot.models.find((model) => model.isDefault)?.slug).toBe("default");
      const effort = snapshot.models[1]?.capabilities?.optionDescriptors?.find(
        (descriptor) => descriptor.id === "effortLevel",
      );
      expect(effort).toMatchObject({ type: "select", currentValue: "medium" });

      const acpLaunch = (yield* kiro.readLog).find((entry) => entry.argv?.[0] === "acp");
      expect(acpLaunch?.argv).toEqual(["acp", "--agent-engine=v3"]);
    }),
  );

  it.effect("launches the V2 engine without the V3 flag", () =>
    Effect.gen(function* () {
      const kiro = yield* fakeKiro();
      const settings = decodeSettings({
        enabled: true,
        binaryPath: kiro.binaryPath,
        agentEngine: "v2",
      });
      yield* checkKiroProviderStatus(settings, process.env, kiro.directory);
      const acpLaunch = (yield* kiro.readLog).find((entry) => entry.argv?.[0] === "acp");
      expect(acpLaunch?.argv).toEqual(["acp"]);
    }),
  );

  it.effect("reports a missing login without starting an ACP session", () =>
    Effect.gen(function* () {
      const kiro = yield* fakeKiro({ loggedIn: false });
      const settings = decodeSettings({ enabled: true, binaryPath: kiro.binaryPath });

      const snapshot = yield* checkKiroProviderStatus(settings, process.env, kiro.directory);

      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toContain("kiro-cli login");
      expect((yield* kiro.readLog).some((entry) => entry.argv?.[0] === "acp")).toBe(false);
    }),
  );

  it.effect("switches models through session/set_config_option and skips unknown ones", () =>
    Effect.gen(function* () {
      const kiro = yield* fakeKiro();
      const settings = decodeSettings({ enabled: true, binaryPath: kiro.binaryPath });
      const runtime = yield* makeKiroAcpRuntime({
        kiroSettings: settings,
        environment: process.env,
        cwd: kiro.directory,
        clientInfo: { name: "kiro-test", version: "0.0.0" },
      });
      const startResult = yield* runtime.start();
      const select = (requestedModelId: string) =>
        applyKiroModelSelection({ runtime, startResult, requestedModelId });

      expect(yield* select("default")).toBe("auto");
      expect(yield* select("claude-opus-5.5")).toBe("claude-opus-5.5");
      expect(yield* select("not-a-kiro-model")).toBe("claude-opus-5.5");

      const sets = (yield* kiro.readLog).filter(
        (entry) => entry.method === "session/set_config_option",
      );
      expect(sets.map((entry) => entry.params)).toEqual([
        { sessionId: "kiro-session-1", configId: "model", value: "claude-opus-5.5" },
      ]);
    }).pipe(Effect.scoped),
  );
});

it("parses whoami output", () => {
  expect(
    parseKiroWhoamiOutput({
      code: 0,
      stdout: '{"email":"a@b.dev","accountType":"Pro"}',
      stderr: "",
    }),
  ).toEqual({
    status: "authenticated",
    type: "cached_token",
    label: "Kiro (Pro)",
    email: "a@b.dev",
  });
  expect(parseKiroWhoamiOutput({ code: 0, stdout: "Logged in", stderr: "" })).toMatchObject({
    status: "authenticated",
    label: "Kiro account",
  });
  expect(
    parseKiroWhoamiOutput({ code: 1, stdout: "", stderr: "Not logged in. Run kiro-cli login" }),
  ).toEqual({ status: "unauthenticated" });
  expect(parseKiroWhoamiOutput({ code: 1, stdout: "", stderr: "network down" })).toEqual({
    status: "unknown",
  });
});
