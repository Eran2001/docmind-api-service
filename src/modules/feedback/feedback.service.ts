import { Injectable } from "@nestjs/common";

import { CollectionsService } from "../collections/collections.service";
import { FeedbackRepository } from "./feedback.repository";

@Injectable()
export class FeedbackService {
  constructor(
    private readonly feedback: FeedbackRepository,
    private readonly collections: CollectionsService,
  ) {}

  async ratedAnswers(
    userId: string,
    collectionId: string,
    rating: 1 | -1,
    limit: number,
  ) {
    await this.collections.requireOwned(userId, collectionId);
    const rows = await this.feedback.ratedAnswers(
      userId,
      collectionId,
      rating,
      limit,
    );
    return rows
      .filter((row) => row.question !== null)
      .map((row) => ({
        resourceId: row.resourceId,
        conversationId: row.conversationId,
        question: row.question as string,
        answer: row.answer,
        comment: row.comment,
        createdAt: new Date(row.createdAt).toISOString(),
      }));
  }
}
