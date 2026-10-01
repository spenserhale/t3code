import type { DesktopSshPasswordPromptRequest } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { enqueueSshPasswordPrompt } from "./SshPasswordPromptDialog";

function promptRequest(
  overrides: Partial<DesktopSshPasswordPromptRequest> & { requestId: string },
): DesktopSshPasswordPromptRequest {
  return {
    destination: "torrent.home.arpa",
    username: "spenser",
    prompt: "Enter the SSH password for spenser@torrent.home.arpa.",
    expiresAt: "2026-10-01T04:00:00.000Z",
    ...overrides,
  };
}

describe("enqueueSshPasswordPrompt", () => {
  it("appends prompts for destinations that are not queued", () => {
    const first = promptRequest({ requestId: "r1" });
    const second = promptRequest({ requestId: "r2", destination: "other.home.arpa" });

    expect(enqueueSshPasswordPrompt([], first)).toEqual([first]);
    expect(enqueueSshPasswordPrompt([first], second)).toEqual([first, second]);
  });

  it("replaces the queued prompt when the same destination asks again", () => {
    const first = promptRequest({ requestId: "r1" });
    const replacement = promptRequest({ requestId: "r2" });

    expect(enqueueSshPasswordPrompt([first], replacement)).toEqual([replacement]);
  });

  it("keeps other destinations and their order while replacing", () => {
    const firstA = promptRequest({ requestId: "a1", destination: "a.home.arpa" });
    const firstB = promptRequest({ requestId: "b1", destination: "b.home.arpa" });
    const secondA = promptRequest({ requestId: "a2", destination: "a.home.arpa" });

    expect(enqueueSshPasswordPrompt([firstA, firstB], secondA)).toEqual([firstB, secondA]);
  });

  it("treats different usernames on one destination as distinct prompts", () => {
    const user = promptRequest({ requestId: "r1" });
    const root = promptRequest({ requestId: "r2", username: "root" });

    expect(enqueueSshPasswordPrompt([user], root)).toEqual([user, root]);
  });

  it("treats a missing username as distinct from a named one", () => {
    const named = promptRequest({ requestId: "r1" });
    const anonymous = promptRequest({ requestId: "r2", username: null });

    expect(enqueueSshPasswordPrompt([named], anonymous)).toEqual([named, anonymous]);
  });
});
