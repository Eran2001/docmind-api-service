import { RETRIEVAL } from "../../config/constants";

/** Is there anything worth sending to the answer model? A keyword match, or a passage close enough in meaning. */
export function hasRelevantPassage(
  chunks: { similarity: number; keywordHit: boolean }[],
): boolean {
  if (chunks.length === 0) return false;
  if (chunks.some((chunk) => chunk.keywordHit)) return true;
  return (
    Math.max(...chunks.map((chunk) => chunk.similarity)) >=
    RETRIEVAL.MIN_SIMILARITY
  );
}
