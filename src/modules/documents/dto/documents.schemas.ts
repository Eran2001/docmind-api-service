import { z } from "zod";

// Mirrors the web app's addUrlSchema.
export const addUrlSchema = z.object({
  url: z
    .string({ required_error: "Enter a full URL starting with https://" })
    .trim()
    .max(2048, "That URL is too long")
    .url("Enter a full URL starting with https://")
    .refine(
      (v) => /^https?:\/\//i.test(v),
      "Enter a full URL starting with https://",
    ),
});
export type AddUrlInput = z.infer<typeof addUrlSchema>;
