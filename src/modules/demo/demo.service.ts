import { Injectable, Logger } from "@nestjs/common";
import { hash } from "@node-rs/argon2";
import { randomBytes, randomUUID } from "node:crypto";

import { AppError } from "../../common/errors/app-error";
import { DEMO } from "../../config/constants";
import { StorageService } from "../../integrations/storage/storage.service";
import { DEMO_COLLECTION } from "../../seed-data";
import { AuthService, type IssuedSession } from "../auth/auth.service";
import { DemoRepository } from "./demo.repository";

@Injectable()
export class DemoService {
  private readonly logger = new Logger(DemoService.name);

  constructor(
    private readonly demo: DemoRepository,
    private readonly auth: AuthService,
    private readonly storage: StorageService,
  ) {}

  /** Makes a private sandbox for one visitor (a copy of the sample collection) and signs them in. */
  async start(): Promise<IssuedSession> {
    if ((await this.demo.activeDemoCount()) >= DEMO.MAX_ACTIVE)
      throw AppError.unavailable(
        "The demo is busy right now. Please try again in a little while.",
      );

    const template = await this.demo.findTemplate(
      DEMO.TEMPLATE_EMAIL,
      DEMO_COLLECTION.name,
    );
    if (!template)
      throw AppError.unavailable(
        "The demo isn't set up yet. Create an account to try DocMind.",
      );

    // `.invalid` can never be a real address (RFC 2606); nobody can sign in with this account except through this endpoint.
    const email = `demo-${randomUUID()}@demo.docmind.invalid`;
    try {
      const { user } = await this.demo.createSandbox({
        email,
        name: "Demo visitor",
        passwordHash: await hash(randomBytes(24).toString("base64url")),
        templateCollectionId: template.collectionId,
        copyFile: (from, userId, documentId, extension) =>
          this.storage.copy(from, userId, documentId, extension),
      });
      return await this.auth.startSessionFor(user);
    } catch (error) {
      // The transaction rolled back the rows; copied files are on disk, so they are removed here.
      const copied = (error as { copiedPaths?: string[] }).copiedPaths ?? [];
      await this.storage.removeMany(copied).catch(() => undefined);
      throw error;
    }
  }

  /** Deletes demo accounts past their lifetime, with their files. Safe to run often and from several workers. */
  async cleanupExpired(now = new Date()): Promise<number> {
    const olderThan = new Date(now.getTime() - DEMO.TTL_HOURS * 3_600_000);
    const ids = await this.demo.deleteExpired(olderThan);
    for (const id of ids)
      await this.storage.removeUserFiles(id).catch(() => undefined);
    if (ids.length > 0)
      this.logger.log(`Removed ${ids.length} expired demo account(s).`);
    return ids.length;
  }
}
