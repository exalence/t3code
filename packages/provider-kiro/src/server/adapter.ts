import { type OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
} from "@t3tools/provider-acp/server/adapter";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { KiroSettings } from "../settings.ts";
import {
  applyKiroModelSelection,
  KIRO_DRIVER_KIND,
  makeKiroAcpRuntime,
  resolveKiroModelId,
} from "./acpSupport.ts";

const DEFAULT_KIRO_SETTINGS = Schema.decodeSync(KiroSettings)({});
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

/** Kiro switches models on a live session through `session/set_config_option`. */
const KiroProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface KiroAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: KiroSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly selfInvocation: SelfInvocation;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly makeRuntime?: AcpAdapterV2Flavor["makeRuntime"];
}

function makeKiroAcpAdapterFlavor(options: KiroAdapterV2Options): AcpAdapterV2Flavor {
  return {
    driver: KIRO_DRIVER_KIND,
    runtimeHarness: "Kiro",
    capabilities: KiroProviderCapabilitiesV2,
    supportsImagePrompts: true,
    resolveModelId: (selection) => resolveKiroModelId(selection.model),
    applyModelSelection: ({ runtime, startResult, modelSelection }) =>
      applyKiroModelSelection({
        runtime,
        startResult,
        requestedModelId: resolveKiroModelId(modelSelection.model),
      }),
    makeRuntime:
      options.makeRuntime ??
      (({ runtimePolicy: _runtimePolicy, processEnvironment, ...input }) =>
        makeKiroAcpRuntime({
          ...input,
          kiroSettings: options.settings,
          environment:
            processEnvironment === undefined
              ? options.environment
              : { ...options.environment, ...processEnvironment },
        })),
    promptFailure: (cause) =>
      makeProviderFailure({
        cause,
        ...(isAcpRequestError(cause)
          ? { message: cause.errorMessage, code: String(cause.code), class: "provider_error" }
          : { class: "provider_error" }),
      }),
  };
}

const makeKiroAdapterV2 = (options: KiroAdapterV2Options) =>
  makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeKiroAcpAdapterFlavor(options),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
  });

export type KiroAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const KiroAdapterV2Driver: ProviderAdapterDriver<KiroSettings, KiroAdapterV2DriverEnv> = {
  driverKind: KIRO_DRIVER_KIND,
  configSchema: KiroSettings,
  defaultConfig: (): KiroSettings => DEFAULT_KIRO_SETTINGS,
  create: Effect.fn("KiroAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<KiroSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const selfInvocation = yield* resolveSelfInvocation();
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return yield* makeKiroAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        selfInvocation,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: KIRO_DRIVER_KIND,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: KIRO_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create Kiro ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
};
