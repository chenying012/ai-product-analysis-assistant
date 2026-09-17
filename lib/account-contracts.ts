import { z } from "zod";

/**
 * Credentials and profile input. The password floor is length-based rather than a composition rule
 * because arbitrary character classes push people toward predictable substitutions.
 */
export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(10).max(200),
  inviteCode: z.string().trim().max(200).optional(),
}).strict();

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(200),
}).strict();

export const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  before: z.string().trim().max(40).optional(),
}).strict();

/** Actions recorded in the audit trail. Kept as a closed set so queries stay predictable. */
export const activityActionSchema = z.enum([
  "register", "login", "login_failed", "logout", "analyze", "credit_grant",
]);

export const activityOutcomeSchema = z.enum(["success", "failed"]);

/** Reasons a balance changed. Every row in the ledger carries one. */
export const creditReasonSchema = z.enum(["signup_bonus", "api_call", "refund", "admin_adjust"]);

export const publicUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  credits: z.number().int(),
  createdAt: z.string(),
});

export const activityRecordSchema = z.object({
  id: z.string(),
  action: activityActionSchema,
  target: z.string().nullable(),
  outcome: activityOutcomeSchema,
  errorCode: z.string().nullable(),
  creditsDelta: z.number().int(),
  createdAt: z.string(),
});

export const creditRecordSchema = z.object({
  id: z.string(),
  delta: z.number().int(),
  balanceAfter: z.number().int(),
  reason: creditReasonSchema,
  refId: z.string().nullable(),
  createdAt: z.string(),
});

export const analysisSummarySchema = z.object({
  id: z.string(),
  asin: z.string(),
  marketplace: z.string(),
  title: z.string(),
  succeeded: z.boolean(),
  createdAt: z.string(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type HistoryQuery = z.infer<typeof historyQuerySchema>;
export type ActivityAction = z.infer<typeof activityActionSchema>;
export type ActivityOutcome = z.infer<typeof activityOutcomeSchema>;
export type CreditReason = z.infer<typeof creditReasonSchema>;
export type PublicUser = z.infer<typeof publicUserSchema>;
export type ActivityRecord = z.infer<typeof activityRecordSchema>;
export type CreditRecord = z.infer<typeof creditRecordSchema>;
export type AnalysisSummary = z.infer<typeof analysisSummarySchema>;
