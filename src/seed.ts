import "dotenv/config";

import { Inject, Injectable, Logger, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { hash } from "@node-rs/argon2";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";

import { ConfigModule } from "./config/config.module";
import { DatabaseModule, DB, type Database } from "./database/database.module";
import { users } from "./database/schema";
import { StorageModule } from "./integrations/storage/storage.module";
import { CollectionsModule } from "./modules/collections/collections.module";
import { CollectionsService } from "./modules/collections/collections.service";
import { DocumentsModule } from "./modules/documents/documents.module";
import { DocumentsService } from "./modules/documents/documents.service";
import { EvalsModule } from "./modules/evals/evals.module";
import { EvalsService } from "./modules/evals/evals.service";
import { UsersModule } from "./modules/users/users.module";
import { UsersService } from "./modules/users/users.service";
import { QueueModule } from "./queues/queue.module";
import {
  ADMIN_USER,
  DEMO_COLLECTION,
  DEMO_USER,
  EVAL_QUESTIONS,
  EVAL_SET,
  FAQ,
  HANDBOOK,
} from "./seed-data";

@Injectable()
class Seeder {
  private readonly logger = new Logger("Seed");

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly usersService: UsersService,
    private readonly collections: CollectionsService,
    private readonly documents: DocumentsService,
    private readonly evals: EvalsService,
  ) {}

  async run(): Promise<void> {
    await this.seedAdmin();
    await this.seedDemo();
  }

  private async seedAdmin(): Promise<void> {
    if (await this.usersService.findByEmail(ADMIN_USER.email)) {
      this.logger.log(`Admin ${ADMIN_USER.email} already exists, skipping.`);
      return;
    }
    const password =
      process.env.SEED_ADMIN_PASSWORD || randomBytes(12).toString("base64url");
    const admin = await this.usersService.create({
      ...ADMIN_USER,
      passwordHash: await hash(password),
    });
    await this.db
      .update(users)
      .set({ role: "admin" })
      .where(eq(users.id, admin.id));
    this.logger.log(`Created admin ${ADMIN_USER.email}`);
    if (!process.env.SEED_ADMIN_PASSWORD)
      this.logger.log(`Admin password (shown once): ${password}`);
  }

  private async seedDemo(): Promise<void> {
    if (await this.usersService.findByEmail(DEMO_USER.email)) {
      this.logger.log(
        `Demo user ${DEMO_USER.email} already exists, skipping the demo data.`,
      );
      return;
    }
    const user = await this.usersService.create({
      name: DEMO_USER.name,
      email: DEMO_USER.email,
      passwordHash: await hash(DEMO_USER.password),
    });

    const collection = await this.collections.create(user.id, {
      ...DEMO_COLLECTION,
    });
    const docIds = {
      handbook: await this.documents.uploadFile(
        user.id,
        collection.resourceId,
        {
          filename: HANDBOOK.filename,
          data: Buffer.from(HANDBOOK.content),
        },
      ),
      faq: await this.documents.uploadFile(user.id, collection.resourceId, {
        filename: FAQ.filename,
        data: Buffer.from(FAQ.content),
      }),
    };

    const set = await this.evals.createSet(user.id, {
      ...EVAL_SET,
      collectionId: collection.resourceId,
    });
    for (const q of EVAL_QUESTIONS) {
      await this.evals.addQuestion(user.id, set.resourceId, {
        question: q.question,
        expectedAnswer: q.expected,
        expectedDocumentId: docIds[q.doc],
      });
    }
    this.logger.log(
      `Created ${DEMO_USER.email} with 1 collection, 2 documents (queued) and 1 eval set of 5 questions.`,
    );
    this.logger.log(
      "Start the worker and the AI service so the two documents get processed.",
    );
  }
}

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    StorageModule,
    QueueModule,
    UsersModule,
    CollectionsModule,
    DocumentsModule,
    EvalsModule,
  ],
  providers: [Seeder],
})
class SeedModule {}

async function bootstrap(): Promise<void> {
  if (process.env.NODE_ENV === "production")
    throw new Error("Refusing to seed demo accounts in production.");
  const app = await NestFactory.createApplicationContext(SeedModule, {
    logger: ["log", "warn", "error"],
  });
  try {
    await app.get(Seeder).run();
  } finally {
    await app.close();
  }
}

void bootstrap().catch((error: unknown) => {
  new Logger("Seed").error(
    `Seeding failed: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exitCode = 1;
});
