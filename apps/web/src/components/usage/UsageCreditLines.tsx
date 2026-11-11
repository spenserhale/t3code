import { creditSummary } from "@t3tools/shared/usageCredit";
import type { LimitPoolWindow } from "@t3tools/shared/usageLimits";

/** What each account in a pooled window has used of its credit, for the plans that sell one. */
export function CreditLines({ pool }: { readonly pool: LimitPoolWindow }) {
  const rows = pool.members.flatMap(({ account }) =>
    account.credit
      ? [{ key: account.key, name: account.displayName ?? account.email, credit: account.credit }]
      : [],
  );
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5 text-xs text-muted-foreground tabular-nums md:col-span-2">
      {rows.map(({ key, name, credit }) => (
        <p key={key}>
          {rows.length > 1 && name ? (
            <span className="font-medium text-foreground">{name}: </span>
          ) : null}
          {creditSummary(credit).join(" · ")}
        </p>
      ))}
    </div>
  );
}
