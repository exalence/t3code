import type * as EffectAcpSchema from "effect-acp/compat";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { KiroAgentEngine, KiroSettings } from "../settings.ts";

export const KIRO_DRIVER_KIND = ProviderDriverKind.make("kiro");

/**
 * T3's built-in Kiro slug. It is not a Kiro model id: selecting it keeps
 * whatever model the Kiro session starts on (the user's own Kiro default).
 */
export const KIRO_DEFAULT_MODEL_SLUG = "default";

type KiroAcpSettings = Pick<KiroSettings, "binaryPath" | "agentEngine">;

/**
 * `kiro-cli acp` argv for an engine. V3 rejects the V2 launch flags
 * (`--agent`, `--model`, `--trust-all-tools`); model, effort and mode are set
 * over ACP after `session/new`, and approvals go through
 * `session/request_permission`, which T3's runtime policy answers. V3 uses the
 * CLI login by default, so no `--auth-method` is passed.
 */
function kiroAcpSpawnArgs(agentEngine: KiroAgentEngine): ReadonlyArray<string> {
  return agentEngine === "v2" ? ["acp"] : ["acp", "--agent-engine=v3"];
}

function buildKiroAcpSpawnInput(
  settings: KiroAcpSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: settings?.binaryPath || "kiro-cli",
    args: [...kiroAcpSpawnArgs(settings?.agentEngine ?? "v3")],
    cwd,
    ...(environment === undefined ? {} : { env: environment }),
  };
}

interface KiroAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly kiroSettings: KiroAcpSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export const makeKiroAcpRuntime = Effect.fn("KiroAcpSupport.makeKiroAcpRuntime")(function* (
  input: KiroAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
> {
  const { kiroSettings, environment, ...options } = input;
  const context = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...options,
      spawn: buildKiroAcpSpawnInput(kiroSettings, input.cwd, environment),
    }),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
});

/** The T3 slug for a model selection; blank means the session's own model. */
export function resolveKiroModelId(model: string | null | undefined): string {
  return model?.trim() || KIRO_DEFAULT_MODEL_SLUG;
}

function selectValues(option: EffectAcpSchema.SessionConfigOption): ReadonlyArray<string> {
  return option.type === "select"
    ? option.options.flatMap((entry) =>
        "value" in entry ? [entry.value] : entry.options.map((choice) => choice.value),
      )
    : [];
}

/**
 * Applies a requested model to a started Kiro session and returns the model it
 * now runs on. V3 advertises models only as the `model` config option
 * (`session/set_config_option`); V2 advertises `models` and takes
 * `session/set_model`. A model the session does not offer is not sent: the
 * session keeps its current model rather than failing the turn.
 */
export const applyKiroModelSelection = Effect.fn("KiroAcpSupport.applyKiroModelSelection")(
  function* (input: {
    readonly runtime: Pick<
      AcpSessionRuntime.AcpSessionRuntime["Service"],
      "getConfigOptions" | "setModel" | "setSessionModel"
    >;
    readonly startResult: Pick<
      AcpSessionRuntime.AcpSessionRuntimeStartResult,
      "sessionSetupResult"
    >;
    readonly requestedModelId: string;
  }): Effect.fn.Return<string | undefined, EffectAcpErrors.AcpError> {
    const configOptions = yield* input.runtime.getConfigOptions;
    const modelOption = configOptions.find((option) => option.category === "model");
    const legacyModels = input.startResult.sessionSetupResult.models ?? undefined;
    const currentModelId =
      modelOption?.type === "select"
        ? modelOption.currentValue
        : legacyModels?.currentModelId.trim() || undefined;
    const requested = input.requestedModelId;
    if (requested === KIRO_DEFAULT_MODEL_SLUG || requested === currentModelId) {
      return currentModelId;
    }
    if (modelOption !== undefined) {
      if (!selectValues(modelOption).includes(requested)) {
        yield* Effect.logWarning("Kiro session does not offer the requested model", {
          requested,
        });
        return currentModelId;
      }
      yield* input.runtime.setModel(requested);
      return requested;
    }
    if (legacyModels?.availableModels.some((model) => model.modelId === requested) === true) {
      yield* input.runtime.setSessionModel(requested);
      return requested;
    }
    return currentModelId;
  },
);
