import { formatUsd } from "@t3tools/shared/usageFormat";
import type { LimitAccount } from "@t3tools/shared/usageLimits";

import { usePrimarySettings } from "../../hooks/useSettings";
import { formatUpcomingTimestamp } from "../../timestampFormat";

/**
 * The prepaid pay-as-you-go balance of a subscription with no usage windows: what is left, what
 * is held and what the month spent, and when the provider last read it. No meter — it is cash,
 * not a quota.
 */
export function BalanceLines({
  accounts,
  now,
}: {
  readonly accounts: readonly LimitAccount[];
  readonly now: number;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const rows = accounts.flatMap((account) =>
    account.balance && account.limits.windows.length === 0
      ? [
          {
            key: account.key,
            name: account.displayName ?? account.email,
            balance: account.balance,
            checkedAt: account.limits.checkedAt,
          },
        ]
      : [],
  );
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5 text-xs text-muted-foreground tabular-nums">
      {rows.map(({ key, name, balance, checkedAt }) => (
        <div key={key} className="flex flex-col gap-0.5">
          <p>
            {rows.length > 1 && name ? (
              <span className="font-medium text-foreground">{name}: </span>
            ) : null}
            {formatUsd(balance.balanceUsd)} left
          </p>
          {balance.heldUsd !== undefined || balance.monthSpendUsd !== undefined ? (
            <p>
              {[
                balance.heldUsd !== undefined ? `held ${formatUsd(balance.heldUsd)}` : null,
                balance.monthSpendUsd !== undefined
                  ? `${formatUsd(balance.monthSpendUsd)} this month`
                  : null,
              ]
                .filter((part) => part !== null)
                .join(" · ")}
            </p>
          ) : null}
          <p>Checked {formatUpcomingTimestamp(checkedAt, timestampFormat, now)}</p>
        </div>
      ))}
    </div>
  );
}
