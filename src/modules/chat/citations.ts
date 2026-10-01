import type { RetrievedChunk } from "./retrieval.repository";

export interface PublicCitation {
  marker: number;
  chunkId: string;
  documentId: string;
  documentTitle: string;
  pageNumber: number | null;
  snippet: string;
  score: number;
}

export function extractCitations(
  answer: string,
  chunks: RetrievedChunk[],
): { content: string; citations: PublicCitation[] } {
  const byMarker = new Map(chunks.map((chunk, index) => [index + 1, chunk]));
  const citations = new Map<string, PublicCitation>();
  const content = answer
    .replace(/\[(\d+)\]/g, (markerText, numberText: string) => {
      const marker = Number(numberText);
      const chunk = byMarker.get(marker);
      if (!chunk) return "";
      if (!citations.has(chunk.id)) {
        citations.set(chunk.id, {
          marker,
          chunkId: chunk.id,
          documentId: chunk.documentId,
          documentTitle: chunk.documentTitle,
          pageNumber: chunk.pageNumber,
          snippet: chunk.content.slice(0, 240),
          score: Number(chunk.score),
        });
      }
      return markerText;
    })
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();
  return { content, citations: [...citations.values()] };
}
