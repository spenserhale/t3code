/**
 * The upstream release whose provider compatibility policy applies to SECode.
 *
 * SECode is built from upstream `main`, so its package version still names
 * the last stable release while its provider adapters have moved on. Policies
 * are picked by SECode version, and the stable one describes adapters this
 * build no longer has: under 0.0.45 it called OpenCode 2 broken, on a build
 * that ships the OpenCode 2 adapter.
 *
 * Name the nightly tagged on the commit `secode` was rebuilt from.
 */
export const SECODE_UPSTREAM_VERSION = "0.1.2-nightly.20261022.3541";
