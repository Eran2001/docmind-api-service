import { z } from "zod";

export const createEvalSetSchema = z.object({
  name: z.string().trim().min(1).max(100),
  collectionId: z.string().uuid(),
  description: z.string().trim().max(300).optional(),
});
export type CreateEvalSetInput = z.infer<typeof createEvalSetSchema>;

export const createEvalQuestionSchema = z.object({
  question: z.string().trim().min(1).max(1000),
  expectedAnswer: z.string().trim().min(1).max(2000),
  expectedDocumentId: z.string().uuid().optional(),
  expectedEvidence: z.string().trim().min(1).max(500).optional(),
});
export type CreateEvalQuestionInput = z.infer<typeof createEvalQuestionSchema>;

export const startEvalRunSchema = z.object({
  topK: z.number().int().min(1).max(20).optional(),
});
export type StartEvalRunInput = z.infer<typeof startEvalRunSchema>;
