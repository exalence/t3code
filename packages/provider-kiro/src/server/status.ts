import type {
  CustomModelSetting,
  ModelCapabilities,
  ServerProviderAuth,
  ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { parseSessionModeState } from "@t3tools/provider-acp/server/runtimeModel";
import { acpProviderOptionDescriptors } from "@t3tools/provider-acp/server/sessionConfig";
import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import type { KiroSettings } from "../settings.ts";
import { KIRO_DEFAULT_MODEL_SLUG, makeKiroAcpRuntime } from "./acpSupport.ts";

const KIRO_PRESENTATION = {
  displayName: "Kiro",
  supportsConversationRollback: false,
  showInteractionModeToggle: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

const VERSION_PROBE_TIMEOUT_MS = 4_000;
// The model list only exists on a live session, so the probe runs `session/new`.
const KIRO_ACP_PROBE_TIMEOUT_MS = 20_000;

const kiroDefaultModel = (capabilities: ModelCapabilities): ServerProviderModel => ({
  slug: KIRO_DEFAULT_MODEL_SLUG,
  name: "Kiro default",
  isCustom: false,
  isDefault: true,
  capabilities,
});
const KIRO_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  kiroDefaultModel(EMPTY_CAPABILITIES),
];

function kiroModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting>,
  builtInModels: ReadonlyArray<ServerProviderModel> = KIRO_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels, EMPTY_CAPABILITIES);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(record: Record<string, unknown>, keys: ReadonlyArray<string>) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Reads `kiro-cli whoami --format json`. Kiro 2.32 prints `{"account":null}`
 * and exits 1 when logged out; a login nests its details under `account`.
 * The account fields are undocumented, so the label and email are best effort.
 */
export function parseKiroWhoamiOutput(output: {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}): ServerProviderAuth {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.stdout);
  } catch {
    parsed = undefined;
  }
  const account = isRecord(parsed) && "account" in parsed ? parsed.account : undefined;
  if (account === null) {
    return { status: "unauthenticated" };
  }
  if (output.code !== 0) {
    return /not logged in|kiro-cli login/i.test(`${output.stdout}\n${output.stderr}`)
      ? { status: "unauthenticated" }
      : { status: "unknown" };
  }
  const record = isRecord(account) ? account : isRecord(parsed) ? parsed : {};
  const email = firstString(record, ["email", "username", "userName", "user"]);
  const label = firstString(record, ["accountType", "authType", "type", "provider"]);
  return {
    status: "authenticated",
    type: "cached_token",
    label: label ? `Kiro (${label})` : "Kiro account",
    ...(email && email.includes("@") ? { email } : {}),
  };
}

/**
 * Models advertised by a Kiro session's `model` config option (V3) or its
 * `models` state (V2), after T3's "Kiro default" entry, which keeps the
 * session's own model. Every model carries the session's other knobs
 * (effort, mode) as options.
 */
function buildKiroModelsFromSessionSetup(
  sessionSetupResult: AcpSessionRuntime.AcpSessionRuntimeStartResult["sessionSetupResult"],
): ReadonlyArray<ServerProviderModel> {
  const configOptions = sessionSetupResult.configOptions ?? [];
  const optionDescriptors = acpProviderOptionDescriptors({
    configOptions,
    modeState: parseSessionModeState(sessionSetupResult),
  });
  const capabilities =
    optionDescriptors.length > 0
      ? createModelCapabilities({ optionDescriptors })
      : EMPTY_CAPABILITIES;
  const modelOption = configOptions.find(
    (option) => option.category === "model" && option.type === "select",
  );
  const advertised =
    modelOption?.type === "select"
      ? {
          models: modelOption.options
            .flatMap((entry) => ("value" in entry ? [entry] : entry.options))
            .map((entry) => ({ id: entry.value, name: entry.name })),
        }
      : {
          models: (sessionSetupResult.models?.availableModels ?? []).map((model) => ({
            id: model.modelId,
            name: model.name,
          })),
        };
  const seen = new Set<string>();
  const discovered = advertised.models.flatMap((model): ServerProviderModel[] => {
    const slug = model.id.trim();
    if (!slug || slug === KIRO_DEFAULT_MODEL_SLUG || seen.has(slug)) return [];
    seen.add(slug);
    return [
      {
        slug,
        name: model.name.trim() || slug,
        isCustom: false,
        capabilities,
      },
    ];
  });
  return [kiroDefaultModel(capabilities), ...discovered];
}

const runKiroCliCommand = Effect.fn("KiroProviderStatus.runKiroCliCommand")(function* (
  settings: KiroSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) {
  const command = settings.binaryPath || "kiro-cli";
  const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
    }),
  );
});

const discoverKiroModelsViaAcp = Effect.fn("KiroProviderStatus.discoverKiroModelsViaAcp")(
  function* (settings: KiroSettings, environment: NodeJS.ProcessEnv, cwd: string) {
    const runtime = yield* makeKiroAcpRuntime({
      kiroSettings: settings,
      environment,
      cwd,
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* runtime.start();
    return buildKiroModelsFromSessionSetup(started.sessionSetupResult);
  },
  Effect.scoped,
);

export const buildInitialKiroProviderSnapshot = Effect.fn(
  "KiroProviderStatus.buildInitialKiroProviderSnapshot",
)(function* (settings: KiroSettings): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return buildServerProvider({
    presentation: KIRO_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: kiroModelsFromSettings(settings.customModels),
    probe: {
      installed: settings.enabled,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: settings.enabled
        ? "Checking Kiro CLI availability..."
        : "Kiro is disabled in T3 Code settings.",
    },
  });
});

export const checkKiroProviderStatus = Effect.fn("checkKiroProviderStatus")(function* (
  settings: KiroSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = kiroModelsFromSettings(settings.customModels);
  const result = (
    probe: Parameters<typeof buildServerProvider>[0]["probe"],
    models: ReadonlyArray<ServerProviderModel> = fallbackModels,
  ) =>
    buildServerProvider({
      presentation: KIRO_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models,
      probe,
    });

  if (!settings.enabled) {
    return result({
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Kiro is disabled in T3 Code settings.",
    });
  }

  const versionResult = yield* runKiroCliCommand(settings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionResult)) {
    const missing = isCommandMissingCause(versionResult.failure);
    return result({
      installed: !missing,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: missing
        ? "Kiro CLI (`kiro-cli`) is not installed or not on PATH."
        : "Failed to execute Kiro CLI health check.",
    });
  }
  if (Option.isNone(versionResult.success)) {
    return result({
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "Kiro CLI is installed but timed out while running `kiro-cli --version`.",
    });
  }
  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return result({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "Kiro CLI is installed but failed to run.",
    });
  }

  const whoamiResult = yield* runKiroCliCommand(
    settings,
    ["whoami", "--format", "json"],
    environment,
  ).pipe(Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS), Effect.result);
  const auth: ServerProviderAuth =
    Result.isSuccess(whoamiResult) && Option.isSome(whoamiResult.success)
      ? parseKiroWhoamiOutput(whoamiResult.success.value)
      : { status: "unknown" };
  if (auth.status === "unauthenticated") {
    return result({
      installed: true,
      version,
      status: "error",
      auth,
      message: "Kiro CLI is installed but not logged in. Run `kiro-cli login`.",
    });
  }

  const acpExit = yield* discoverKiroModelsViaAcp(settings, environment, cwd).pipe(
    Effect.timeoutOption(KIRO_ACP_PROBE_TIMEOUT_MS),
    Effect.exit,
  );
  const discovered = Exit.isSuccess(acpExit) ? Option.getOrUndefined(acpExit.value) : undefined;
  if (discovered === undefined) {
    yield* Effect.logWarning("Kiro ACP probe failed or timed out.", {
      errorTag: Exit.isFailure(acpExit) ? causeErrorTag(acpExit.cause) : "Timeout",
    });
  }
  const models =
    discovered === undefined
      ? fallbackModels
      : kiroModelsFromSettings(settings.customModels, discovered);

  return result(
    {
      installed: true,
      version,
      // A failed model probe degrades the model picker; chats can still start.
      status: discovered === undefined ? "warning" : "ready",
      auth,
      ...(discovered === undefined
        ? {
            message: `Kiro CLI is installed but its ACP session (${settings.agentEngine}) failed to start. Model options may be incomplete.`,
          }
        : {}),
    },
    models,
  );
});
