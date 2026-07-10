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

export const ActionSchema = z.discriminatedUnion("type", [
  SetFilterAction,
  SetRangeFilterAction,
  SetParameterAction,
  SwitchSheetAction,
  WaitAction,
  AnswerAction,
  FailAction,
]);

// Generous cap, not a strict sentence-count check - the "<=2 sentences" rule
// is enforced via the prompt, not technically here.
export const StepResponseSchema = z.object({
  thought: z.string().min(1).max(600),
  action: ActionSchema,
});
