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
  variant: z.object({ name: z.string().nullable(), total: z.number().int().min(2) }).nullable(),
  imageUrl: z.string().url().nullable(),
  features: z.array(z.string()),
  specifications: z.array(z.object({ name: z.string(), value: z.string() })),
  description: z.string().nullable(),
  evidence: z.array(evidenceSchema),
  source: z.object({ provider: z.enum(["direct", "firecrawl"]), fetchedAt: z.string() }),
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

export const publicErrorSchema = z.object({
  code: z.string(), message: z.string(), retryable: z.boolean(),
});

export const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stage"), stage: z.enum(["fetching", "analyzing"]) }),
  z.object({ type: z.literal("product"), product: productSchema }),
  z.object({ type: z.literal("result"), content: contentSchema }),
  z.object({ type: z.literal("error"), error: publicErrorSchema }),
]);

export type Product = z.infer<typeof productSchema>;
export type Content = z.infer<typeof contentSchema>;
export type AnalysisPoint = z.infer<typeof pointSchema>;
export type AnalysisEvent = z.infer<typeof eventSchema>;
export type PublicError = z.infer<typeof publicErrorSchema>;
export type SetupStatus = {
  modelConfigured: boolean;
  sourceConfigured: boolean;
  source: "direct" | "firecrawl";
  accessProtected: boolean;
};

export function scriptText(script: Content["script"]): string {
  return `${script.hook}\n${script.body}`;
}

export function characterCount(text: string): number {
  return Array.from(text.trim()).length;
}
