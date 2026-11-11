import type { EnvironmentId, UsageProviderKind } from "@t3tools/contracts";

import { UsageLimitGroupsButton } from "./UsageLimitGroupsDialog";
import { UsageLimitRemindersButton } from "./UsageLimitRemindersDialog";

/** The buttons that set up Limits: how accounts are grouped and scheduled, and when to be reminded. */
export function UsageLimitControls(props: {
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
  readonly now: number;
}) {
  return (
    <>
      <UsageLimitGroupsButton {...props} />
      <UsageLimitRemindersButton />
    </>
  );
}
