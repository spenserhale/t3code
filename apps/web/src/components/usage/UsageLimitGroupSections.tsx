import { groupLimitAccounts, type LimitGroup } from "@t3tools/shared/usageLimitGroups";
import { collectLimitPools, type LimitAccount, type LimitPool } from "@t3tools/shared/usageLimits";

import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { useUsageLimitGroups } from "./usageLimitGroupPreferences";
import { AccountChip, PoolSection } from "./UsageLimitsPooled";

interface LimitGroupPools {
  readonly group: LimitGroup;
  readonly pools: readonly LimitPool[];
}

/**
 * The pools Limits draws. With groups on, each group pools only its own
 * accounts, so quota that is not interchangeable is never added up, and
 * `groupSections` holds them. `pools` is everything drawn; `ungroupedPools` is
 * what is drawn outside any group.
 */
export function useLimitPools(accounts: readonly LimitAccount[], now: number) {
  const [groups] = useUsageLimitGroups();
  const groupSections = groups.enabled
    ? groupLimitAccounts(accounts, groups.assignments).map((group) => ({
        group,
        pools: collectLimitPools(group.accounts, now),
      }))
    : null;
  const ungroupedPools = groupSections ? [] : collectLimitPools(accounts, now);
  const pools = groupSections ? groupSections.flatMap((section) => section.pools) : ungroupedPools;
  return { pools, ungroupedPools, groupSections };
}

/**
 * One group of accounts with its own provider pools, so quota that is not
 * interchangeable is never added up. A group named by its email keeps the
 * address behind the chip until asked, as the account popovers do.
 */
function LimitGroupSection({
  group,
  pools,
  now,
}: {
  readonly group: LimitGroup;
  readonly pools: readonly LimitPool[];
  readonly now: number;
}) {
  return (
    <section className="flex flex-col gap-5">
      <h2 className="flex min-w-0 items-center gap-2 border-b border-border/60 pb-2 text-base font-semibold text-foreground">
        {group.kind === "email" ? (
          <>
            <AccountChip email={group.name} />
            <RedactedSensitiveText
              value={group.name}
              ariaLabel="Toggle group email visibility"
              revealTooltip="Click to reveal email"
              hideTooltip="Click to hide email"
              className="truncate font-sans text-sm"
            />
          </>
        ) : (
          <span className="min-w-0 wrap-anywhere">{group.name}</span>
        )}
      </h2>
      {pools.map((pool) => (
        <PoolSection key={pool.driver} pool={pool} now={now} heading="h3" />
      ))}
    </section>
  );
}

export function LimitGroupSections({
  sections,
  now,
}: {
  readonly sections: readonly LimitGroupPools[];
  readonly now: number;
}) {
  return sections.map(({ group, pools }) => (
    <LimitGroupSection key={group.key} group={group} pools={pools} now={now} />
  ));
}
