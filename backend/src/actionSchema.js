// Strict JSON contract the VLM must produce each step (AGENT_PLAN.md 6.2).
import { z } from "zod";

const SetFilterAction = z.object({
  type: z.literal("set_filter"),
  target_id: z.string().min(1),
  values: z.array(z.string()).min(1),
});

const SetRangeFilterAction = z
  .object({
    type: z.literal("set_range_filter"),
    target_id: z.string().min(1),
    min: z.coerce.number().optional(),
    max: z.coerce.number().optional(),
  })
  .refine((a) => a.min !== undefined || a.max !== undefined, {
    message: "set_range_filter requires at least one of min/max",
  });

const SetParameterAction = z.object({
  type: z.literal("set_parameter"),
  target_id: z.string().min(1),
  value: z.union([z.string(), z.number()]),
});

const SwitchSheetAction = z.object({
  type: z.literal("switch_sheet"),
  target_id: z.string().min(1),
});

const WaitAction = z.object({
  type: z.literal("wait"),
});

const AnswerAction = z.object({
  type: z.literal("answer"),
  answer: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
});

const FailAction = z.object({
  type: z.literal("fail"),
  reason: z.string().optional(),
});

const ClickAction = z.object({
  type: z.literal("click"),
  nx: z.number().min(0).max(1),
  ny: z.number().min(0).max(1),
  target: z.string().optional(),
});

// Vertical-only, and deliberately WITHOUT a magnitude field: the actuator
// supplies a fixed notch from config. nx/ny survive this model's habit of
// writing the right digits at the wrong scale because the [0,1] range check
// catches it (see rescalePair in vlmClient.js); a raw pixel dy would have no
// such check, and 3 vs 300 is the difference between nothing moving and
// jumping clean past the target. Scrolling further is another step.
const ScrollAction = z.object({
  type: z.literal("scroll"),
  nx: z.number().min(0).max(1),
  ny: z.number().min(0).max(1),
  direction: z.enum(["down", "up"]),
  target: z.string().optional(),
});

export const ActionSchema = z.discriminatedUnion("type", [
  SetFilterAction,
  SetRangeFilterAction,
  SetParameterAction,
  SwitchSheetAction,
  ClickAction,
  ScrollAction,
  WaitAction,
  AnswerAction,
  FailAction,
]);

// Generous cap, not a strict sentence-count check - the "<=2 sentences" rule
// is enforced via the prompt, not technically here.
export const StepResponseSchema = z.object({
  // Optional AND nullable on purpose. A required field would turn a cosmetic
  // omission into an invalid_json step, and three of those in a row end the
  // run - see orchestrator.js's invalidCount. The prompt asks for it every
  // turn; the schema must never punish a model that forgets.
  discovery: z.union([z.string(), z.null()]).optional(),
  thought: z.string().min(1).max(600),
  action: ActionSchema,
});
