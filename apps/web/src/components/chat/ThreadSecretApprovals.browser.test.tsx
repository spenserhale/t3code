import type { PendingDesktopSecretApproval } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render, stubGlobal } from "../../../test/render";
import { ThreadSecretApprovals } from "./ThreadSecretApprovals";

it("opens the requesting thread's approval and keeps other threads' decisions separate", async () => {
  const first = {
    id: 1,
    threadId: "one",
    threadLabel: "First",
    message: "Use a secret from Personal?",
    detail: ["Requested for the build."],
    command: "build",
    threadNote: "Until restart.",
    answer: vi.fn(),
  };
  const second = { ...first, id: 2, threadId: "two", threadLabel: "Second", answer: vi.fn() };
  using _bridge = stubGlobal("desktopBridge", {
    onSecretApprovals: (listener: (requests: readonly PendingDesktopSecretApproval[]) => void) => {
      listener([first, second]);
      return () => {};
    },
  });
  await using screen = await render(<ThreadSecretApprovals threadId="one" />);
  await expect.element(screen.getByText("Review request from Second")).toBeVisible();
  await screen.getByRole("button", { name: "Allow once", exact: true }).click();
  expect(first.answer).toHaveBeenCalledWith("once");
  expect(second.answer).not.toHaveBeenCalled();
  await screen.rerender(<ThreadSecretApprovals threadId="two" />);
  await screen.getByRole("button", { name: "Deny" }).click();
  expect(second.answer).toHaveBeenCalledWith(false);
});
