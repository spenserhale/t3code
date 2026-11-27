import type { StandaloneIssueTrackerDescriptor } from "@t3tools/contracts";
import type { Dispatch, SetStateAction } from "react";

import { Input } from "../ui/input";
import { SettingsRow } from "./settingsLayout";

/**
 * The plain fields a tracker asks for before its secret, one row each. Labels and placeholders
 * come from the server; the values are packed into the connect token by `issueTrackerConnectToken`.
 */
export function IssueTrackerCredentialFields({
  credential,
  idPrefix,
  values,
  onChange,
}: {
  readonly credential: StandaloneIssueTrackerDescriptor["credential"];
  readonly idPrefix: string;
  readonly values: Readonly<Record<string, string>>;
  readonly onChange: Dispatch<SetStateAction<Record<string, string>>>;
}) {
  return credential.fields?.map((field) => (
    <SettingsRow
      key={field.key}
      title={<label htmlFor={`${idPrefix}-${field.key}`}>{field.label}</label>}
      control={
        <Input
          id={`${idPrefix}-${field.key}`}
          size="sm"
          className="w-full @min-[32rem]/settings-row:w-56"
          autoComplete="off"
          spellCheck={false}
          placeholder={field.placeholder}
          value={values[field.key] ?? ""}
          onChange={(event) => {
            const value = event.target.value;
            onChange((current) => ({ ...current, [field.key]: value }));
          }}
        />
      }
    />
  ));
}
