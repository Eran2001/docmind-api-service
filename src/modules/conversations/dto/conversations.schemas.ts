import { z } from "zod";

export const listConversationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
});
export type ListConversationsQuery = z.infer<
  typeof listConversationsQuerySchema
>;
