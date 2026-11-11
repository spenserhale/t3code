import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import type * as Path from "effect/Path";

/** A branded build's own default folder, used only under the standard T3 home. */
const BRANDED_NEW_PROJECTS_ROOT: string | null = "~/.se/projects";

/**
 * The folder new projects go in while the setting is empty. A dev worktree or an explicit
 * T3CODE_HOME is a sandbox, so only the standard home may point at a folder outside itself.
 */
export function defaultNewProjectsRoot(
  baseDir: string,
  path: Path.Path,
  home: string,
  brandedRoot: string | null = BRANDED_NEW_PROJECTS_ROOT,
): string {
  const root = path.resolve(baseDir, "projects");
  if (brandedRoot === null || path.resolve(baseDir) !== path.resolve(home, ".t3")) return root;
  return resolveNewProjectsRoot(brandedRoot, root, path, home);
}

/**
 * The folder new projects go in. A setting that is not absolute on this host, such as a
 * hand-edited relative path or a synced foreign-platform one, falls back to the default, which
 * is also the folder clients are told.
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
