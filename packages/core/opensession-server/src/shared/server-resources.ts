import { z } from "zod";

export const RESOURCE_SAMPLE_MS = 2_000;
export const RESOURCE_HISTORY_MS = 120_000;
const percent = z.number().min(0).max(100);
const capacity = z.object({
  usedBytes: z.number().nonnegative(),
  totalBytes: z.number().positive(),
  usedPct: percent,
});
export const serverResourceSampleSchema = z.object({
  at: z.number().nonnegative(),
  cpu: percent.nullable(),
  memory: capacity.nullable(),
  disk: capacity.nullable(),
});
export const serverResourcesSchema = z.object({
  samples: z.array(serverResourceSampleSchema).max(60),
});
export type ServerResourceSample = z.infer<typeof serverResourceSampleSchema>;
export type ServerResources = z.infer<typeof serverResourcesSchema>;
