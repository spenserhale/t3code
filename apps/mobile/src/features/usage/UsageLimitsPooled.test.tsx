import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const presentations = vi.hoisted(() => ({ current: new Map<string, unknown>() }));

vi.mock("react-native", () => ({
  Linking: { openURL: vi.fn() },
  Pressable: ({ children, onPress }: { children: ReactNode; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-svg", () => ({
  Defs: () => null,
  Path: () => null,
  Pattern: () => null,
  Rect: () => null,
  Svg: () => null,
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// The section reads its presentations atom; the test hands it the map directly.
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAtomValue: () => presentations.current,
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: vi.fn() }) }));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({
  ScreenScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationsWithProvidersAtom: {} },
}));
vi.mock("../settings/components/SettingsScreen", () => ({
  SettingsScreen: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./UsageLimitsSection", () => ({ ResetCredits: () => null }));
vi.mock("./usageProviders", () => ({
  usageProviderKind: () => null,
  useProviderColors: () => ({}),
}));

import { UsageLimitsSection } from "./UsageLimitsPooled";

const now = Date.parse("2026-09-03T12:00:00.000Z");
const checkedAt = "2026-09-03T11:00:00.000Z";

const window = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;

function unlidProvider(
  subscription: NonNullable<NonNullable<ServerProvider["usageLimits"]>["subscriptions"]>[number],
  windows: NonNullable<ServerProvider["usageLimits"]>["windows"] = [],
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("opencode"),
    driver: ProviderDriverKind.make("opencode"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt, windows, subscriptions: [subscription] },
  };
}

const unlidSubscription = {
  id: "unlid",
  label: "Unlid",
  credentialFingerprint: "fp1",
  checkedAt,
  windowIds: [] as string[],
};

function sectionText(providers: ServerProvider[]) {
  presentations.current = new Map([
    [EnvironmentId.make("A"), { entry: { target: { label: "A" } }, serverConfig: { providers } }],
  ]);
  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  act(() =>
    root.render(<UsageLimitsSection now={now} failedLabels={[]} selectedEnvironmentIds={null} />),
  );
  return container.textContent ?? "";
}

describe("UsageLimitsSection balances", () => {
  it("shows a balance-only subscription what is left, held, and spent this month", () => {
    const text = sectionText([
      unlidProvider({
        ...unlidSubscription,
        balance: { balanceUsd: 4.99, heldUsd: 0.01, monthSpendUsd: 14.82 },
      }),
    ]);
    expect(text).toContain("Unlid");
    expect(text).toContain("$4.99");
    expect(text).toContain("left");
    expect(text).toContain("held $0.01 · $14.82 this month");
    expect(text).toContain("As of");
  });

  it("omits held and month spend the subscription does not report", () => {
    const text = sectionText([unlidProvider({ ...unlidSubscription, balance: { balanceUsd: 0 } })]);
    expect(text).toContain("$0.00");
    expect(text).toContain("left");
    expect(text).not.toContain("held");
    expect(text).not.toContain("this month");
  });

  it("does not render the balance of a subscription that also has windows", () => {
    const text = sectionText([
      unlidProvider(
        {
          ...unlidSubscription,
          windowIds: [window.id],
          balance: { balanceUsd: 4.99 },
        },
        [window],
      ),
    ]);
    expect(text).not.toContain("$4.99");
    expect(text).not.toContain("As of");
    expect(text).toContain("40%");
  });
});
