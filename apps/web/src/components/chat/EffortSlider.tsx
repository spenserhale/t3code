import { nearestUsableEffortSliderStep } from "@t3tools/client-runtime/effort-slider";
import { useRef } from "react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface EffortSliderStop {
  readonly key: string;
  /** What makes two stops the same one; the arrow keys pass over a repeat of the stop they are on. */
  readonly identity: string;
  readonly modelLabel: string;
  readonly effortLabel: string | null;
  /** Why the stop cannot be applied here; it is dimmed and skipped. */
  readonly unusableReason: string | null;
}

/** What the model picker needs to show and drive the composer's effort slider. */
export interface ModelPickerEffortSlider {
  readonly stops: ReadonlyArray<EffortSliderStop>;
  /** The stop the committed selection sits on; null when it sits on none. */
  readonly activeIndex: number | null;
  /** Names the active stop for screen readers, such as "Sol, high effort". */
  readonly valueText: string;
  readonly onSelect: (index: number) => void;
}

/**
 * Model and effort stops along a track. Pressing or dragging applies a stop at once, and the
 * search box keeps focus: the keyboard drives the slider from there, so it holds no tab stop.
 */
export function EffortSlider(props: ModelPickerEffortSlider) {
  const { stops, activeIndex, valueText, onSelect } = props;
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const lastPickedRef = useRef<number | null>(null);
  const count = stops.length;

  const pickAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const index = nearestUsableEffortSliderStep(stops, (clientX - rect.left) / rect.width);
    if (index === null || index === lastPickedRef.current) return;
    lastPickedRef.current = index;
    if (index !== activeIndex) onSelect(index);
  };

  return (
    <div className="shrink-0 border-b border-border/70 bg-muted/40 px-3 pt-2 pb-1.5">
      <div
        ref={trackRef}
        role="slider"
        aria-label="Effort slider"
        aria-orientation="horizontal"
        aria-valuemin={1}
        aria-valuemax={count}
        aria-valuenow={activeIndex === null ? undefined : activeIndex + 1}
        aria-valuetext={valueText}
        data-effort-slider
        className="relative cursor-pointer touch-none select-none"
        // Both events, so a press never moves focus out of the search box.
        onMouseDown={(event) => event.preventDefault()}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          draggingRef.current = true;
          lastPickedRef.current = null;
          pickAt(event.clientX);
        }}
        onPointerMove={(event) => {
          if (draggingRef.current) pickAt(event.clientX);
        }}
        onPointerUp={() => {
          draggingRef.current = false;
        }}
        onPointerCancel={() => {
          draggingRef.current = false;
        }}
      >
        <div
          aria-hidden="true"
          className="absolute top-2 h-px bg-border"
          style={{ left: `${50 / count}%`, right: `${50 / count}%` }}
        />
        <ol
          className="relative grid"
          style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
        >
          {stops.map((stop, index) => {
            const active = index === activeIndex;
            const content = (
              <>
                <span className="flex h-4 items-center">
                  <span
                    aria-hidden="true"
                    className={cn(
                      "rounded-full border bg-popover",
                      active
                        ? "size-3 border-foreground bg-foreground ring-4 ring-foreground/15"
                        : "size-2 border-muted-foreground/60",
                    )}
                  />
                </span>
                <span
                  className={cn(
                    "max-w-full truncate text-xs leading-4",
                    active ? "font-medium text-foreground" : "text-muted-foreground",
                  )}
                >
                  {stop.modelLabel}
                </span>
                <span className="h-3.5 max-w-full truncate text-3xs leading-3.5 text-muted-foreground/80">
                  {stop.effortLabel}
                </span>
              </>
            );
            const stopProps = {
              "data-effort-slider-stop": index,
              "data-active": active || undefined,
              "data-unusable": stop.unusableReason !== null || undefined,
              className: cn(
                "flex min-w-0 flex-col items-center px-0.5",
                stop.unusableReason !== null && "opacity-40",
              ),
            };
            return stop.unusableReason === null ? (
              <li key={stop.key} {...stopProps}>
                {content}
              </li>
            ) : (
              <Tooltip key={stop.key}>
                <TooltipTrigger render={<li {...stopProps} />}>{content}</TooltipTrigger>
                <TooltipPopup side="bottom">{stop.unusableReason}</TooltipPopup>
              </Tooltip>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
