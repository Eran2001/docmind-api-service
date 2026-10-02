import { z } from "zod";

export const listConversationsQuerySchema = z.object({
  /** Page size (spec 8.1: default 20, at most 100). */
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** The `nextCursor` of the previous page. */
  cursor: z.string().trim().min(1).max(300).optional(),
});
export type ListConversationsQuery = z.infer<
  typeof listConversationsQuerySchema
>;
