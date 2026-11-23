import type { PendingDesktopSecretApproval } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { ShieldCheckIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";

export function ThreadSecretApprovals({ threadId }: { threadId: string }) {
  const gt = useGT();
  const [pending, setPending] = useState<readonly PendingDesktopSecretApproval[]>([]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The desktop owns pending approvals across thread navigation.
  useEffect(() => window.desktopBridge?.onSecretApprovals?.(setPending), []);
  if (!pending.length) return null;

  return (
    <div className="mb-2 max-h-[45dvh] space-y-2 overflow-y-auto overscroll-contain rounded-xl">
      {pending.map((request) => (
        <details
          key={request.id}
          open={request.threadId === threadId}
          className="rounded-xl border border-border bg-card p-3 text-sm wrap-anywhere text-foreground"
        >
          <summary className="cursor-pointer font-medium">
            <ShieldCheckIcon aria-hidden className="mx-1 inline size-4" />
            {request.threadId === threadId
              ? request.message
              : gt("Review request from {thread}", { thread: request.threadLabel })}
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            {request.threadId !== threadId && <p className="font-medium">{request.message}</p>}
            <p>{request.detail[0]}</p>
            {request.command && (
              <pre className="max-h-32 overflow-auto rounded-md bg-muted p-2 font-mono whitespace-pre-wrap wrap-anywhere">
                {request.command}
              </pre>
            )}
            {request.detail.slice(1).map((line) => (
              <p key={line}>{line}</p>
            ))}
            <p className="text-muted-foreground">{request.threadNote}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => request.answer(false)}>
                <T>Deny</T>
              </Button>
              <Button size="sm" onClick={() => request.answer("once")}>
                <T>Allow once</T>
              </Button>
              <Button size="sm" variant="outline" onClick={() => request.answer("thread")}>
                {request.threadId === threadId
                  ? gt("Allow for this thread")
                  : gt("Allow for requesting thread")}
              </Button>
            </div>
          </div>
        </details>
      ))}
    </div>
  );
}
