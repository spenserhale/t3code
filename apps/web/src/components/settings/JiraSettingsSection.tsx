import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import { useServerConfigs } from "../../state/entities";
import { jiraConfigure, jiraDisconnect, jiraStatusQuery } from "../../state/jira";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { ensureLocalApi } from "../../localApi";
import { useJiraPreferences } from "../jira/jiraPreferences";
import { jiraConnectionSummary } from "./jiraConnectionSummary";
import { Button, InlineButton } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SecretInput } from "./SecretInput";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const API_TOKEN_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";

function JiraConnection({ environmentId }: { environmentId: EnvironmentId }) {
  // What is saved and whether Jira accepts it are asked apart, so credentials Jira has stopped
  // accepting still show as saved and can be replaced or removed.
  const saved = useEnvironmentQuery(jiraStatusQuery({ environmentId, input: {} }));
  const verified = useEnvironmentQuery(jiraStatusQuery({ environmentId, input: { verify: true } }));
  const canConfigure = useAtomValue(jiraConfigure.permissionAtom(environmentId));
  const configure = useAtomCommand(jiraConfigure, { reportFailure: false });
  const disconnect = useAtomCommand(jiraDisconnect, { reportFailure: false });
  const [site, setSite] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const { configured, message } = jiraConnectionSummary({
    saved: saved.data,
    account: verified.data?.account ?? null,
    error: verified.error,
  });
  const siteValue = site ?? saved.data?.siteUrl ?? "";
  const emailValue = email ?? saved.data?.email ?? "";
  const ready = siteValue.trim() !== "" && emailValue.trim() !== "" && token.trim() !== "";

  const save = async () => {
    if (!ready || pending) return;
    setPending(true);
    setProblem(null);
    const result = await configure({
      environmentId,
      input: {
        siteUrl: siteValue.trim(),
        email: emailValue.trim(),
        apiToken: Redacted.make(token.trim()),
      },
    });
    setPending(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setProblem(error instanceof Error ? error.message : "Could not connect to Jira.");
      return;
    }
    setToken("");
    setSite(null);
    setEmail(null);
    toastManager.add({
      type: "success",
      title: "Connected to Jira",
      description: result.value.account?.displayName ?? result.value.siteUrl ?? "",
    });
  };

  const remove = async () => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      "Disconnect Jira? The saved API token is removed from this environment.",
      { variant: "destructive" },
    );
    if (!confirmed) return;
    setPending(true);
    const result = await disconnect({ environmentId, input: {} });
    setPending(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setProblem(error instanceof Error ? error.message : "Could not disconnect Jira.");
      return;
    }
    setSite(null);
    setEmail(null);
    setProblem(null);
  };

  return (
    <form
      className="grid gap-3 px-3 py-3 sm:px-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <fieldset disabled={pending || !canConfigure} className="contents">
        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
          Connects this environment to Jira Cloud with your email and an API token, which stays on
          the environment and is never shown again. Create the token without scopes.{" "}
          <InlineButton
            render={<a href={API_TOKEN_URL} target="_blank" rel="noreferrer noopener" />}
          >
            Create an API token
            <ExternalLinkIcon aria-hidden className="size-3" />
          </InlineButton>
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor={`jira-site-${environmentId}`}>Site</Label>
            <Input
              id={`jira-site-${environmentId}`}
              size="sm"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://your-team.atlassian.net"
              value={siteValue}
              onChange={(event) => setSite(event.currentTarget.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`jira-email-${environmentId}`}>Email</Label>
            <Input
              id={`jira-email-${environmentId}`}
              size="sm"
              type="email"
              autoComplete="off"
              spellCheck={false}
              placeholder="you@example.com"
              value={emailValue}
              onChange={(event) => setEmail(event.currentTarget.value)}
            />
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`jira-token-${environmentId}`}>API token</Label>
          <SecretInput
            id={`jira-token-${environmentId}`}
            size="sm"
            configured={configured}
            value={token}
            onChange={(event) => setToken(event.currentTarget.value)}
          />
        </div>
        {problem === null ? null : <p className="text-destructive text-xs">{problem}</p>}
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">{message}</p>
          <div className="flex shrink-0 gap-2">
            {configured ? (
              <Button type="button" size="xs" variant="outline" onClick={() => void remove()}>
                Disconnect
              </Button>
            ) : null}
            <Button type="submit" size="xs" disabled={!ready}>
              {pending ? "Testing..." : configured ? "Replace and test" : "Save and test"}
            </Button>
          </div>
        </div>
      </fieldset>
    </form>
  );
}

function MoveOnStartRow() {
  const [preferences, updatePreferences] = useJiraPreferences();
  const moving = preferences.moveOnStart !== null;
  return (
    <SettingsRow
      title="Move the issue when a thread starts"
      description="Starting a thread from a Jira issue also moves the issue to this status, when Jira offers the move."
      control={
        <div className="flex items-center gap-2">
          {moving ? (
            <Input
              size="sm"
              className="w-36"
              aria-label="Status to move issues to"
              value={preferences.moveOnStart ?? ""}
              onChange={(event) => updatePreferences({ moveOnStart: event.currentTarget.value })}
            />
          ) : null}
          <Switch
            checked={moving}
            onCheckedChange={(checked) =>
              updatePreferences({ moveOnStart: checked ? "In Progress" : null })
            }
            aria-label="Move the issue when a thread starts"
          />
        </div>
      }
    />
  );
}

/** Where a server gets the Jira site, email and API token it reads and updates issues with. */
export function JiraSettingsSection() {
  const { environment, connectedEnvironments, scope } = useSettingsScope();
  const configs = useServerConfigs();
  const environmentId =
    environment?.connection.phase === "connected" ? environment.environmentId : null;
  if (
    environmentId === null ||
    configs.get(environmentId)?.environment.capabilities.jiraIssues !== true
  ) {
    return null;
  }
  const aggregate = scope.environmentIds.length !== 1 && connectedEnvironments.length > 1;
  return (
    <SettingsSection title={aggregate && environment ? `Jira · ${environment.label}` : "Jira"}>
      <JiraConnection key={environmentId} environmentId={environmentId} />
      <MoveOnStartRow />
    </SettingsSection>
  );
}
