export interface FlagConflictCheck {
  when: unknown;
  message: string;
}

export function validateFlagConflicts(options: {
  guard: unknown;
  checks: FlagConflictCheck[];
}): void {
  const { guard, checks } = options;
  if (!guard) {
    return;
  }
  const firstConflict = checks.find((check) => Boolean(check.when));
  if (firstConflict) {
    throw new Error(firstConflict.message);
  }
}

export function validateConversationDefaultRequiresAgent(options: {
  specifiedConversationId: string | null | undefined;
  specifiedAgentId: string | null | undefined;
  forceNew: boolean | null | undefined;
}): void {
  const { specifiedConversationId, specifiedAgentId, forceNew } = options;
  if (specifiedConversationId === "default" && !specifiedAgentId && !forceNew) {
    throw new Error("--conv default requires --agent <agent-id>");
  }
}

/**
 * Reject the headless flags that only mean something when the message is routed
 * to another destination.
 *
 * Both flags were Cloud-send options; here they are valid only with a routed
 * environment connection (`--computer`, or an inherited listener connection).
 * `--no-wait` used to be silently ignored for a local run once its guard was
 * deleted with the Cloud send path, which made a "non-waiting" send look
 * accepted while it actually waited.
 */
export function validateRoutedDestinationFlags(
  values: { "client-message-id"?: string; "no-wait"?: boolean },
  hasRoutedDestination: boolean,
): void {
  if (hasRoutedDestination) {
    return;
  }
  if (values["client-message-id"] !== undefined) {
    throw new Error("--client-message-id requires a routed destination");
  }
  if (values["no-wait"] === true) {
    throw new Error(
      "--no-wait requires a routed destination: pass --computer, or run inside a listener connection",
    );
  }
}

interface StatelessStartupOptions {
  stateless: boolean | null | undefined;
  isHeadless: boolean;
  memfs: boolean | null | undefined;
  memfsStartup: string | null | undefined;
  forceNewAgent: boolean | null | undefined;
  hasExistingAgentSelector: boolean;
}

function validateStatelessStartupOptions(
  options: StatelessStartupOptions,
): void {
  if (!options.stateless) {
    return;
  }
  if (!options.isHeadless) {
    throw new Error("--stateless is only supported in headless mode");
  }
  if (options.memfs) {
    throw new Error("--stateless cannot be used with --memfs");
  }
  if (options.memfsStartup) {
    throw new Error("--stateless cannot be used with --memfs-startup");
  }
  if (options.forceNewAgent) {
    throw new Error(
      "--stateless is for existing agents and cannot be used with --new-agent",
    );
  }
  if (!options.hasExistingAgentSelector) {
    throw new Error("--stateless requires --agent, --name, or --conversation");
  }
}

interface PrimaryStartupFlagOptions {
  specifiedConversationId: string | null | undefined;
  specifiedAgentId: string | null | undefined;
  specifiedAgentName: string | null | undefined;
  forceNewAgent: boolean | null | undefined;
  forceNewConversation: boolean | null | undefined;
  shouldResume?: boolean | null;
  stateless: boolean | null | undefined;
  ephemeral?: boolean | null;
  isHeadless: boolean;
  memfs: boolean | null | undefined;
  memfsStartup: string | null | undefined;
}

export function validatePrimaryStartupFlagConflicts(
  options: PrimaryStartupFlagOptions,
): void {
  validateFlagConflicts({
    guard: options.ephemeral,
    checks: [
      {
        when: !options.isHeadless,
        message: "--ephemeral is only supported in headless mode",
      },
      {
        when:
          options.specifiedAgentId ||
          options.specifiedAgentName ||
          options.specifiedConversationId,
        message:
          "--ephemeral cannot be used with --agent, --name, or --conversation",
      },
      {
        when: options.forceNewAgent || options.forceNewConversation,
        message: "--ephemeral cannot be used with --new-agent or --new",
      },
      {
        when: options.stateless || options.memfs || options.memfsStartup,
        message:
          "--ephemeral cannot be used with --stateless, --memfs, or --memfs-startup",
      },
      {
        when: options.shouldResume,
        message: "--ephemeral cannot be used with --resume",
      },
    ],
  });
  validateStatelessStartupOptions({
    stateless: options.stateless,
    isHeadless: options.isHeadless,
    memfs: options.memfs,
    memfsStartup: options.memfsStartup,
    forceNewAgent: options.forceNewAgent,
    hasExistingAgentSelector: Boolean(
      options.specifiedAgentId ||
        options.specifiedAgentName ||
        options.specifiedConversationId,
    ),
  });

  validateFlagConflicts({
    guard:
      options.specifiedConversationId &&
      options.specifiedConversationId !== "default",
    checks: [
      {
        when: options.specifiedAgentId,
        message: "--conversation cannot be used with --agent",
      },
      {
        when: options.specifiedAgentName,
        message: "--conversation cannot be used with --name",
      },
      {
        when: options.forceNewAgent,
        message: "--conversation cannot be used with --new-agent",
      },
      {
        when: options.shouldResume,
        message: "--conversation cannot be used with --resume",
      },
    ],
  });

  validateFlagConflicts({
    guard: options.forceNewConversation,
    checks: [
      {
        when: options.specifiedConversationId,
        message: "--new cannot be used with --conversation",
      },
      {
        when: options.shouldResume,
        message: "--new cannot be used with --resume",
      },
    ],
  });
}
