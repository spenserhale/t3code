import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DesktopBrowserCommand, DesktopBrowserEvent } from "./desktopBrowser.ts";
import { PreviewAutomationFillLoginResult } from "./previewLogin.ts";
import { SecretRelayAnswer, SecretRelayItem, SecretRelayRequest } from "./secretRelay.ts";

const decodeCommand = Schema.decodeUnknownSync(DesktopBrowserCommand);
const decodeEvent = Schema.decodeUnknownSync(DesktopBrowserEvent);
const isRequest = Schema.is(SecretRelayRequest);
const decodeRequest = Schema.decodeUnknownSync(SecretRelayRequest);
const decodeAnswer = Schema.decodeUnknownSync(SecretRelayAnswer);
const decodeResult = Schema.decodeUnknownSync(PreviewAutomationFillLoginResult);
const decodeItem = Schema.decodeUnknownSync(SecretRelayItem);
const encodeResult = Schema.encodeSync(PreviewAutomationFillLoginResult);
const encodeRequest = Schema.encodeSync(SecretRelayRequest);
const encodeItem = Schema.encodeSync(SecretRelayItem);

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

describe("login MFA wire compatibility", () => {
  it("decodes earlier successful fills, relay requests and items without metadata", () => {
    const result = {
      status: "filled",
      tabId: "tab-a",
      login: { id: "login-a", title: "Example" },
      filled: ["password"],
    };
    const request = {
      requestId: "request-a",
      kind: "login",
      threadId: "thread-a",
      expiresAt: 120_000,
    };
    const item = { id: "login-a", title: "Example", urls: ["https://example.com"] };
    expect(decodeResult(result)).toEqual(result);
    expect(decodeRequest(request)).toEqual(request);
    expect(decodeItem(item)).toEqual(item);
  });

  it.each([true, false])(
    "round-trips saved-code availability %s and relay tab identity",
    (hasTotp) => {
      const result = {
        status: "filled",
        tabId: "tab-a",
        login: { id: "login-a", title: "Example" },
        filled: ["password"],
        hasTotp,
      };
      const request = {
        requestId: "request-a",
        kind: "login",
        threadId: "thread-a",
        expiresAt: 120_000,
        tabId: "tab-a",
      };
      const item = { id: "login-a", title: "Example", urls: ["https://example.com"], hasTotp };
      expect.soft(encodeResult(decodeResult(result))).toEqual(result);
      expect.soft(encodeRequest(decodeRequest(request))).toEqual(request);
      expect.soft(encodeItem(decodeItem(item))).toEqual(item);
    },
  );
});
