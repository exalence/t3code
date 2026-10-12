import { TextGenerationError } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import type { KiroSettings } from "../settings.ts";
import { applyKiroModelSelection, makeKiroAcpRuntime, resolveKiroModelId } from "./acpSupport.ts";

const KIRO_TIMEOUT_MS = 180_000;
const isTextGenerationError = Schema.is(TextGenerationError);

/** Commit messages, PR text, branch names and titles through a one-shot Kiro ACP session. */
export const makeKiroTextGeneration = Effect.fn("makeKiroTextGeneration")(function* (
  settings: KiroSettings,
  environment: NodeJS.ProcessEnv,
) {
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runKiroJson: TextGenerationOperations.Runner = (request) => {
    const { operation, cwd, prompt, modelSelection } = request;
    const failure = (detail: string, cause?: unknown) =>
      new TextGenerationError({ operation, detail, ...(cause === undefined ? {} : { cause }) });
    return Effect.gen(function* () {
      const output = yield* Ref.make("");
      const runtime = yield* makeKiroAcpRuntime({
        kiroSettings: settings,
        environment,
        cwd,
        clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
      }).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      yield* runtime.handleSessionUpdate(({ update }) => {
        if (update.sessionUpdate !== "agent_message_chunk") return Effect.void;
        const content = update.content;
        return content.type === "text"
          ? Ref.update(output, (current) => current + content.text)
          : Effect.void;
      });

      const promptResult = yield* Effect.gen(function* () {
        const startResult = yield* runtime.start();
        yield* applyKiroModelSelection({
          runtime,
          startResult,
          requestedModelId: resolveKiroModelId(modelSelection.model),
        });
        return yield* runtime.prompt({ prompt: [{ type: "text", text: prompt }] });
      }).pipe(
        Effect.timeoutOption(KIRO_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(failure("Kiro ACP request timed out.")),
            onSome: Effect.succeed,
          }),
        ),
      );

      const text = (yield* Ref.get(output)).trim();
      if (!text) {
        return yield* failure(
          promptResult.stopReason === "cancelled"
            ? "Kiro ACP request was cancelled."
            : "Kiro returned empty output.",
        );
      }
      return yield* TextGenerationOperations.decodeJsonReply(request, "Kiro", text);
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause) ? cause : failure("Kiro ACP text generation failed.", cause),
      ),
      Effect.scoped,
    );
  };

  return TextGenerationOperations.fromRunner(
    "KiroTextGeneration",
    TextGenerationOperations.withoutInvestigation("Kiro", runKiroJson),
  );
});
