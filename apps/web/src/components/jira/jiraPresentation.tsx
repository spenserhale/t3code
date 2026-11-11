import type { JiraIssueSummary, JiraStatusCategory } from "@t3tools/contracts";
import { BookOpenIcon, BugIcon, ListTreeIcon, SquareCheckBigIcon, ZapIcon } from "lucide-react";

import { Badge } from "../ui/badge";

const STATUS_BADGE_VARIANT = {
  todo: "secondary",
  "in-progress": "info",
  done: "success",
  unknown: "outline",
} as const satisfies Record<JiraStatusCategory, "secondary" | "info" | "success" | "outline">;

export function JiraStatusBadge({ status }: { readonly status: JiraIssueSummary["status"] }) {
  return (
    <Badge variant={STATUS_BADGE_VARIANT[status.category]} size="sm">
      <span className="max-w-40 truncate">{status.name}</span>
    </Badge>
  );
}

export function JiraIssueTypeIcon({
  issueType,
  className,
}: {
  readonly issueType: string;
  readonly className?: string;
}) {
  const type = issueType.toLowerCase();
  if (type.includes("bug") || type.includes("defect")) {
    return <BugIcon aria-hidden className={className} />;
  }
  if (type.includes("epic")) return <ZapIcon aria-hidden className={className} />;
  if (type.includes("sub")) return <ListTreeIcon aria-hidden className={className} />;
  if (type.includes("story")) return <BookOpenIcon aria-hidden className={className} />;
  return <SquareCheckBigIcon aria-hidden className={className} />;
}
