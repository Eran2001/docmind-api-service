export interface HitQuestion {
  expectedDocumentId: string | null;
  expectedEvidence?: string | null;
}

export interface HitChunk {
  documentId: string;
  content: string;
}

const normalize = (text: string) =>
  text.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Did retrieval bring back what the answer needs?
 *  - a passage of the expected document (when one is set), and
 *  - when the question names a phrase the answer rests on ("evidence"), that phrase inside one of those passages.
 * Without either, there is nothing to check and the question counts as a hit.
 */
export function isRetrievalHit(
  question: HitQuestion,
  chunks: HitChunk[],
): boolean {
  const fromExpectedDocument =
    question.expectedDocumentId === null
      ? chunks
      : chunks.filter(
          (chunk) => chunk.documentId === question.expectedDocumentId,
        );
  if (fromExpectedDocument.length === 0 && question.expectedDocumentId !== null)
    return false;
  if (!question.expectedEvidence) return true;
  const needle = normalize(question.expectedEvidence);
  return fromExpectedDocument.some((chunk) =>
    normalize(chunk.content).includes(needle),
  );
}
