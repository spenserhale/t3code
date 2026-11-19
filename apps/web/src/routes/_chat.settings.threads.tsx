import { isProviderDriverKind } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { ThreadsSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/_chat/settings/threads")({
  validateSearch: (search: Record<string, unknown>) =>
    isProviderDriverKind(search.effortSliderProvider)
      ? { effortSliderProvider: search.effortSliderProvider }
      : {},
  component: ThreadsSettingsPanel,
});
