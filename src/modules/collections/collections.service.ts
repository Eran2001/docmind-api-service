import { Injectable, Logger } from "@nestjs/common";

import { AppError } from "../../common/errors/app-error";
import { StorageService } from "../../integrations/storage/storage.service";
import {
  CollectionsRepository,
  type CollectionRow,
} from "./collections.repository";
import type {
  CreateCollectionInput,
  UpdateCollectionInput,
} from "./dto/collections.schemas";

/** What the API sends for a collection (dates as UTC ISO strings). */
export interface PublicCollection {
  resourceId: string;
  name: string;
  description: string | null;
  documentCount: number;
  createdAt: string;
  updatedAt: string;
}

const toPublic = (row: CollectionRow): PublicCollection => ({
  resourceId: row.id,
  name: row.name,
  description: row.description,
  documentCount: row.documentCount,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const notFound = () => AppError.notFound("Collection");

@Injectable()
export class CollectionsService {
  private readonly logger = new Logger(CollectionsService.name);

  constructor(
    private readonly collections: CollectionsRepository,
    private readonly storage: StorageService,
  ) {}

  async list(userId: string, search?: string): Promise<PublicCollection[]> {
    return (await this.collections.list(userId, search || undefined)).map(
      toPublic,
    );
  }

  async create(
    userId: string,
    input: CreateCollectionInput,
  ): Promise<PublicCollection> {
    return toPublic(await this.collections.create(userId, input));
  }

  async update(
    userId: string,
    id: string,
    input: UpdateCollectionInput,
  ): Promise<PublicCollection> {
    const patch: { name?: string; description?: string | null } = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;
    const row = await this.collections.update(userId, id, patch);
    if (!row) throw notFound();
    return toPublic(row);
  }

  /** Deletes the collection (its documents and chunks cascade in the database) and then its uploaded files from disk. */
  async remove(userId: string, id: string): Promise<void> {
    const paths = await this.collections.storagePaths(userId, id);
    if (!(await this.collections.delete(userId, id))) throw notFound();
    await this.storage
      .removeMany(paths)
      .catch((err: unknown) =>
        this.logger.warn(`Couldn't delete stored files: ${String(err)}`),
      );
  }

  /** For other modules (documents, chat) that must confirm a collection is the caller's before touching it. */
  async requireOwned(userId: string, id: string): Promise<PublicCollection> {
    const row = await this.collections.findOwned(userId, id);
    if (!row) throw notFound();
    return toPublic(row);
  }
}
