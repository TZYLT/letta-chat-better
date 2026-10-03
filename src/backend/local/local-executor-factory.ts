import {
  DeterministicPongExecutor,
  DeterministicReflectionExecutor,
  type HeadlessTurnExecutor,
} from "@/backend/dev/headless-turn-executor";
import type { LocalPiModelsRuntime } from "@/backend/dev/pi-models-runtime";
import {
  PiStreamAdapter,
  type PiStreamFunction,
} from "@/backend/dev/pi-stream-adapter";
import type {
  LlmEndInfo,
  LlmStartInfo,
} from "@/backend/dev/provider-turn-executor";
import { ProviderTurnExecutor } from "@/backend/dev/provider-turn-executor";

export type LocalBackendExecutionMode =
  | "pi"
  | "deterministic"
  | "deterministic-reflection";

export interface CreateLocalExecutorOptions {
  storageDir: string;
  executionMode?: LocalBackendExecutionMode;
  executor?: HeadlessTurnExecutor;
  stream?: PiStreamFunction;
}

export function createLocalExecutor(
  options: CreateLocalExecutorOptions,
  modelsRuntime: LocalPiModelsRuntime,
  onLlmStart?: (info: LlmStartInfo) => void | Promise<void>,
  onLlmEnd?: (info: LlmEndInfo) => void | Promise<void>,
): HeadlessTurnExecutor {
  if (options.executor) return options.executor;
  if (options.executionMode === "deterministic") {
    return new DeterministicPongExecutor();
  }
  if (options.executionMode === "deterministic-reflection") {
    return new DeterministicReflectionExecutor();
  }
  return new ProviderTurnExecutor(
    new PiStreamAdapter({
      stream: options.stream,
      localProviderAuthStorageDir: options.storageDir,
      modelsRuntime,
      onLlmStart,
      onLlmEnd,
    }),
  );
}
