import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type AttachedAgentRepository,
  listAttachedAgentRepositories,
} from "./attached-repositories";
import { getAuthToken, isMemfsRemoteConfigured } from "./memory-auth";
import {
  getMemoryAheadBehind,
  getMemoryConflictSummary,
  getRepositoryMountDir,
  getRepositoryRemoteUrl,
  isNonFastForwardPushError,
  type MemoryPostTurnSyncStatus,
  prepareAttachedRepositoryForGitOps,
  runGit,
  runGitWithRetry,
} from "./memory-git";

export interface RepositoryPostTurnSyncResult {
  name: string;
  path: string;
  permissions: string;
  status: Exclude<MemoryPostTurnSyncStatus, "invalid">;
  summary: string;
}

export interface RepositoriesPostTurnSyncResult {
  results: RepositoryPostTurnSyncResult[];
}

export interface SyncPendingAttachedRepositoriesAfterTurnDependencies {
  /** Kept for callers that still pass a backend; the sync no longer reads it. */
  backend?: unknown;
  listRepositories?: typeof listAttachedAgentRepositories;
}

export interface SyncPendingAttachedRepositoryParams {
  agentId: string;
  repository: AttachedAgentRepository;
  token: string;
  remoteSupported: boolean;
  localOnly: boolean;
  mountDir?: string;
  remoteUrl?: string;
}

const repositorySyncs = new Map<
  string,
  Promise<RepositoryPostTurnSyncResult>
>();

async function getPendingCommitCount(path: string): Promise<number> {
  const divergence = await getMemoryAheadBehind(path);
  if (divergence) {
    return divergence.ahead;
  }

  try {
    await runGit(path, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    return 0;
  }

  try {
    const { stdout } = await runGit(path, [
      "rev-list",
      "--count",
      "refs/remotes/origin/main..HEAD",
    ]);
    return Number.parseInt(stdout.trim(), 10) || 0;
  } catch {
    const { stdout } = await runGit(path, ["rev-list", "--count", "HEAD"]);
    return Number.parseInt(stdout.trim(), 10) || 0;
  }
}

async function syncPendingAttachedRepositoryCommitsUnlocked(
  params: SyncPendingAttachedRepositoryParams,
): Promise<RepositoryPostTurnSyncResult> {
  const path =
    params.mountDir ??
    getRepositoryMountDir(params.agentId, params.repository.name);
  const resultBase = {
    name: params.repository.name,
    path,
    permissions: params.repository.permissions ?? "unknown",
  };

  if (!existsSync(join(path, ".git"))) {
    return {
      ...resultBase,
      status: "skipped",
      summary: "Repository is not mounted.",
    };
  }

  const { stdout: statusOut } = await runGit(path, ["status", "--porcelain"]);
  const conflictSummary = await getMemoryConflictSummary(path, statusOut);
  if (conflictSummary) {
    return {
      ...resultBase,
      status: "conflict",
      summary: conflictSummary,
    };
  }

  if (statusOut.trim().length > 0) {
    const changedCount = statusOut
      .split("\n")
      .filter((line) => line.trim().length > 0).length;
    if (params.repository.permissions !== "read_write") {
      return {
        ...resultBase,
        status: "push_failed",
        summary: `Repository is read-only with ${changedCount} uncommitted change(s) that cannot be pushed.`,
      };
    }
    return {
      ...resultBase,
      status: "dirty",
      summary: `${changedCount} uncommitted shared-memory change(s).`,
    };
  }

  const pendingCommitCount = await getPendingCommitCount(path);
  if (pendingCommitCount <= 0) {
    return {
      ...resultBase,
      status: "clean",
      summary: "Repository is clean and has no pending commits to push.",
    };
  }

  if (params.repository.permissions !== "read_write") {
    return {
      ...resultBase,
      status: "push_failed",
      summary: `Repository is read-only with ${pendingCommitCount} local commit(s) that cannot be pushed.`,
    };
  }

  if (!params.remoteSupported) {
    return {
      ...resultBase,
      status: "push_failed",
      summary: params.localOnly
        ? "Local backend has no Letta remote to push."
        : "Active backend does not support remote repository pushes.",
    };
  }

  const remoteUrl =
    params.remoteUrl ??
    getRepositoryRemoteUrl(params.agentId, params.repository.name);
  await prepareAttachedRepositoryForGitOps({
    agentId: params.agentId,
    repositoryName: params.repository.name,
    directory: path,
    remoteUrl,
    token: params.token,
  });

  try {
    await runGitWithRetry(
      path,
      ["push", "-u", "origin", "HEAD:main"],
      params.token,
      {
        operation: `post-turn push shared memory ${params.repository.name}`,
      },
    );
    return {
      ...resultBase,
      status: "pushed",
      summary: `Pushed ${pendingCommitCount} pending shared-memory commit(s).`,
    };
  } catch (pushError) {
    if (!isNonFastForwardPushError(pushError)) {
      return {
        ...resultBase,
        status: "push_failed",
        summary:
          pushError instanceof Error ? pushError.message : String(pushError),
      };
    }
  }

  try {
    await runGitWithRetry(
      path,
      ["pull", "--rebase", "origin", "main"],
      params.token,
      {
        operation: `post-turn rebase shared memory ${params.repository.name}`,
      },
    );
    const postRebaseConflictSummary = await getMemoryConflictSummary(path);
    if (postRebaseConflictSummary) {
      return {
        ...resultBase,
        status: "conflict",
        summary: postRebaseConflictSummary,
      };
    }
    await runGitWithRetry(
      path,
      ["push", "-u", "origin", "HEAD:main"],
      params.token,
      {
        operation: `post-turn push rebased shared memory ${params.repository.name}`,
      },
    );
    return {
      ...resultBase,
      status: "pushed",
      summary: `Rebased and pushed ${pendingCommitCount} pending shared-memory commit(s).`,
    };
  } catch (rebaseOrPushError) {
    const postFailureConflictSummary = await getMemoryConflictSummary(path);
    if (postFailureConflictSummary) {
      return {
        ...resultBase,
        status: "conflict",
        summary: postFailureConflictSummary,
      };
    }
    return {
      ...resultBase,
      status: "push_failed",
      summary:
        rebaseOrPushError instanceof Error
          ? rebaseOrPushError.message
          : String(rebaseOrPushError),
    };
  }
}

export function syncPendingAttachedRepositoryCommits(
  params: SyncPendingAttachedRepositoryParams,
): Promise<RepositoryPostTurnSyncResult> {
  const path =
    params.mountDir ??
    getRepositoryMountDir(params.agentId, params.repository.name);
  const previous = repositorySyncs.get(path) ?? Promise.resolve(null);
  const current = previous
    .catch(() => null)
    .then(() => syncPendingAttachedRepositoryCommitsUnlocked(params));
  repositorySyncs.set(path, current);
  return current.finally(() => {
    if (repositorySyncs.get(path) === current) {
      repositorySyncs.delete(path);
    }
  });
}

export async function syncPendingAttachedRepositoryCommitsAfterTurn(
  agentId: string,
  dependencies: SyncPendingAttachedRepositoriesAfterTurnDependencies = {},
): Promise<RepositoriesPostTurnSyncResult> {
  // The gate used to read `capabilities.remoteMemfs`, which became a constant
  // once the local backend was the only backend, so this returned an empty
  // result for every run and attached shared-memory repositories were never
  // pushed. What actually decides is whether memory is served by a remote at
  // all: with no MemFS base URL configured the URL helper points at the local
  // default and every push would be reported as a failure, so a purely local
  // checkout stays empty.
  if (!isMemfsRemoteConfigured()) {
    return { results: [] };
  }

  const listRepositories =
    dependencies.listRepositories ?? listAttachedAgentRepositories;
  const repositories = await listRepositories(agentId);
  if (repositories.length === 0) {
    return { results: [] };
  }

  const token = await getAuthToken();
  const settledResults = await Promise.allSettled(
    repositories.map((repository) =>
      syncPendingAttachedRepositoryCommits({
        agentId,
        repository,
        token,
        // The repository's own remote decides now; a mount that cannot reach one
        // reports the failure itself instead of being skipped here.
        remoteSupported: true,
        localOnly: false,
      }),
    ),
  );

  return {
    results: settledResults.map((result, index) => {
      if (result.status === "fulfilled") return result.value;
      const repository = repositories[index];
      return {
        name: repository?.name ?? "unknown",
        path: repository ? getRepositoryMountDir(agentId, repository.name) : "",
        permissions: repository?.permissions ?? "unknown",
        status: "push_failed",
        summary:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      };
    }),
  };
}
