import { useAtomValue } from "@effect/atom-react";
import { useId, useState } from "react";
import type { EnvironmentId, UsageProviderKind } from "@t3tools/contracts";
import {
  assignLimitGroup,
  groupLimitAccounts,
  labelLimitAccounts,
  limitAccountScheduleKey,
  limitGroupNames,
  limitSubscriptionId,
  MAX_LIMIT_GROUP_NAME_LENGTH,
  setLimitGroupsEnabled,
  setLimitSchedule,
  type LimitGroupState,
} from "@t3tools/shared/usageLimitGroups";
import { collectLimitAccounts, collectLimitPools } from "@t3tools/shared/usageLimits";

import { environmentPresentations } from "../../state/presentation";
import { providerClients } from "../settings/providerDriverMeta";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { DraftInput } from "../ui/draft-input";
import { Switch } from "../ui/switch";
import { useUsageLimitGroups } from "./usageLimitGroupPreferences";
import { LimitGroupName } from "./UsageLimitGroupSections";
import { LimitScheduleField } from "./UsageLimitScheduleField";
import { AccountAvatar } from "./UsageLimitsPooled";
import { PROVIDER_PRESENTATION } from "./usageProviders";

const GROUP_NAMES_ID = "usage-limit-group-names";

/**
 * Sets up the groups Limits is split into: the switch for the grouped view and
 * a group per account on show. Each change applies as it is made; a name is
 * taken when its field is left, so a half-typed one never becomes a group.
 */
function UsageLimitGroupsDialog({
  selectedEnvironmentIds,
  hiddenProviders,
  now,
  groups,
  onChange,
  onOpenChange,
}: {
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
  readonly now: number;
  readonly groups: LimitGroupState;
  readonly onChange: (change: (groups: LimitGroupState) => LimitGroupState) => void;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const selected =
    selectedEnvironmentIds === null
      ? presentations
      : new Map([...presentations].filter(([id]) => selectedEnvironmentIds.has(id)));
  // Listed by provider as Limits draws them, but within one by name rather
  // than by reset time, so rows hold still as quota refreshes. Accounts that
  // share a name are numbered, so each field has a name of its own without an
  // email in an attribute.
  const idPrefix = useId();
  const hiddenDrivers = new Set(
    [...hiddenProviders].map((provider) => PROVIDER_PRESENTATION[provider].driverKind),
  );
  const shown = collectLimitAccounts(selected).filter(
    (account) => !hiddenDrivers.has(account.driver),
  );
  const accounts = labelLimitAccounts(
    collectLimitPools(shown, now).map((pool) => pool.accounts),
    (account) =>
      account.displayName ?? providerClients.get(account.driver)?.label ?? String(account.driver),
  );
  // Schedules belong to these groups whether or not Limits is shown grouped.
  const groupList = groupLimitAccounts(shown, groups.assignments);
  const emailGroups = groupList.filter((group) => group.kind === "email");
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Account groups</DialogTitle>
          <DialogDescription>
            Each group gets its own section on Limits and pools only its own accounts. Accounts
            without a group are grouped by email. A schedule says when a group is used, so pace and
            reminders skip the days and hours it is not.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <datalist id={GROUP_NAMES_ID}>
            {limitGroupNames(groups.assignments).map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>Group accounts on Limits</span>
            <Switch
              checked={groups.enabled}
              onCheckedChange={(enabled) =>
                onChange((current) => setLimitGroupsEnabled(current, enabled))
              }
            />
          </label>
          {groupList.length > 0 ? (
            <section className="flex flex-col gap-2 border-t border-border/60 pt-4">
              <h3 className="text-sm font-medium text-foreground">When each group is used</h3>
              <ul className="flex flex-col gap-2">
                {groupList.map((group) => {
                  const label =
                    group.kind === "email"
                      ? `email group ${emailGroups.indexOf(group) + 1}`
                      : group.name;
                  return (
                    <li key={group.key} className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-foreground">
                        <LimitGroupName group={group} className="text-sm" />
                      </span>
                      <LimitScheduleField
                        label={label}
                        value={groups.schedules?.[group.key]}
                        onChange={(schedule) =>
                          onChange((current) => setLimitSchedule(current, group.key, schedule))
                        }
                      />
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
          {accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No subscription accounts on the selected environments.
            </p>
          ) : (
            <ul className="flex flex-col gap-3 border-t border-border/60 pt-4">
              {accounts.map(({ account, label }, index) => {
                const id = limitSubscriptionId(account);
                const labelId = `${idPrefix}-account-${index}`;
                const inputId = `${idPrefix}-group-${index}`;
                return (
                  <li key={id} className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <span className="flex size-5 shrink-0 items-center justify-center">
                      <AccountAvatar account={account} />
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span id={labelId} className="truncate text-sm font-medium text-foreground">
                        {label}
                      </span>
                      {account.email || account.plan ? (
                        <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                          <RedactedSensitiveText
                            value={account.email}
                            ariaLabel="Toggle account email visibility"
                            revealTooltip="Click to reveal email"
                            hideTooltip="Click to hide email"
                            className="truncate"
                          />
                          {account.plan ? <span className="shrink-0">{account.plan}</span> : null}
                        </span>
                      ) : null}
                    </div>
                    <div className="w-40 shrink-0">
                      <DraftInput
                        size="compact"
                        value={groups.assignments[id] ?? ""}
                        id={inputId}
                        aria-label="Group for"
                        aria-labelledby={`${inputId} ${labelId}`}
                        list={GROUP_NAMES_ID}
                        placeholder={account.email?.trim() ? "By email" : "No group"}
                        maxLength={MAX_LIMIT_GROUP_NAME_LENGTH}
                        autoComplete="off"
                        spellCheck={false}
                        onCommit={(next) =>
                          onChange((current) => assignLimitGroup(current, id, next))
                        }
                      />
                    </div>
                    <div className="flex basis-full flex-wrap items-center gap-x-3 gap-y-2 ps-8">
                      <span className="text-xs text-muted-foreground">Schedule</span>
                      <LimitScheduleField
                        label={label}
                        inherits
                        value={groups.schedules?.[limitAccountScheduleKey(id)]}
                        onChange={(schedule) =>
                          onChange((current) =>
                            setLimitSchedule(current, limitAccountScheduleKey(id), schedule),
                          )
                        }
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

export function UsageLimitGroupsButton({
  selectedEnvironmentIds,
  hiddenProviders,
  now,
}: {
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
  readonly now: number;
}) {
  const [groups, updateGroups] = useUsageLimitGroups();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="compact" variant="ghost" onClick={() => setOpen(true)}>
        Groups
      </Button>
      {open ? (
        <UsageLimitGroupsDialog
          selectedEnvironmentIds={selectedEnvironmentIds}
          hiddenProviders={hiddenProviders}
          now={now}
          groups={groups}
          onChange={updateGroups}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  );
}
