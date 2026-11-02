import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import type * as Path from "effect/Path";

/**
 * The folder new projects go in. A setting that is not absolute on this host, such as a relative
 * path or a synced foreign-platform one, is ignored: clients are told the default folder, so the
 * mistake shows instead of failing a creation later.
 */
export function resolveNewProjectsRoot(
  setting: string,
  defaultRoot: string,
  path: Path.Path,
  home: string,
): string {
  if (setting === "") return defaultRoot;
  const expanded = expandHomePath(setting, home);
  return path.isAbsolute(expanded) ? path.resolve(expanded) : defaultRoot;
}
