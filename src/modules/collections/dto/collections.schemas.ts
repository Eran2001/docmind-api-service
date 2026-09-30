import { z } from "zod";

// Mirrors the web app's src/schemas/collection.schema.ts.
const name = z.string({ required_error: "Enter a name" }).trim().min(1, "Enter a name").max(60, "Use 60 characters or fewer");

// "" and null both mean "no description".
const description = z
  .string()
  .trim()
  .max(500, "Use 500 characters or fewer")
  .nullish()
  .transform((v) => (v ? v : null));

export const createCollectionSchema = z.object({ name, description });
export type CreateCollectionInput = z.infer<typeof createCollectionSchema>;

export const updateCollectionSchema = z
  .object({
    name: name.optional(),
    // Left out = keep it; "" or null = clear it.
    description: z
      .string()
      .trim()
      .max(500, "Use 500 characters or fewer")
      .nullable()
      .optional()
      .transform((v) => (v === undefined ? undefined : v || null)),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined, { message: "Send a name or a description to change." });
export type UpdateCollectionInput = z.infer<typeof updateCollectionSchema>;

export const listCollectionsQuerySchema = z.object({
  /** Case-insensitive match on name or description. */
  search: z.string().trim().max(100, "Search is too long").optional(),
});
export type ListCollectionsQuery = z.infer<typeof listCollectionsQuerySchema>;
