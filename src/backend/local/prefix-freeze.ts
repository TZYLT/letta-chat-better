import type { LocalCompiledSystemPrompt } from "./system-prompt-compilation";

/**
 * Strict prefix freeze.
 *
 * Within a conversation the applied prefix snapshot — the compiled system
 * prompt, the tool declarations, and the model/sampling settings — is never
 * rewritten by a turn. A memfs commit or an `agent.system` edit only becomes
 * pending; it is applied at an application point: a new conversation,
 * compaction, or an explicit `/recompile`.
 *
 * A conversation that has no snapshot yet (first turn, or an old record
 * without one) compiles it once and applies it from then on.
 *
 * This module owns the freeze decision itself so the orchestration in
 * `local-backend.ts` stays readable and the rule is unit-testable on its own.
 */
export type FrozenPrefixResolution =
  | { kind: "frozen"; snapshot: LocalCompiledSystemPrompt }
  | { kind: "compile" };

/**
 * Decide whether the turn must reuse the conversation's applied snapshot or
 * compile one. Pending state (live memfs revision / raw system hash) is
 * deliberately NOT consulted here: it never changes the prefix on a turn.
 */
export function resolveFrozenPrefix(
  existing: LocalCompiledSystemPrompt | undefined,
): FrozenPrefixResolution {
  return existing
    ? { kind: "frozen", snapshot: existing }
    : { kind: "compile" };
}
