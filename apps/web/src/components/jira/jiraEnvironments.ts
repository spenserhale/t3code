import type { EnvironmentId } from "@t3tools/contracts";

/**
 * The environment whose Jira site a thread's issue key belongs to: the thread's own environment
 * when Jira is set up there, else the only environment that has it. With several to choose from
 * and none of them the thread's own, the key could be on any of those sites, so it is on none.
 */
export function jiraEnvironmentForThread(
  threadEnvironmentId: EnvironmentId,
  configured: ReadonlyArray<EnvironmentId>,
): EnvironmentId | null {
  if (configured.includes(threadEnvironmentId)) return threadEnvironmentId;
  return configured.length === 1 ? (configured[0] ?? null) : null;
}

/**
 * Whether a thread on this environment reads its issue keys on the given Jira site: the one rule
 * for where a thread or a project may be linked to an issue of that site.
 */
export function threadUsesJiraSite(
  threadEnvironmentId: EnvironmentId,
  configured: ReadonlyArray<EnvironmentId>,
  jiraEnvironmentId: EnvironmentId,
): boolean {
  return jiraEnvironmentForThread(threadEnvironmentId, configured) === jiraEnvironmentId;
}
