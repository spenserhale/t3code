import {
  findThreadProvider,
  resolveLimitResetSnoozePreset,
} from "@t3tools/client-runtime/state/limit-reset-snooze";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { TimestampFormat } from "@t3tools/contracts/settings";

import { getClientSettings } from "../hooks/useSettings";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";
import { resolveSnoozePresets, snoozeWakeDescription, type SnoozePreset } from "./Sidebar.snooze";

type SnoozeTarget = Pick<EnvironmentThreadShell, "environmentId" | "session" | "modelSelection">;

/**
 * Snooze presets for the given threads, led by "until the usage limit resets"
 * when their provider reports subscription limits and the setting is on.
 * Reads provider state at call time, like the time presets.
 */
export function resolveThreadSnoozePresets(
  threads: ReadonlyArray<SnoozeTarget>,
  now: Date,
  timestampFormat: TimestampFormat,
): ReadonlyArray<SnoozePreset> {
  const presets = resolveSnoozePresets(now, timestampFormat);
  const limitPreset = resolveLimitResetPreset(threads, now, timestampFormat);
  return limitPreset === null ? presets : [limitPreset, ...presets];
}

function resolveLimitResetPreset(
  threads: ReadonlyArray<SnoozeTarget>,
  now: Date,
  timestampFormat: TimestampFormat,
): SnoozePreset | null {
  if (threads.length === 0 || !getClientSettings().limitResetSnoozeEnabled) return null;
  const serverConfigs = appAtomRegistry.get(environmentServerConfigsAtom);
  let preset: SnoozePreset | null = null;
  for (const thread of threads) {
    const provider = findThreadProvider(thread, serverConfigs.get(thread.environmentId)?.providers);
    const next = resolveLimitResetSnoozePreset(provider?.usageLimits, now);
    // A selection snoozes to one wake time, so threads whose limits reset at
    // different times get no shared choice.
    if (next === null || (preset !== null && next.snoozedUntil !== preset.snoozedUntil)) {
      return null;
    }
    preset = next;
  }
  return preset === null
    ? null
    : { ...preset, whenLabel: snoozeWakeDescription(preset.snoozedUntil, now, timestampFormat) };
}
