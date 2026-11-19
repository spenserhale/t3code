import {
  effortChoices,
  effortSliderStepIdentity,
  shownEffort,
  selectedEffort,
  stableListKeys,
} from "@t3tools/client-runtime/effort-slider";
import {
  type EnvironmentId,
  type ProjectId,
  type ModelSelection,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Equal from "effect/Equal";
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { isProviderInstancePickerReady, type ProviderInstanceEntry } from "../../providerInstances";
import { ModelPickerContent } from "../chat/ModelPickerContent";
import { getDisplayModelName, type ModelEsque } from "../chat/providerIconUtils";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../ui/dialog";
import {
  effortSliderAddBlockReason,
  effortSliderEditBlockReason,
} from "./modelShortcutsSettings.logic";

type Props = {
  title: string;
  scopeLabel: string;
  mixed: boolean;
  steps: readonly ModelSelection[];
  initialSelection: ModelSelection | null;
  entries: readonly ProviderInstanceEntry[];
  models: ReadonlyMap<ProviderInstanceId, readonly ModelEsque[]>;
  environmentId: EnvironmentId | null;
  projectId: ProjectId | null;
  disabledReason: (instanceId: ProviderInstanceId, model: string) => string | null;
  onSave: (steps: readonly ModelSelection[], onFailed: () => void) => void;
  onClose: () => void;
};

export function EffortSliderEditor(props: Props) {
  const searchRef = useRef<HTMLInputElement>(null);
  const effortRef = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<readonly ModelSelection[] | null>(null);
  const [base, setBase] = useState(props.steps);
  // Reconcile both acknowledgements and changes made by another settings client.
  if (!Equal.equals(base, props.steps)) {
    setBase(props.steps);
    setPending(null);
  }
  const steps = pending ?? props.steps;
  const entryOf = (step: ModelSelection) =>
    props.entries.find((entry) => entry.instanceId === step.instanceId);
  const modelOf = (step: ModelSelection) =>
    entryOf(step)?.models.find((model) => model.slug === step.model);
  const optionOf = (step: ModelSelection) =>
    props.models.get(step.instanceId)?.find((option) => option.slug === step.model);
  const nameOf = (step: ModelSelection) => {
    const option = optionOf(step);
    return option ? getDisplayModelName(option) : step.model;
  };
  const effortOf = (step: ModelSelection) =>
    shownEffort(modelOf(step), step)?.value ??
    (step.options?.length ? JSON.stringify(step.options) : null);
  const identity = (step: ModelSelection) => effortSliderStepIdentity(step, effortOf(step));
  const keys = stableListKeys(steps.map(identity));
  const firstEntry = props.entries.find(
    (entry) =>
      isProviderInstancePickerReady(entry) &&
      props.models.get(entry.instanceId)?.some((option) => !option.isUnavailable),
  );
  const firstModel =
    firstEntry && props.models.get(firstEntry.instanceId)?.find((option) => !option.isUnavailable);
  const initial =
    props.initialSelection && entryOf(props.initialSelection) ? props.initialSelection : null;
  const match = initial && steps.find((step) => identity(step) === identity(initial));
  const [anchorKey, setAnchorKey] = useState(
    () => keys[match ? steps.indexOf(match) : steps.length - 1],
  );
  const selectedIndex = keys.indexOf(anchorKey ?? "");
  const index = selectedIndex < 0 ? steps.length - 1 : selectedIndex;
  const [chosenDraft, setDraft] = useState<ModelSelection | null>(
    () => initial ?? steps[index] ?? null,
  );
  const draft =
    chosenDraft ??
    (firstEntry && firstModel
      ? createModelSelection(firstEntry.instanceId, firstModel.slug)
      : null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [gap, setGap] = useState<number | null>(null);
  const levels = draft ? effortChoices(modelOf(draft)) : null;
  const effort = draft && shownEffort(modelOf(draft), draft);
  const draftEntry = draft && entryOf(draft);
  const option = draft && optionOf(draft);
  const unavailable =
    !draft ||
    !draftEntry ||
    !isProviderInstancePickerReady(draftEntry) ||
    !option ||
    option.isUnavailable
      ? "Choose an available model."
      : props.disabledReason(draft.instanceId, draft.model);
  const addReason = unavailable ?? (draft && effortSliderAddBlockReason(steps, draft, effortOf));
  const canUpdate =
    draft &&
    steps[index] &&
    identity(draft) !== identity(steps[index]!) &&
    !unavailable &&
    !effortSliderEditBlockReason(steps, index, draft, effortOf);
  const chooseStep = (next: readonly ModelSelection[], position: number) => {
    setAnchorKey(stableListKeys(next.map(identity))[position]);
    setDraft(next[position] ?? draft);
  };
  const save = (next: readonly ModelSelection[], position: number) => {
    if (pending || Equal.equals(next, steps)) return;
    setPending(next);
    chooseStep(next, position);
    props.onSave(next, () => setPending(null));
  };
  const insert = (position: number) => {
    if (!draft || addReason) return;
    const level = selectedEffort(modelOf(draft), draft.options);
    const step =
      level && !draft.options?.length
        ? createModelSelection(draft.instanceId, draft.model, [
            { id: level.descriptorId, value: level.value },
          ])
        : draft;
    save(steps.toSpliced(position, 0, step), position);
  };
  const move = (from: number, to: number) => {
    if (from === to || !steps[from] || !steps[to]) return;
    save(steps.toSpliced(from, 1).toSpliced(to, 0, steps[from]!), to);
  };
  const focusEffort = () => {
    const selected = effortRef.current?.querySelector<HTMLButtonElement>(
      'button[aria-pressed="true"]',
    );
    (selected ?? effortRef.current?.querySelector("button"))?.focus();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup
        className="max-w-2xl overflow-auto"
        initialFocus={searchRef}
        showCloseButton={false}
      >
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <div>
            <DialogTitle>{props.title}</DialogTitle>
            <DialogDescription>{props.scopeLabel}</DialogDescription>
          </div>
          <Button size="sm" variant="outline" onClick={props.onClose}>
            Done
          </Button>
        </div>
        {props.mixed && (
          <p className="px-4 pt-2 text-xs text-muted-foreground">
            Saving replaces the slider on each selected target.
          </p>
        )}
        {steps.length > 0 && (
          <ol
            aria-label="Slider order"
            className="flex shrink-0 gap-1 overflow-x-auto border-b p-2"
          >
            {steps.map((step, i) => {
              const label = [nameOf(step), shownEffort(modelOf(step), step)?.label]
                .filter(Boolean)
                .join(" · ");
              return (
                <li
                  key={keys[i]}
                  draggable={!pending}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", label);
                    setDragKey(keys[i]!);
                  }}
                  onDragEnd={() => {
                    setDragKey(null);
                    setGap(null);
                  }}
                  onDragOver={(event) => {
                    if (!dragKey) return;
                    event.preventDefault();
                    const rect = event.currentTarget.getBoundingClientRect();
                    setGap(i + Number(event.clientX >= rect.left + rect.width / 2));
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const from = keys.indexOf(dragKey ?? "");
                    const rect = event.currentTarget.getBoundingClientRect();
                    const target = i + Number(event.clientX >= rect.left + rect.width / 2);
                    if (from >= 0) move(from, target - Number(target > from));
                    setDragKey(null);
                    setGap(null);
                  }}
                  className={cn(
                    "group relative flex min-w-20 flex-1 flex-col rounded-md border border-transparent text-center",
                    i === index && "border-primary/40 bg-accent",
                    gap === i && "border-l-primary",
                    gap === steps.length && i === steps.length - 1 && "border-r-primary",
                  )}
                >
                  <button
                    type="button"
                    aria-label={label}
                    aria-pressed={i === index}
                    onClick={() => chooseStep(steps, i)}
                    className="relative flex cursor-grab flex-col items-center px-1 pt-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "absolute top-3.5 h-px bg-border",
                        i === 0 ? "left-1/2" : "-left-1",
                        i === steps.length - 1 ? "right-1/2" : "-right-1",
                      )}
                    />
                    <span
                      aria-hidden="true"
                      className={cn(
                        "relative my-0.5 mb-1.5 size-2 rounded-full border border-muted-foreground bg-popover",
                        i === index && "border-primary bg-primary ring-2 ring-primary/20",
                      )}
                    />
                    <span className="max-w-full truncate text-xs font-medium">{nameOf(step)}</span>
                    <span className="text-xs text-muted-foreground">
                      {shownEffort(modelOf(step), step)?.label ?? "Default"}
                    </span>
                  </button>
                  <div
                    className={cn(
                      "flex justify-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
                      i === index && "[@media(hover:none)]:opacity-100",
                    )}
                  >
                    <Button
                      size="icon-micro"
                      variant="ghost"
                      aria-label={`Move ${label} left`}
                      disabled={!!pending || i === 0}
                      onClick={() => move(i, i - 1)}
                    >
                      <ArrowLeftIcon />
                    </Button>
                    <Button
                      size="icon-micro"
                      variant="ghost"
                      aria-label={`Move ${label} right`}
                      disabled={!!pending || i === steps.length - 1}
                      onClick={() => move(i, i + 1)}
                    >
                      <ArrowRightIcon />
                    </Button>
                    <Button
                      size="icon-micro"
                      variant="ghost"
                      aria-label={`Remove ${label}`}
                      disabled={!!pending}
                      onClick={() => save(steps.toSpliced(i, 1), Math.min(i, steps.length - 2))}
                    >
                      <XIcon />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        {!draft && (
          <p className="p-4 text-sm text-muted-foreground">No models available in this scope.</p>
        )}
        {draft && (
          <ModelPickerContent
            key={draft.instanceId}
            environmentId={props.environmentId}
            projectId={props.projectId}
            activeInstanceId={draft.instanceId}
            model={draft.model}
            preferActiveProvider
            lockedProvider={null}
            instanceEntries={props.entries}
            modelOptionsByInstance={props.models}
            terminalOpen={false}
            searchInputRef={searchRef}
            onRequestClose={props.onClose}
            onFocusEffort={focusEffort}
            getModelDisabledReason={props.disabledReason}
            onInstanceModelChange={(instanceId, model) =>
              setDraft(createModelSelection(instanceId, model))
            }
            renderDockedLayout={(modelList) => (
              <div className="flex h-72 shrink-0 border-b max-sm:h-auto max-sm:flex-col">
                {modelList}
                <div
                  ref={effortRef}
                  className="min-w-0 flex-1 overflow-y-auto border-l p-2 max-sm:max-h-40 max-sm:border-t"
                >
                  <div className="mb-1 flex flex-wrap justify-between gap-1 px-2 py-1 text-xs text-muted-foreground">
                    <span>Effort</span>
                    <span>{nameOf(draft)}</span>
                  </div>
                  {levels?.choices.map((choice) => {
                    const next = createModelSelection(draft.instanceId, draft.model, [
                      ...(draft.options ?? []).filter(
                        (option) => option.id !== levels.descriptorId,
                      ),
                      { id: levels.descriptorId, value: choice.id },
                    ]);
                    const used = steps.some((step) => identity(step) === identity(next));
                    return (
                      <button
                        key={choice.id}
                        type="button"
                        aria-pressed={effort?.value === choice.id}
                        onClick={() => setDraft(next)}
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted aria-pressed:bg-accent"
                      >
                        {choice.label}
                        {effort?.value === choice.id && <CheckIcon className="size-3" />}
                        {used && (
                          <span className="ml-auto text-xs text-muted-foreground">On slider</span>
                        )}
                      </button>
                    );
                  }) ?? <p className="px-2 text-sm text-muted-foreground">No effort levels</p>}
                </div>
              </div>
            )}
          />
        )}
        <div className="flex flex-wrap items-center justify-end gap-2 p-3">
          <p role="status" className="mr-auto text-xs text-muted-foreground">
            {pending ? "Saving…" : addReason}
          </p>
          {canUpdate && (
            <Button
              size="sm"
              variant="ghost"
              disabled={!!pending}
              onClick={() => save(steps.toSpliced(index, 1, draft!), index)}
            >
              Update selected step
            </Button>
          )}
          <div className="flex flex-wrap gap-2">
            {steps.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                disabled={!!addReason || !!pending}
                onClick={() => insert(index)}
              >
                Add step before
              </Button>
            )}
            <Button size="sm" disabled={!!addReason || !!pending} onClick={() => insert(index + 1)}>
              {steps.length ? "Add step after" : "Add first step"}
            </Button>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
