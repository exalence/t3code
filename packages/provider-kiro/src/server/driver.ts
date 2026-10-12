import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import { KiroSettings } from "../settings.ts";
import { KIRO_DRIVER_KIND } from "./acpSupport.ts";
import { KiroAdapterV2Driver, type KiroAdapterV2DriverEnv } from "./adapter.ts";
import { buildInitialKiroProviderSnapshot, checkKiroProviderStatus } from "./status.ts";
import { makeKiroTextGeneration } from "./textGeneration.ts";

const decodeKiroSettings = Schema.decodeSync(KiroSettings);

// Kiro CLI updates itself (installer script or Homebrew cask), so T3 offers no update action.
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: KIRO_DRIVER_KIND,
  packageName: null,
});

export type KiroDriverEnv =
  | KiroAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers;

export const KiroDriver: ProviderDriver<KiroSettings, KiroDriverEnv> = {
  driverKind: KIRO_DRIVER_KIND,
  metadata: {
    displayName: "Kiro",
    supportsMultipleInstances: true,
  },
  configSchema: KiroSettings,
  defaultConfig: (): KiroSettings => decodeKiroSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const host = yield* ProviderHost.ProviderHost;
      const processEnv = yield* mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: KIRO_DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: KIRO_DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies KiroSettings;
      const toDriverError = (detail: string) => (cause: unknown) =>
        new ProviderDriverError({ driver: KIRO_DRIVER_KIND, instanceId, detail, cause });

      const orchestrationAdapter = yield* KiroAdapterV2Driver.create({
        instanceId,
        displayName,
        accentColor,
        environment,
        enabled,
        config,
      }).pipe(Effect.mapError(toDriverError("Failed to build Kiro orchestration adapter.")));
      const textGeneration = yield* makeKiroTextGeneration(effectiveConfig, processEnv);

      const checkProvider = checkKiroProviderStatus(
        effectiveConfig,
        processEnv,
        host.paths.cwd,
      ).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<KiroSettings>>({
        resolveMaintenance: () => Effect.succeed(MAINTENANCE),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialKiroProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
      }).pipe(Effect.mapError(toDriverError("Failed to build Kiro snapshot.")));

      return {
        instanceId,
        driverKind: KIRO_DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        orchestrationAdapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
