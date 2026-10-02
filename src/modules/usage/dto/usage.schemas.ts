import { z } from "zod";

export const usageQuerySchema = z.object({
  /** Length of the window in days, today included. The web app offers 7, 30 and 90. */
  days: z.coerce.number().int().min(1).max(365).default(30),
});
export type UsageQuery = z.infer<typeof usageQuerySchema>;
