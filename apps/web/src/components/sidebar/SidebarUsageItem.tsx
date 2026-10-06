import { useAtomValue } from "@effect/atom-react";
import { collectLimitAccounts } from "@t3tools/shared/usageLimits";
import { ChartNoAxesColumnIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { environmentPresentations } from "../../state/presentation";
import { Popover, PopoverCreateHandle, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { UsageLimitsGlance } from "../usage/UsageLimitsGlance";
import { readUsagePagePreferences, saveUsagePagePreferences } from "../usage/usagePagePreferences";
import {
  handleSidebarUpdateReleaseNotesPopoverOpenChange,
  openSidebarUpdateReleaseNotesPopoverOnForwardTab,
} from "./SidebarUpdatePill";

/**
 * The sidebar's Usage button. Pressing it opens Usage. While a subscription
 * reports limits, resting the pointer on it or focusing it with the keyboard
 * shows what is left on each one in place of the button's name, from what the
 * servers last pushed: showing it never asks them to check again. The button
 * stays mounted either way, so focus and a press under way survive an account
 * starting or stopping to report.
 */
export function SidebarUsageItem({ onClick }: { readonly onClick: () => void }) {
  const accounts = collectLimitAccounts(useAtomValue(environmentPresentations.presentationsAtom));
  const showGlance = accounts.length > 0;
  const [glanceHandle] = useState(() => PopoverCreateHandle());
  const suppressFocusOpen = useRef(false);
  const glancePopupRef = useRef<HTMLDivElement>(null);
  const triggerId = useId();

  useEffect(() => {
    if (!showGlance) {
      glanceHandle.close();
      return;
    }

    const trigger = document.getElementById(triggerId);
    if (trigger?.matches(":focus-visible")) {
      glanceHandle.open(triggerId);
    }
  }, [glanceHandle, showGlance, triggerId]);

  const openLimits = () => {
    saveUsagePagePreferences({ ...readUsagePagePreferences(), metric: "limits" });
    onClick();
  };

  const button = (
    <SidebarMenuButton
      aria-label="Usage"
      onBlur={() => {
        suppressFocusOpen.current = false;
      }}
      onClick={onClick}
      onFocus={(event) => {
        if (!showGlance || !event.currentTarget.matches(":focus-visible")) return;
        if (suppressFocusOpen.current) {
          suppressFocusOpen.current = false;
          return;
        }
        flushSync(() => glanceHandle.open(triggerId));
      }}
      onKeyDown={(event) => {
        if (!showGlance) return;
        openSidebarUpdateReleaseNotesPopoverOnForwardTab(event, glanceHandle, triggerId);
      }}
      size="icon"
    >
      <ChartNoAxesColumnIcon />
    </SidebarMenuButton>
  );

  return (
    <SidebarMenuItem className="shrink-0">
      <Popover
        handle={glanceHandle}
        onOpenChange={(open, details) => {
          if (open && !showGlance) {
            details.cancel();
            return;
          }
          handleSidebarUpdateReleaseNotesPopoverOpenChange(open, details);
          if (open || details.reason !== "trigger-hover") return;
          // Base UI closes on pointer leave however the card opened. Keep it while
          // the keyboard is in it; focus leaving still closes it.
          const trigger = document.getElementById(triggerId);
          const focused = document.activeElement;
          if (
            glancePopupRef.current?.contains(focused) ||
            (trigger?.contains(focused) && trigger.matches(":focus-visible"))
          ) {
            details.cancel();
          }
        }}
      >
        <Tooltip disabled={showGlance}>
          <TooltipTrigger
            id={triggerId}
            render={
              <PopoverTrigger
                {...(!showGlance
                  ? {
                      "aria-controls": undefined,
                      "aria-expanded": undefined,
                      "aria-haspopup": undefined,
                    }
                  : {})}
                closeDelay={150}
                handle={glanceHandle}
                id={triggerId}
                openOnHover={showGlance}
                render={button}
              />
            }
          />
          {!showGlance ? <TooltipPopup side="top">Usage</TooltipPopup> : null}
        </Tooltip>
        {showGlance ? (
          <PopoverPopup
            align="start"
            aria-label="Limits"
            initialFocus={false}
            onKeyDownCapture={(event) => {
              if (
                event.key === "Escape" &&
                glancePopupRef.current?.contains(document.activeElement)
              ) {
                suppressFocusOpen.current = true;
              }
            }}
            padding="compact"
            ref={glancePopupRef}
            side="top"
            tooltipStyle
            width="md"
          >
            <UsageLimitsGlance accounts={accounts} onOpenLimits={openLimits} />
          </PopoverPopup>
        ) : null}
      </Popover>
    </SidebarMenuItem>
  );
}
