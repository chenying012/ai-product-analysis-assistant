import { z } from "zod";

export const requestSchema = z.object({ url: z.string().trim().min(1).max(2048) }).strict();

export const evidenceSchema = z.object({
  id: z.string(),
  label: z.string(),
  value: z.string(),
});

export const productSchema = z.object({
  url: z.string().url(),
  asin: z.string(),
  marketplace: z.string(),
  title: z.string(),
  brand: z.string().nullable(),
  category: z.string().nullable(),
  price: z.object({ display: z.string(), currency: z.string().nullable() }).nullable(),
  priceUnavailableReason: z.enum(["region_restricted", "out_of_stock", "not_found"]).nullable(),
  /** True when an amazon.com price was localised to the crawler's region instead of shown in USD. */
  priceLocalised: z.boolean(),
  variant: z.object({ name: z.string().nullable(), total: z.number().int().min(2) }).nullable(),
  imageUrl: z.string().url().nullable(),
  /** Attributes read from the product photo by a vision model. Never mixed into page text facts. */
  imageInsight: z.object({ observations: z.array(z.string()), model: z.string() }).nullable(),
  features: z.array(z.string()),
  specifications: z.array(z.object({ name: z.string(), value: z.string() })),
  description: z.string().nullable(),
  evidence: z.array(evidenceSchema),
  source: z.object({ provider: z.enum(["direct", "firecrawl", "relay"]), fetchedAt: z.string() }),
  warnings: z.array(z.string()),
});

const pointSchema = z.object({
  title: z.string().trim().min(1).max(40),
  description: z.string().trim().min(1).max(200),
  evidenceIds: z.array(z.string()).min(1).max(4),
}).strict();

export const contentSchema = z.object({
  audiences: z.array(pointSchema).min(1).max(3),
  scenarios: z.array(pointSchema).min(1).max(3),
  painPoints: z.array(pointSchema).min(1).max(3),
  sellingPoints: z.array(pointSchema).min(1).max(4),
  script: z.object({
    hook: z.string().trim().min(1).max(80),
    body: z.string().trim().min(1).max(600),
    evidenceIds: z.array(z.string()).min(1).max(8),
  }).strict(),
}).strict();

export const qualityIssueSchema = z.object({
  code: z.enum(["absolute_claim", "guaranteed_effect", "unsupported_number", "price_claim", "health_claim", "unsupported_comparison", "purchase_pressure", "hook_too_slow", "dropped_condition", "weak_citation"]),
  severity: z.enum(["blocking", "advisory"]),
  field: z.string(),
  excerpt: z.string(),
  message: z.string(),
});

export const qualitySchema = z.object({
  passed: z.boolean(),
  issues: z.array(qualityIssueSchema),
  speech: z.object({
    charactersPerSecond: z.number(),
    hookSeconds: z.number(),
    totalSeconds: z.number(),
    hookWithinFiveSeconds: z.boolean(),
  }),
  evidence: z.object({ cited: z.number().int(), total: z.number().int() }),
  /** Number of automatic corrections requested from the model before this result was accepted. */
  revisions: z.number().int().min(0),
});

export const publicErrorSchema = z.object({
  code: z.string(), message: z.string(), retryable: z.boolean(),
});

export const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stage"), stage: z.enum(["fetching", "inspecting", "analyzing", "reviewing"]) }),
  z.object({ type: z.literal("product"), product: productSchema }),
  z.object({ type: z.literal("result"), content: contentSchema, quality: qualitySchema }),
  z.object({ type: z.literal("error"), error: publicErrorSchema }),
]);

export type Product = z.infer<typeof productSchema>;
export type Content = z.infer<typeof contentSchema>;
export type Quality = z.infer<typeof qualitySchema>;
export type QualityIssueRecord = z.infer<typeof qualityIssueSchema>;
export type AnalysisPoint = z.infer<typeof pointSchema>;
export type AnalysisEvent = z.infer<typeof eventSchema>;
export type PublicError = z.infer<typeof publicErrorSchema>;
export type SetupStatus = {
  modelConfigured: boolean;
  sourceConfigured: boolean;
  source: "direct" | "firecrawl";
  accessProtected: boolean;
  /** True when a relay or Firecrawl key can retry a page that the primary region cannot price. */
  regionFallbackConfigured: boolean;
  /** True when a vision model is configured to read the product photo. */
  imageAnalysisConfigured: boolean;
  /** True when registration, credits and history are active. False means original single-user mode. */
  accountsEnabled: boolean;
  /** Credits granted on registration, shown on the sign-up form. */
  signupBonus: number;
  /** Credits consumed by one analysis. */
  analysisCost: number;
};

export function scriptText(script: Content["script"]): string {
  return `${script.hook}\n${script.body}`;
}

export function characterCount(text: string): number {
  return Array.from(text.trim()).length;
}
