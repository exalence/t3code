/**
 * Kiro instance settings. Shared by the server driver and the client
 * settings form, so it holds only browser-safe schema code.
 *
 * @module provider-kiro/settings
 */
import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Kiro CLI ships two agent harnesses in one `kiro-cli` binary: V3 (the current
 * engine, `--agent-engine=v3`) and the older V2 "Classic" engine.
 */
export const KiroAgentEngine = Schema.Literals(["v3", "v2"]);
export type KiroAgentEngine = typeof KiroAgentEngine.Type;

export const KiroSettings = makeProviderSettingsSchema(
  {
    // Off by default, like the other opt-in providers. Users enable it from Settings.
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("kiro-cli").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Kiro CLI binary.",
        providerSettingsForm: { placeholder: "kiro-cli", clearWhenEmpty: "omit" },
      }),
    ),
    agentEngine: KiroAgentEngine.pipe(
      Schema.withDecodingDefault(Effect.succeed("v3")),
      Schema.annotateKey({
        title: "Agent engine",
        description: "Kiro agent harness to run over ACP.",
        providerSettingsForm: {
          control: "select",
          options: [
            { value: "v3", label: "Kiro V3" },
            { value: "v2", label: "Kiro V2 (Classic)" },
          ],
        },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "agentEngine"],
  },
);
export type KiroSettings = typeof KiroSettings.Type;
