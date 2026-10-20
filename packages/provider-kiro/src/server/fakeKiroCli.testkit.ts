// @effect-diagnostics nodeBuiltinImport:off - synchronous fixture writer for tests.
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";

/**
 * A `kiro-cli` stand-in. `--version`, `whoami` and the logged-out `acp`
 * failure answer like Kiro CLI 2.32.0;
 * `acp` speaks Kiro V3's ACP surface: models and effort as session config
 * options, no `session/set_model`. Every argv and request is appended to
 * `logPath` as JSON lines so tests can assert on the wire.
 */
export function writeFakeKiroCli(input: {
  readonly directory: string;
  readonly logPath: string;
  readonly loggedIn?: boolean;
  readonly platform?: NodeJS.Platform;
}): string {
  return writeFakeCli({
    directory: input.directory,
    name: "kiro-cli",
    ...(input.platform === undefined ? {} : { platform: input.platform }),
    env: {
      FAKE_KIRO_LOG: input.logPath,
      FAKE_KIRO_LOGGED_IN: input.loggedIn === false ? "0" : "1",
    },
    source: String.raw`
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const args = process.argv.slice(2);
const log = (entry) => NodeFS.appendFileSync(process.env.FAKE_KIRO_LOG, JSON.stringify(entry) + "\n");
log({ argv: args });

if (args[0] === "--version") {
  process.stdout.write("kiro-cli 2.32.0\n");
  process.exit(0);
}
if (args[0] === "whoami") {
  if (process.env.FAKE_KIRO_LOGGED_IN !== "1") {
    // Kiro CLI 2.32.0 output when logged out.
    process.stdout.write('{"account":null}\n');
    process.exit(1);
  }
  process.stdout.write(
    JSON.stringify({ account: { accountType: "BuilderId", email: "dev@example.com" } }) + "\n",
  );
  process.exit(0);
}
if (args[0] !== "acp") process.exit(2);
if (process.env.FAKE_KIRO_LOGGED_IN !== "1") {
  // Kiro CLI 2.32.0: logged out, acp exits before answering initialize.
  process.stderr.write("error: You are not logged in, please log in with kiro-cli login\n");
  process.exit(1);
}

const sessionId = "kiro-session-1";
const config = { model: "auto", effortLevel: "medium" };
const configOptions = () => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: config.model,
    options: [
      { value: "auto", name: "Auto" },
      { value: "claude-sonnet-5.5", name: "Claude Sonnet 5.5" },
      { value: "claude-opus-5.5", name: "Claude Opus 5.5" },
    ],
  },
  {
    id: "effortLevel",
    name: "Effort",
    category: "thought_level",
    type: "select",
    currentValue: config.effortLevel,
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
    ],
  },
];
const write = (message) => process.stdout.write(JSON.stringify(message) + "\n");

for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  log({ method: request.method, params: request.params });
  if (request.id === undefined) continue;
  let result;
  switch (request.method) {
    case "initialize":
      result = {
        protocolVersion: 1,
        agentInfo: { name: "kiro-cli", version: "2.32.0" },
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
        authMethods: [],
      };
      break;
    case "session/new":
      result = { sessionId, configOptions: configOptions() };
      break;
    case "session/set_config_option": {
      const option = configOptions().find((candidate) => candidate.id === request.params.configId);
      if (!option || !option.options.some((choice) => choice.value === request.params.value)) {
        write({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "Invalid value" } });
        continue;
      }
      config[request.params.configId] = request.params.value;
      result = { configOptions: configOptions() };
      break;
    }
    case "session/prompt":
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: process.env.FAKE_KIRO_REPLY ?? "ok" },
          },
        },
      });
      result = { stopReason: "end_turn" };
      break;
    default:
      write({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
      continue;
  }
  write({ jsonrpc: "2.0", id: request.id, result });
}
`,
  });
}
