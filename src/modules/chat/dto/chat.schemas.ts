import { z } from "zod";

export const sendMessageSchema = z.object({
  content: z.string().trim().min(1).max(4000),
});
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export const feedbackSchema = z.object({
  rating: z.union([z.literal(1), z.literal(-1)]),
  comment: z.string().trim().max(1000).optional(),
});
export type FeedbackInput = z.infer<typeof feedbackSchema>;
