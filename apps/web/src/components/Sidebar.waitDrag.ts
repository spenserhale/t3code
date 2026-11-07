import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, ThreadId, ThreadWait } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import {
  canThreadWait,
  isThreadWaitBlockerCandidate,
  threadWaitDropLabel,
  type ThreadWaitThread,
} from "./threadWait.logic";

type Point = { readonly x: number; readonly y: number };

/**
 * Option-drag (Alt elsewhere) links instead of reordering: the row under the pointer becomes
 * the thread to wait on. Null when the gesture is not linking at all; `target` is null over a
 * row that cannot be waited on.
 */
export function resolveThreadWaitDrag(input: {
  readonly modifierHeld: boolean;
  readonly insideList: boolean;
  readonly supported: boolean;
  readonly source: ThreadWaitThread | undefined;
  readonly target: ThreadWaitThread | undefined;
  readonly waits: ReadonlyArray<Pick<ThreadWait, "threadId" | "blockerThreadId">>;
}): { readonly target: ThreadWaitThread | null } | null {
  const { source, target } = input;
  if (!input.modifierHeld || !input.insideList || !input.supported || source === undefined) {
    return null;
  }
  return {
    target:
      target !== undefined &&
      canThreadWait(source) &&
      isThreadWaitBlockerCandidate(target, source, input.waits)
        ? target
        : null,
  };
}

export interface ThreadWaitDragBadge extends Point {
  readonly label: string;
  readonly valid: boolean;
}

let badge: ThreadWaitDragBadge | null = null;
const badgeListeners = new Set<() => void>();
function setBadge(next: ThreadWaitDragBadge | null) {
  if (badge === next) return;
  badge = next;
  for (const listener of badgeListeners) listener();
}

export function useThreadWaitDragBadge(): ThreadWaitDragBadge | null {
  return useSyncExternalStore(
    (listener) => {
      badgeListeners.add(listener);
      return () => badgeListeners.delete(listener);
    },
    () => badge,
    () => null,
  );
}

const TARGET_CLASSES = ["outline-2", "-outline-offset-2", "outline-primary"];

/**
 * Drives link mode from the sidebar's pointer sensor callbacks. dnd-kit hides modifier keys,
 * so the modifier is tracked on window for the length of the drag.
 */
export interface ThreadWaitDragContext {
  readonly list: HTMLElement | null;
  readonly sourceKey: string | null;
  readonly threads: ReadonlyMap<string, ThreadWaitThread>;
}

export function createThreadWaitDrag(deps: {
  readonly waits: (environmentId: ScopedThreadRef["environmentId"]) => {
    readonly supported: boolean;
    readonly waits: ReadonlyArray<ThreadWait>;
  };
  readonly onLink: (threadRef: ScopedThreadRef, blockerThreadId: ThreadId) => void;
}) {
  let modifierHeld = false;
  let attached = false;
  let lastPoint: Point | null = null;
  let highlighted: HTMLElement | null = null;
  let target: ThreadWaitThread | null = null;
  let context: ThreadWaitDragContext | null = null;

  const highlight = (element: HTMLElement | null) => {
    if (element === highlighted) return;
    highlighted?.classList.remove(...TARGET_CLASSES);
    element?.classList.add(...TARGET_CLASSES);
    highlighted = element;
  };

  const resolve = (point: Point) => {
    const list = context?.list ?? null;
    const sourceKey = context?.sourceKey ?? null;
    const source = sourceKey === null ? undefined : context?.threads.get(sourceKey);
    const bounds = list?.getBoundingClientRect();
    const row =
      list?.ownerDocument
        .elementFromPoint(point.x, point.y)
        ?.closest<HTMLElement>("li[data-thread-item]") ?? null;
    const rowKey = row !== null && list?.contains(row) ? (row.dataset.threadItem ?? null) : null;
    const { supported, waits } = source
      ? deps.waits(source.environmentId)
      : { supported: false, waits: [] };
    const linking = resolveThreadWaitDrag({
      modifierHeld,
      insideList: bounds !== undefined && point.x >= bounds.left && point.x <= bounds.right,
      supported,
      source,
      target: rowKey === null ? undefined : context?.threads.get(rowKey),
      waits,
    });
    target = linking?.target ?? null;
    highlight(
      target === null ? null : (row?.querySelector<HTMLElement>("[data-sidebar-row]") ?? row),
    );
    setBadge(
      linking === null
        ? null
        : { ...point, label: threadWaitDropLabel(target?.title), valid: target !== null },
    );
    return linking !== null;
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Alt") return;
    event.preventDefault();
    modifierHeld = event.type === "keydown";
    if (lastPoint !== null) resolve(lastPoint);
  };
  // Capture on window runs before the sensor's document listener reports the same move.
  const onPointerMove = (event: PointerEvent) => {
    modifierHeld = event.altKey;
  };

  const end = () => {
    if (attached) {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      attached = false;
    }
    modifierHeld = false;
    lastPoint = null;
    context = null;
    target = null;
    highlight(null);
    setBadge(null);
  };

  return {
    /** True while linking, so the sidebar holds rows still instead of sorting. */
    move(point: Point, current: ThreadWaitDragContext): boolean {
      context = current;
      if (!attached) {
        window.addEventListener("keydown", onKey, true);
        window.addEventListener("keyup", onKey, true);
        window.addEventListener("pointermove", onPointerMove, true);
        attached = true;
      }
      lastPoint = point;
      return resolve(point);
    },
    /** True when the release belonged to link mode; it never reorders. */
    drop(point: Point, current: ThreadWaitDragContext): boolean {
      context = current;
      const linking = resolve(point);
      const sourceKey = current.sourceKey;
      const sourceRef = sourceKey === null ? null : parseScopedThreadKey(sourceKey);
      if (linking && target !== null && sourceRef !== null) {
        deps.onLink(sourceRef, target.id);
      }
      end();
      return linking;
    },
    end,
  };
}
