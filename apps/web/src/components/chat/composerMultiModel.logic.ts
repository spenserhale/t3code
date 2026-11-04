import type { ModelSelection } from "@t3tools/contracts";

/**
 * What a multi-model draft sends. The primary model runs with the options the composer's effort
 * control shows now, so the entry for it follows that control rather than the options it had when
 * it was added; every other entry is sent as it was picked.
 */
export function resolveFanOutSelections(
  selections: ReadonlyArray<ModelSelection>,
  primary: ModelSelection,
): ReadonlyArray<ModelSelection> {
  return selections.map((selection) =>
    selection.instanceId === primary.instanceId && selection.model === primary.model
      ? primary
      : selection,
  );
}
