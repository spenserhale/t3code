import { expect, type JsonValue } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A completed agent distinguishes background processes from Working",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("background-demo");
    await t3.thread({ project, title: "Background server", messages: ["Start"] });
    // Replay ACP terminalizes open tools, so this UI fixture supplies the native shell roster.
    await browser.route("**/api/orchestration/shell**", async (route) => {
      const response = await route.fetch();
      const snapshot = await response.json<{
        threads: Array<Record<string, JsonValue> & { title: string }>;
      }>();
      snapshot.threads = snapshot.threads.map((thread) =>
        thread.title === "Background server"
          ? {
              ...thread,
              lastVisitedAt: "2099-01-01T00:00:00.000Z",
              pendingBackgroundTasks: [
                { taskId: "server", kind: "command", description: "npm run dev" },
                { taskId: "watchdog", kind: "monitor", description: "Watch the server" },
              ],
            }
          : thread,
      );
      await route.fulfill({ json: snapshot });
    });
    await t3.open();

    const row = screen.getByRole("button", /Background server, 2 background processes running/);
    await expect(screen.getByRole("button", /Background server/)).toBeVisible();
    await app.screenshot("background-processes");
    await expect(row).toBeVisible();
    await expect(screen.getByText("Working", { exact: true })).toBeHidden();
    await row.hover();
    await expect(screen.getByText("2 background processes running", { exact: true })).toBeVisible();
    await app.screenshot("background-details");
  },
);
