import { assert, describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import { vi } from "vite-plus/test";

const { menu, buildFromTemplate } = vi.hoisted(() => {
  const menu = { template: [] as Electron.MenuItemConstructorOptions[] };
  const buildFromTemplate = vi.fn((template: Electron.MenuItemConstructorOptions[]) => {
    menu.template = template;
    return { popup: (options: Electron.PopupOptions) => options.callback?.() };
  });
  return { menu, buildFromTemplate };
});

vi.mock("electron", () => ({ Menu: { buildFromTemplate } }));

import * as ElectronMenu from "./ElectronMenu.ts";

describe("ElectronMenu", () => {
  it.effect("shows ampersands in labels instead of reading them as mnemonics", () =>
    Effect.gen(function* () {
      const electronMenu = yield* ElectronMenu.make;
      yield* electronMenu.showContextMenu({
        window: { webContents: { getZoomFactor: () => 1 } } as Electron.BrowserWindow,
        items: [
          { id: "filter", label: "Filter by R&D" },
          { id: "more", label: "A&B", children: [{ id: "child", label: "C && D" }] },
        ],
        position: Option.none(),
        source: Option.none(),
      });

      assert.deepEqual(
        menu.template.map((item) => item.label),
        ["Filter by R&&D", "A&&B"],
      );
      const submenu = menu.template[1]!.submenu as Electron.MenuItemConstructorOptions[];
      assert.equal(submenu[0]!.label, "C &&&& D");
    }).pipe(Effect.provideService(HostProcess.Platform, "win32")),
  );
});

const window = {
  id: 1,
  webContents: { getZoomFactor: () => 1.5 },
} as unknown as Electron.BrowserWindow;

const setup = Effect.gen(function* () {
  const shown = yield* Queue.unbounded<{
    readonly template: readonly Electron.MenuItemConstructorOptions[];
    readonly options: Electron.PopupOptions;
    readonly closePopup: ReturnType<typeof vi.fn>;
  }>();
  buildFromTemplate.mockImplementation(
    (template: readonly Electron.MenuItemConstructorOptions[]) => {
      let popupOptions: Electron.PopupOptions | undefined;
      const closePopup = vi.fn(() => popupOptions?.callback?.());
      return {
        closePopup,
        popup: (options: Electron.PopupOptions) => {
          popupOptions = options;
          Queue.offerUnsafe(shown, { template, options, closePopup });
        },
      };
    },
  );
  const menus = yield* ElectronMenu.make.pipe(Effect.provideService(HostProcess.Platform, "linux"));
  return { shown, menus };
});

it.effect("closes an aborted native menu and refuses its late row click", () => {
  const cancelled = new AbortController();
  return Effect.gen(function* () {
    const { shown, menus } = yield* setup;
    const answer = yield* menus
      .showContextMenu({
        window,
        items: [{ id: "second", label: "Second login" }],
        position: Option.none(),
        source: Option.none(),
        signal: cancelled.signal,
      })
      .pipe(Effect.forkScoped);
    const popup = yield* Queue.take(shown);
    cancelled.abort();
    expect(popup.closePopup).toHaveBeenCalledTimes(1);
    popup.template[0]?.click?.({} as Electron.MenuItem, window, {} as Electron.KeyboardEvent);
    expect(yield* Fiber.join(answer)).toEqual(Option.none());
  }).pipe(Effect.scoped);
});

it.effect("closes a native popup when its waiting effect is interrupted", () =>
  Effect.gen(function* () {
    const { shown, menus } = yield* setup;
    const answer = yield* menus
      .showContextMenu({
        window,
        items: [{ id: "first", label: "First login" }],
        position: Option.none(),
        source: Option.none(),
      })
      .pipe(Effect.forkScoped);
    const popup = yield* Queue.take(shown);
    yield* Fiber.interrupt(answer);
    expect(popup.closePopup).toHaveBeenCalledTimes(1);
  }).pipe(Effect.scoped),
);

it.effect("keeps explicit selection, scaled positions, and native dismissal working", () =>
  Effect.gen(function* () {
    const { shown, menus } = yield* setup;
    for (const selected of [true, false]) {
      const answer = yield* menus
        .showContextMenu({
          window,
          items: [{ id: "first", label: "First login" }],
          position: Option.some({ x: 10, y: 20 }),
          source: Option.none(),
        })
        .pipe(Effect.forkScoped);
      const popup = yield* Queue.take(shown);
      expect(popup.options).toMatchObject({ window, x: 15, y: 30 });
      if (selected) {
        popup.template[0]?.click?.({} as Electron.MenuItem, window, {} as Electron.KeyboardEvent);
      }
      popup.options.callback?.();
      expect(yield* Fiber.join(answer)).toEqual(selected ? Option.some("first") : Option.none());
      expect(popup.closePopup).not.toHaveBeenCalled();
    }
  }).pipe(Effect.scoped),
);
