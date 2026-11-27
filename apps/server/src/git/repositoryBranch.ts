import { parseRemoteRefWithRemoteNames } from "./remoteRefs.ts";

/**
 * A ref as the repository its branch is on and the branch's name there. A remote's name belongs to
 * one machine, the repository to every machine. A ref with no remote is a branch of `fallbackKey`.
 */
export function repositoryBranchOf(
  ref: string,
  repositoriesByRemote: ReadonlyMap<string, string>,
  fallbackKey: string,
): { readonly repositoryKey: string; readonly branch: string } {
  if (ref.startsWith("refs/heads/")) {
    return { repositoryKey: fallbackKey, branch: ref.slice("refs/heads/".length) };
  }
  const remote = parseRemoteRefWithRemoteNames(
    ref.replace(/^refs\/remotes\//, ""),
    [...repositoriesByRemote.keys()].toSorted((left, right) => right.length - left.length),
  );
  const repositoryKey = remote === null ? undefined : repositoriesByRemote.get(remote.remoteName);
  return remote === null || repositoryKey === undefined
    ? { repositoryKey: fallbackKey, branch: ref }
    : { repositoryKey, branch: remote.branchName };
}
