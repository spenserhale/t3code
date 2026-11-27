import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DesktopBrowserCommand, DesktopBrowserEvent } from "./desktopBrowser.ts";
import { SecretRelayAnswer, SecretRelayRequest } from "./secretRelay.ts";

const decodeCommand = Schema.decodeUnknownSync(DesktopBrowserCommand);
const decodeEvent = Schema.decodeUnknownSync(DesktopBrowserEvent);
const isRequest = Schema.is(SecretRelayRequest);
const decodeRequest = Schema.decodeUnknownSync(SecretRelayRequest);
const decodeAnswer = Schema.decodeUnknownSync(SecretRelayAnswer);

const candidates = [
  {
    id: "work/grafana",
    title: "Grafana",
    vault: "Work",
    account: "Company",
    username: "spenser@example.com",
    websites: ["https://grafana.example.com"],
  },
];

describe("login choice wire compatibility", () => {
  it("carries choices and their selected id through the desktop approval codecs", () => {
    const command = {
      type: "loginApproval",
      threadId: "thread-a",
      requestId: "approval-a",
      providerLabel: "1Password",
      origin: "https://auth.example.com",
      candidates,
      timeoutMs: 120_000,
    };
    expect(decodeCommand(command)).toEqual(command);

    const event = {
      type: "loginApproval",
      threadId: "thread-a",
      requestId: "approval-a",
      approved: "once",
      selected: candidates[0]!.id,
    };
    expect(decodeEvent(event)).toEqual(event);

    const { candidates: _, ...legacyCommand } = command;
    const { selected: __, ...legacyEvent } = event;
    expect(decodeCommand(legacyCommand)).toEqual(legacyCommand);
    expect(decodeEvent(legacyEvent)).toEqual(legacyEvent);
  });

  it("carries choice-only requests and the approved fill origin without secret values", () => {
    const request = {
      requestId: "request-a",
      kind: "loginChoice",
      threadId: "thread-a",
      origin: "https://auth.example.com",
      siteUrl: "https://app.example.com",
      candidates,
      expiresAt: 120_000,
    };
    expect(isRequest(request)).toBe(true);
    expect(decodeRequest(request)).toEqual(request);

    const answer = {
      type: "values",
      item: {
        id: candidates[0]!.id,
        title: candidates[0]!.title,
        urls: [],
        fillOrigin: request.origin,
      },
      values: {},
    };
    expect(decodeAnswer(answer)).toEqual(answer);
    const { fillOrigin: _, ...legacyItem } = answer.item;
    expect(decodeAnswer({ ...answer, item: legacyItem })).toEqual({ ...answer, item: legacyItem });
    const denied = { type: "denied", message: "The selected login has no totp." };
    expect(decodeAnswer(denied)).toEqual(denied);
    expect(decodeAnswer({ type: "denied" })).toEqual({ type: "denied" });
  });
});
