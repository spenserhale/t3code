import type { JiraProject, JiraSearchPreset, JiraStatusCategoryFilter } from "@t3tools/contracts";
import { ChevronDownIcon, SearchIcon } from "lucide-react";
import { useState } from "react";

import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuCheckboxItem, MenuPopup, MenuSearchInput, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

export interface JiraFilters {
  readonly preset: JiraSearchPreset;
  readonly jql: string;
  readonly projects: ReadonlyArray<string>;
  readonly status: ReadonlyArray<JiraStatusCategoryFilter>;
  readonly q: string;
}

const PRESET_LABELS: Record<JiraSearchPreset, string> = {
  assigned: "Assigned to me",
  sprint: "Current sprint",
  reported: "Reported by me",
  recent: "Recently updated",
  custom: "JQL query",
};

const STATUS_OPTIONS: ReadonlyArray<{ value: JiraStatusCategoryFilter; label: string }> = [
  { value: "todo", label: "To do" },
  { value: "in-progress", label: "In progress" },
  { value: "done", label: "Done" },
];

function ProjectsMenu({
  projects,
  selected,
  onChange,
}: {
  projects: ReadonlyArray<JiraProject>;
  selected: ReadonlyArray<string>;
  onChange: (keys: ReadonlyArray<string>) => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = projects.filter(
    (project) =>
      needle.length === 0 ||
      project.key.toLowerCase().includes(needle) ||
      project.name.toLowerCase().includes(needle),
  );
  return (
    <Menu onOpenChange={(open) => (open ? undefined : setQuery(""))}>
      <MenuTrigger render={<Button variant="outline" size="default" />}>
        <span>
          {selected.length === 0
            ? "All projects"
            : selected.length === 1
              ? selected[0]
              : `${selected.length} projects`}
        </span>
        <ChevronDownIcon aria-hidden className="size-3 text-muted-foreground/70" />
      </MenuTrigger>
      <MenuPopup align="start" className="max-h-80">
        {projects.length > 8 ? (
          <MenuSearchInput
            aria-label="Filter projects"
            placeholder="Filter projects"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        ) : null}
        {shown.map((project) => (
          <MenuCheckboxItem
            key={project.key}
            checked={selected.includes(project.key)}
            onCheckedChange={(checked) =>
              onChange(
                checked
                  ? [...selected, project.key]
                  : selected.filter((key) => key !== project.key),
              )
            }
          >
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="font-mono text-xs">{project.key}</span>
              <span className="truncate text-muted-foreground">{project.name}</span>
            </span>
          </MenuCheckboxItem>
        ))}
        {shown.length === 0 ? (
          <p className="px-2 py-1.5 text-muted-foreground text-xs">No projects match.</p>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

export function JiraFilterBar({
  filters,
  projects,
  busy,
  onChange,
}: {
  filters: JiraFilters;
  projects: ReadonlyArray<JiraProject>;
  busy: boolean;
  onChange: (patch: Partial<JiraFilters>) => void;
}) {
  const [textDraft, setTextDraft] = useState<string | null>(null);
  const [jqlDraft, setJqlDraft] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <InputGroup className="min-w-0 basis-full sm:basis-0 sm:flex-1 **:[input]:h-9 sm:**:[input]:h-8">
          <InputGroupAddon>
            {busy ? <Spinner aria-hidden /> : <SearchIcon aria-hidden />}
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            value={textDraft ?? filters.q}
            onChange={(event) => setTextDraft(event.currentTarget.value)}
            onBlur={() => {
              if (textDraft !== null && textDraft !== filters.q) onChange({ q: textDraft });
              setTextDraft(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                onChange({ q: event.currentTarget.value });
                setTextDraft(null);
              }
            }}
            placeholder="Search issues, or paste a key like PROJ-123"
            aria-label="Search issues"
          />
        </InputGroup>
        <Select
          value={filters.preset}
          onValueChange={(value) => onChange({ preset: value as JiraSearchPreset })}
        >
          <SelectTrigger size="default" className="w-44" aria-label="Issue view">
            <SelectValue>
              {(value: JiraSearchPreset | null) => (value === null ? "" : PRESET_LABELS[value])}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {(Object.keys(PRESET_LABELS) as JiraSearchPreset[]).map((preset) => (
              <SelectItem key={preset} hideIndicator value={preset}>
                {PRESET_LABELS[preset]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          multiple
          aria-label="Status category"
          value={[...filters.status]}
          onValueChange={(next) =>
            onChange({
              status: STATUS_OPTIONS.filter((option) => next.includes(option.value)).map(
                (option) => option.value,
              ),
            })
          }
        >
          {STATUS_OPTIONS.map((option) => (
            <Toggle key={option.value} value={option.value}>
              {option.label}
            </Toggle>
          ))}
        </ToggleGroup>
        {projects.length > 0 ? (
          <ProjectsMenu
            projects={projects}
            selected={filters.projects}
            onChange={(keys) => onChange({ projects: keys })}
          />
        ) : null}
      </div>
      {filters.preset === "custom" ? (
        <Input
          value={jqlDraft ?? filters.jql}
          onChange={(event) => setJqlDraft(event.currentTarget.value)}
          onBlur={() => {
            if (jqlDraft !== null && jqlDraft !== filters.jql) onChange({ jql: jqlDraft });
            setJqlDraft(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              onChange({ jql: event.currentTarget.value });
              setJqlDraft(null);
            }
          }}
          spellCheck={false}
          autoComplete="off"
          placeholder="project = PROJ AND status != Done ORDER BY updated DESC"
          aria-label="JQL query"
        />
      ) : null}
    </div>
  );
}
