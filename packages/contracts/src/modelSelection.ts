import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderOptionSelections } from "./model.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const ModelSelectionWire = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(ProviderOptionSelections),
});

const ModelSelectionSource = Schema.Struct({
  provider: Schema.optional(Schema.Unknown),
  instanceId: Schema.optional(Schema.Unknown),
  model: Schema.Unknown,
  options: Schema.optional(Schema.Unknown),
});

const followLatest = { followLatest: Schema.optionalKey(Schema.Boolean) };
const DefaultModelSelectionSource = Schema.Struct({
  ...ModelSelectionSource.fields,
  ...followLatest,
});
const DefaultModelSelectionWire = Schema.Struct({ ...ModelSelectionWire.fields, ...followLatest });

const normalizeInstance = SchemaTransformation.transform<
  typeof DefaultModelSelectionWire.Encoded,
  typeof DefaultModelSelectionSource.Type
>({
  decode: ({ provider, instanceId, options, ...fields }) =>
    ({
      ...fields,
      ...(options === undefined ? {} : { options }),
      instanceId: instanceId === undefined ? provider : instanceId,
    }) as typeof DefaultModelSelectionWire.Encoded,
  encode: (selection) => selection,
});

export const ModelSelection = ModelSelectionSource.pipe(
  Schema.decodeTo(ModelSelectionWire, normalizeInstance),
);
export type ModelSelection = typeof ModelSelection.Type;

export const DefaultModelSelection = DefaultModelSelectionSource.pipe(
  Schema.decodeTo(DefaultModelSelectionWire, normalizeInstance),
);
export type DefaultModelSelection = typeof DefaultModelSelection.Type;
