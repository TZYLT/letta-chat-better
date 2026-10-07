import { __testSetBackend, type Backend } from "@/backend";

/**
 * Structural view of the mocked `@letta-ai/letta-client` instance that listener
 * tests install with `mock.module("@/backend/api/client")`. Only the members the
 * listener path actually reaches are declared.
 */
export interface ListenerTestClient {
  agents: {
    retrieve: (agentId: string, options?: unknown) => Promise<unknown>;
  };
  conversations: {
    retrieve: (conversationId: string, options?: unknown) => Promise<unknown>;
    messages: {
      stream: (
        conversationId: string,
        body?: unknown,
        options?: unknown,
      ) => Promise<unknown>;
    };
  };
  messages: {
    retrieve: (messageId: string, options?: unknown) => Promise<unknown>;
  };
  runs: {
    retrieve: (runId: string, options?: unknown) => Promise<unknown>;
  };
}

/**
 * The capabilities the deleted `APIBackend` reported. Listener tests were
 * written against that backend, so the replacement must present the same
 * capability surface rather than the local backend's.
 */
const API_BACKEND_CAPABILITIES: Backend["capabilities"] = {
  promptRecompile: true,
  localModelCatalog: false,
  localMemfs: false,
};

/**
 * Backend stand-in for listener tests that drive the listener against a mocked
 * SDK client instead of the local store.
 *
 * It forwards only the methods that path actually reaches — verified by
 * instrumenting `getBackend()` while the listener concurrency suite runs:
 * `retrieveAgent`, `retrieveConversation`, `retrieveMessage`, `retrieveRun`,
 * and `streamConversationMessages`. Methods the mocked client has no surface
 * for (`listModels`, `updateAgent`) are deliberately absent: the deleted
 * `APIBackend` forwarded them to `client.models.list` and `client.agents.update`
 * too, so they already failed inside a caught turn-scoped call.
 */
export function createListenerTestBackend(client: ListenerTestClient): Backend {
  const backend = {
    capabilities: API_BACKEND_CAPABILITIES,
    async retrieveAgent(agentId: string, options?: unknown) {
      return client.agents.retrieve(agentId, options);
    },
    async retrieveConversation(conversationId: string, options?: unknown) {
      return client.conversations.retrieve(conversationId, options);
    },
    async retrieveMessage(messageId: string, options?: unknown) {
      return client.messages.retrieve(messageId, options);
    },
    async retrieveRun(runId: string, options?: unknown) {
      return client.runs.retrieve(runId, options);
    },
    async streamConversationMessages(
      conversationId: string,
      body?: unknown,
      options?: unknown,
    ) {
      return client.conversations.messages.stream(
        conversationId,
        body,
        options,
      );
    },
  };
  return backend as unknown as Backend;
}

/**
 * Install {@link createListenerTestBackend} as the process-wide backend.
 *
 * `client` is deliberately **not** typed as {@link ListenerTestClient}. A Bun
 * `mock.module` stand-in is structurally *narrower* than the declared view: its
 * parameters are the concrete wire shapes the listener path actually uses, and
 * TypeScript's contravariant parameter check rejects narrowing `unknown` to
 * those shapes (TS2345 at the install site). Applying the view at this one
 * boundary keeps the test file itself free of casts.
 */
export function installListenerTestBackend(client: unknown): void {
  __testSetBackend(createListenerTestBackend(client as ListenerTestClient));
}
