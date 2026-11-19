import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { fileDisplayName } from "@t3tools/shared/path";
import { CheckIcon, ChevronDownIcon, FolderIcon, LayersIcon } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import { T, useGT, useMessages, Var } from "gt-react";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSearchInput,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { resolveSettingsScope, type SettingsScopeSearch } from "./settingsScope";
import {
  ALL_CHECKOUTS_VALUE,
  ALL_ENVIRONMENTS_VALUE,
  ALL_PROJECTS_VALUE,
  environmentAxisValue,
  projectAxisValue,
  projectScopeMenuGroups,
  selectCheckoutAxis,
  selectEnvironmentAxis,
  selectEnvironmentSubset,
  selectProjectAxis,
  settingsScopeCheckoutChoices,
  settingsScopeCheckoutLabel,
  settingsScopeEnvironmentAddress,
  settingsScopeEnvironmentLabel,
  settingsScopeEnvironmentLabels,
  settingsScopeProjectMachines,
} from "./settingsScopeAxis";
import { useRenderedSettingsPathname } from "./useRenderedSettingsPathname";

export const SETTINGS_DEVICE_ONLY_PATHS: ReadonlySet<string> = new Set([
  "/settings/general",
  "/settings/appearance",
  "/settings/chat",
  "/settings/diffs",
  "/settings/snap-shot",
  "/settings/connections",
  // Access picks its environment on the page itself.
  "/settings/access",
  "/settings/about",
]);

interface SettingsScopeMenuProps {
  readonly value: SettingsScopeSearch;
  readonly groups: readonly SidebarProjectSnapshot[];
  readonly environments: readonly EnvironmentPresentation[];
  readonly singleEnvironment: boolean;
  readonly disabled?: boolean;
  readonly onChange: (next: SettingsScopeSearch) => void;
}

export function SettingsEnvironmentScopeMenu({ disabled }: { disabled: boolean }) {
  const scope = useOptionalSettingsScope();
  const { environments } = useEnvironments();
  if (scope === null || scope.scope.kind === "checkout") return null;
  return (
    <EnvironmentScopeMenu
      value={scope.search}
      singleEnvironment={scope.singleEnvironment}
      groups={scope.groups}
      environments={environments}
      disabled={disabled}
      onChange={(next) => scope.selectScope(next, { replace: true })}
    />
  );
}

export function SettingsScopeSentence() {
  const scope = useOptionalSettingsScope();
  const pathname = useRenderedSettingsPathname();
  const { environments } = useEnvironments();
  if (scope === null || SETTINGS_DEVICE_ONLY_PATHS.has(pathname)) return null;
  const props: SettingsScopeMenuProps = {
    value: scope.search,
    singleEnvironment: scope.singleEnvironment,
    groups: scope.groups,
    environments,
    onChange: scope.selectScope,
  };
  const group = scope.groups.find((candidate) => candidate.projectKey === scope.search.project);
  const hasCheckouts = group ? settingsScopeCheckoutChoices(group, scope.search).length > 0 : false;
  const project = <ProjectScopeMenu {...props} />;
  const environment = <EnvironmentScopeMenu {...props} />;
  const checkout = <CheckoutScopeMenu {...props} />;
  const onEnvironment = scope.search.machine || scope.scope.kind === "checkout";
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 px-3 text-sm text-muted-foreground sm:px-4">
      {onEnvironment && hasCheckouts ? (
        <T context="settings scope sentence; each variable is a menu">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0">Applying settings for</span>
            <Var>{project}</Var>
          </span>
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0">on</span>
            <Var>{environment}</Var>
          </span>
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0">in</span>
            <Var>{checkout}</Var>
          </span>
        </T>
      ) : onEnvironment ? (
        <T context="settings scope sentence; each variable is a menu">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0">Applying settings for</span>
            <Var>{project}</Var>
          </span>
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0">on</span>
            <Var>{environment}</Var>
          </span>
        </T>
      ) : hasCheckouts ? (
        <T context="settings scope sentence; each variable is a menu">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0">Applying settings for</span>
            <Var>{project}</Var>
          </span>
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0">across</span>
            <Var>{environment}</Var>
          </span>
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0">in</span>
            <Var>{checkout}</Var>
          </span>
        </T>
      ) : (
        <T context="settings scope sentence; each variable is a menu">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0">Applying settings for</span>
            <Var>{project}</Var>
          </span>
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0">across</span>
            <Var>{environment}</Var>
          </span>
        </T>
      )}
    </p>
  );
}

interface ScopeOption {
  value: string;
  label: string;
  secondary?: string;
  icon?: ReactNode;
  offline?: boolean;
}

function ScopeOptionLabel({ option }: { option: ScopeOption }) {
  return (
    <>
      {option.icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{option.label}</span>
        {option.secondary ? (
          <span className="block truncate text-xs text-muted-foreground">{option.secondary}</span>
        ) : null}
      </span>
      {option.offline ? (
        <span className="shrink-0 text-xs text-muted-foreground">
          <T>Offline</T>
        </span>
      ) : null}
    </>
  );
}

function ScopeTriggerLabel({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <>
      {icon}
      <span className="min-w-0 truncate">{label}</span>
      <ChevronDownIcon
        aria-hidden
        strokeWidth={1.75}
        className="-me-0.5 size-3.5 shrink-0 text-muted-foreground opacity-70"
      />
    </>
  );
}

function ScopeMenu({
  ariaLabel,
  icon,
  label,
  value,
  options,
  allOption,
  searchLabel,
  onChange,
}: {
  ariaLabel: string;
  icon: ReactNode;
  label: string;
  value: string;
  options: ScopeOption[];
  allOption: ScopeOption | null;
  searchLabel: string;
  onChange: (next: string) => void;
}) {
  const [query, setQuery] = useState("");
  const Trigger = options.length > 6 ? ComboboxTrigger : MenuTrigger;
  const trigger = (
    <Trigger
      aria-label={`${ariaLabel}: ${label}`}
      render={<Button variant="outline" size="sm" />}
      className="min-w-0 max-w-72"
    >
      <ScopeTriggerLabel icon={icon} label={label} />
    </Trigger>
  );
  const choices = allOption ? [allOption, ...options] : options;
  if (options.length > 6) {
    const needle = query.trim().toLowerCase();
    const filteredItems = choices.filter((option) =>
      `${option.label} ${option.secondary ?? ""} ${option.value}`.toLowerCase().includes(needle),
    );
    return (
      <Combobox
        items={choices}
        filteredItems={filteredItems}
        filter={null}
        autoHighlight
        itemToStringLabel={(option) => option.label}
        isItemEqualToValue={(a, b) => a.value === b.value}
        value={choices.find((option) => option.value === value) ?? null}
        onOpenChange={(open) => {
          if (!open) setQuery("");
        }}
        onValueChange={(option) => {
          if (option) onChange(option.value);
        }}
      >
        {trigger}
        <ComboboxPopup align="start" className="w-80">
          <ComboboxSearchInput
            aria-label={searchLabel}
            placeholder={searchLabel}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <ComboboxEmpty>
            <T>No matches found.</T>
          </ComboboxEmpty>
          <ComboboxList>
            {(option: ScopeOption) => (
              <ComboboxItem key={option.value} value={option}>
                <ScopeOptionLabel option={option} />
                {option.value === value ? (
                  <CheckIcon aria-hidden className="size-3.5 shrink-0" />
                ) : null}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
    );
  }
  return (
    <Menu>
      {trigger}
      <MenuPopup align="start">
        <div className="w-72 max-w-full">
          <MenuRadioGroup
            value={value}
            onValueChange={(next) => {
              if (typeof next === "string") onChange(next);
            }}
          >
            {choices.map((option, index) => (
              <Fragment key={option.value}>
                <MenuRadioItem value={option.value} closeOnClick>
                  <span className="flex min-w-0 items-center gap-2">
                    <ScopeOptionLabel option={option} />
                    <MenuRadioItemIndicator />
                  </span>
                </MenuRadioItem>
                {index === 0 && allOption ? <MenuSeparator /> : null}
              </Fragment>
            ))}
          </MenuRadioGroup>
        </div>
      </MenuPopup>
    </Menu>
  );
}

function EnvironmentCheckboxMenu({
  options,
  selected,
  all,
  label,
  icon,
  disabled,
  onChange,
}: {
  options: ScopeOption[];
  selected: readonly string[];
  all: boolean;
  label: string;
  icon: ReactNode;
  disabled: boolean;
  onChange: (next: readonly string[] | null) => void;
}) {
  const [draft, setDraft] = useState<ReadonlySet<string> | null>(null);
  const [query, setQuery] = useState("");
  const checked = draft ?? new Set(selected);
  const needle = query.trim().toLowerCase();
  const visible = options.filter((option) =>
    `${option.label} ${option.secondary ?? ""} ${option.value}`.toLowerCase().includes(needle),
  );
  const checkedIds = options.filter(({ value }) => checked.has(value)).map(({ value }) => value);
  const changed = checkedIds.length !== selected.length || selected.some((id) => !checked.has(id));

  return (
    <Menu
      onOpenChange={(open) => {
        if (!open) {
          setDraft(null);
          setQuery("");
        }
      }}
    >
      <MenuTrigger
        aria-label={`Environment scope: ${label}`}
        render={<Button variant="outline" size="sm" />}
        className="min-w-0 max-w-72"
        disabled={disabled}
      >
        <ScopeTriggerLabel icon={icon} label={label} />
      </MenuTrigger>
      <MenuPopup align="start">
        <div className="w-72 max-w-full">
          {options.length > 6 && (
            <MenuSearchInput
              autoFocus
              aria-label="Search environments"
              placeholder="Search environments"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          )}
          <MenuItem closeOnClick onClick={() => onChange(null)}>
            <LayersIcon aria-hidden className="size-3.5 shrink-0" />
            <span className="flex-1">All environments</span>
            {all && draft === null && <CheckIcon aria-hidden className="size-3.5" />}
          </MenuItem>
          <MenuSeparator />
          {visible.map((option) => (
            <MenuCheckboxItem
              key={option.value}
              checked={checked.has(option.value)}
              closeOnClick={false}
              onCheckedChange={(value) => {
                const next = new Set(checked);
                if (value) next.add(option.value);
                else next.delete(option.value);
                setDraft(next);
              }}
            >
              <span className="flex min-w-0 items-center gap-2">
                <ScopeOptionLabel option={option} />
              </span>
            </MenuCheckboxItem>
          ))}
          {visible.length === 0 && <MenuItem disabled>No matching environments</MenuItem>}
          <MenuSeparator />
          <MenuItem
            closeOnClick
            disabled={!changed || checkedIds.length === 0}
            onClick={() => onChange(checkedIds.length === options.length ? null : checkedIds)}
          >
            Apply
          </MenuItem>
        </div>
      </MenuPopup>
    </Menu>
  );
}

function EnvironmentScopeMenu({
  value,
  groups,
  environments,
  onChange,
  singleEnvironment,
  disabled = false,
}: SettingsScopeMenuProps) {
  const messages = useMessages();
  const gt = useGT();
  const resolved = resolveSettingsScope(value, groups, environments, messages);
  const environmentValue = environmentAxisValue(
    value,
    resolved.kind === "checkout" ? resolved.environmentId : null,
  );
  const project = groups.find((group) => group.projectKey === value.project);
  const memberEnvironmentIds = project
    ? new Set(project.memberProjects.map((member) => member.environmentId))
    : null;
  const options = memberEnvironmentIds
    ? environments.filter((environment) => memberEnvironmentIds.has(environment.environmentId))
    : environments;
  const all = environmentValue === ALL_ENVIRONMENTS_VALUE && value.machines === undefined;
  const selectedIds =
    environmentValue !== ALL_ENVIRONMENTS_VALUE ? [environmentValue] : value.machines;
  const selectedOptions =
    selectedIds === undefined
      ? options
      : options.filter(({ environmentId }) => selectedIds.includes(environmentId));
  const selected =
    environmentValue !== ALL_ENVIRONMENTS_VALUE
      ? environments.find(({ environmentId }) => environmentId === environmentValue)
      : !all && selectedOptions.length === 1
        ? selectedOptions[0]
        : undefined;
  const icon = selected ? (
    <EnvironmentMachineIcon
      aria-hidden
      kind={resolveEnvironmentMachineKind(selected.serverConfig)}
      className="size-3.5 shrink-0"
    />
  ) : null;
  const label = selected
    ? settingsScopeEnvironmentLabel(selected, environments)
    : all
      ? singleEnvironment
        ? gt("No environments")
        : gt("All environments")
      : selectedOptions.length > 1
        ? `${selectedOptions.length} environments`
        : gt("Unavailable environment");
  const choices = options.map((environment) => {
    const { primary, secondary } = settingsScopeEnvironmentLabels(environment, environments);
    return {
      value: environment.environmentId,
      label: primary,
      secondary:
        environments.length <= 1 ? "" : secondary || settingsScopeEnvironmentAddress(environment),
      icon: (
        <EnvironmentMachineIcon
          aria-hidden
          kind={resolveEnvironmentMachineKind(environment.serverConfig)}
          className="size-3.5 shrink-0"
        />
      ),
      offline: environment.connection.phase !== "connected",
    };
  });
  if (!singleEnvironment) {
    return (
      <EnvironmentCheckboxMenu
        options={choices}
        selected={selectedOptions.map(({ environmentId }) => environmentId)}
        all={all}
        label={label}
        icon={icon}
        disabled={disabled}
        onChange={(ids) =>
          onChange(
            ids === null
              ? selectEnvironmentAxis(value, ALL_ENVIRONMENTS_VALUE)
              : selectEnvironmentSubset(value, ids),
          )
        }
      />
    );
  }
  return (
    <ScopeMenu
      ariaLabel={gt("Environment scope")}
      icon={icon}
      label={label}
      value={environmentValue}
      onChange={(next) => onChange(selectEnvironmentAxis(value, next))}
      searchLabel={gt("Search environments")}
      allOption={null}
      options={choices}
    />
  );
}

function CheckoutScopeMenu({ value, groups, onChange }: SettingsScopeMenuProps) {
  const gt = useGT();
  const group = groups.find((candidate) => candidate.projectKey === value.project);
  const checkouts = group ? settingsScopeCheckoutChoices(group, value) : [];
  if (checkouts.length === 0) return null;
  const selected = checkouts.find((member) => member.physicalProjectKey === value.checkout);
  return (
    <ScopeMenu
      ariaLabel={gt("Checkout scope")}
      icon={<FolderIcon aria-hidden className="size-3.5 shrink-0" />}
      label={
        selected
          ? settingsScopeCheckoutLabel(selected, checkouts)
          : value.checkout
            ? gt("Unavailable checkout")
            : gt("All checkouts")
      }
      value={value.checkout ?? ALL_CHECKOUTS_VALUE}
      onChange={(next) =>
        onChange(
          selectCheckoutAxis(
            value,
            checkouts.find((member) => member.physicalProjectKey === next) ?? null,
          ),
        )
      }
      searchLabel={gt("Search checkouts")}
      allOption={{ value: ALL_CHECKOUTS_VALUE, label: gt("All checkouts") }}
      options={checkouts.map((member) => ({
        value: member.physicalProjectKey,
        label: fileDisplayName(member.workspaceRoot),
        secondary: member.workspaceRoot,
      }))}
    />
  );
}

function ProjectScopeMenu({ value, groups, environments, onChange }: SettingsScopeMenuProps) {
  const gt = useGT();
  const selected = groups.find((group) => group.projectKey === value.project);
  const projects = projectScopeMenuGroups(groups, value).map((group) => ({
    group,
    machines: settingsScopeProjectMachines(group, environments, true).join(", "),
  }));
  return (
    <ScopeMenu
      ariaLabel={gt("Project scope")}
      icon={selected ? <ProjectFavicon project={selected} className="size-3.5 shrink-0" /> : null}
      label={
        selected?.displayName ?? (value.project ? gt("Unavailable project") : gt("All projects"))
      }
      value={projectAxisValue(value)}
      onChange={(next) => onChange(selectProjectAxis(value, next))}
      searchLabel={gt("Search projects")}
      allOption={{ value: ALL_PROJECTS_VALUE, label: gt("All projects") }}
      options={projects.map(({ group, machines }) => {
        const sameName = projects.filter(
          (other) =>
            other.group.projectKey !== group.projectKey &&
            other.group.displayName === group.displayName,
        );
        const location =
          sameName.length === 0
            ? environments.length > 1
              ? group.workspaceRoot
              : ""
            : sameName.some((other) => other.machines === machines)
              ? `${machines} · ${group.workspaceRoot}`
              : machines;
        return {
          value: group.projectKey,
          label: group.displayName,
          secondary: group.archived
            ? [gt("Archived", { $context: "project state" }), location].filter(Boolean).join(" · ")
            : location,
          icon: <ProjectFavicon project={group} className="size-3.5 shrink-0" />,
        };
      })}
    />
  );
}
