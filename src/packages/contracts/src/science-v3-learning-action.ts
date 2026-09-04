import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { MATH_DERIVATION_ARTIFACT_SCHEMA } from "./science-v3-learning.js";

const mathDerivationContent = Type.Object({
  schema: Type.Literal(MATH_DERIVATION_ARTIFACT_SCHEMA),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  steps: Type.Array(Type.Object({
    expression: Type.String({ minLength: 1, maxLength: 2000 }),
    note: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 16 }),
}, { additionalProperties: false });

const requestCutVariant = Type.Object({
  action: Type.Literal("request_cut"),
  reason: Type.Union([
    Type.Literal("completed"), Type.Literal("student_switch"), Type.Literal("skipped"),
    Type.Literal("system_policy"), Type.Literal("abandoned"),
  ]),
  next_natural_language_request: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
}, { additionalProperties: false });

const reviseSelectionVariant = Type.Object({
  action: Type.Literal("revise_selection_intent"),
  natural_language_request: Type.String({ minLength: 1, maxLength: 4000 }),
}, { additionalProperties: false });

const presentArtifactVariant = Type.Object({
  action: Type.Literal("present_validated_artifact"),
  artifact_schema: Type.Literal(MATH_DERIVATION_ARTIFACT_SCHEMA),
  summary: Type.String({ minLength: 1, maxLength: 1000 }),
  content: mathDerivationContent,
}, { additionalProperties: false });

export type BoundedLearningAction =
  | Static<typeof requestCutVariant>
  | Static<typeof reviseSelectionVariant>
  | Static<typeof presentArtifactVariant>;

/** Provider-compatible object root with strict discriminated semantic variants. */
export const LEARNING_ACTION_TOOL_PARAMETERS = Type.Object({
  action: Type.Union([
    Type.Literal("request_cut"),
    Type.Literal("revise_selection_intent"),
    Type.Literal("present_validated_artifact"),
  ]),
  reason: Type.Optional(Type.Union([
    Type.Literal("completed"), Type.Literal("student_switch"), Type.Literal("skipped"),
    Type.Literal("system_policy"), Type.Literal("abandoned"),
  ])),
  next_natural_language_request: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
  natural_language_request: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
  artifact_schema: Type.Optional(Type.Literal(MATH_DERIVATION_ARTIFACT_SCHEMA)),
  summary: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  content: Type.Optional(mathDerivationContent),
}, {
  additionalProperties: false,
  anyOf: [requestCutVariant, reviseSelectionVariant, presentArtifactVariant],
});

export function parseBoundedLearningAction(value: unknown): BoundedLearningAction {
  if (!Value.Check(LEARNING_ACTION_TOOL_PARAMETERS, value)) {
    throw new Error("learning_action is invalid");
  }
  return Value.Clone(value) as BoundedLearningAction;
}
