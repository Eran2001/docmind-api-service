import "dotenv/config";

import { Inject, Injectable, Logger, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { hash } from "@node-rs/argon2";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { ConfigModule } from "./config/config.module";
import { DatabaseModule, DB, type Database } from "./database/database.module";
import { collections, documents, evalSets, users } from "./database/schema";
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
  DOC_CONTENT,
  DOC_FILENAMES,
  EVAL_QUESTIONS,
  EVAL_SET,
  FULL_EVAL_QUESTIONS,
  FULL_EVAL_SET,
  type DocKey,
} from "./seed-data";
import {
  BENCH_COLLECTION,
  BENCH_FILES,
  BENCH_QUESTIONS,
  BENCH_SET,
  type BenchDocKey,
} from "./seed-bench";

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
    if (process.env.SEED_BENCH === "1") await this.seedBench();
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

  /**
   * Makes sure the demo account, its sample collection, the sample documents and both eval sets exist. It only ADDS what is
   * missing (matched by name), so it is safe to run again on an existing database and never touches anything else in the
   * account, such as documents you uploaded yourself.
   */
  private async seedDemo(): Promise<void> {
    let user = await this.usersService.findByEmail(DEMO_USER.email);
    if (!user) {
      user = await this.usersService.create({
        name: DEMO_USER.name,
        email: DEMO_USER.email,
        passwordHash: await hash(DEMO_USER.password),
      });
      this.logger.log(`Created ${DEMO_USER.email}`);
    }

    const [existingCollection] = await this.db
      .select({ id: collections.id })
      .from(collections)
      .where(
        and(
          eq(collections.userId, user.id),
          eq(collections.name, DEMO_COLLECTION.name),
        ),
      )
      .limit(1);
    const collectionId =
      existingCollection?.id ??
      (await this.collections.create(user.id, { ...DEMO_COLLECTION }))
        .resourceId;

    const present = await this.db
      .select({ id: documents.id, title: documents.title })
      .from(documents)
      .where(eq(documents.collectionId, collectionId));
    const docIds = {} as Record<DocKey, string>;
    for (const key of Object.keys(DOC_FILENAMES) as DocKey[]) {
      const filename = DOC_FILENAMES[key];
      const found = present.find((doc) => doc.title === filename);
      if (found) {
        docIds[key] = found.id;
        continue;
      }
      docIds[key] = await this.documents.uploadFile(user.id, collectionId, {
        filename,
        data: Buffer.from(DOC_CONTENT[key]),
      });
      this.logger.log(`Added ${filename} (queued for processing)`);
    }

    await this.ensureEvalSet(
      user.id,
      collectionId,
      EVAL_SET,
      EVAL_QUESTIONS.map((q) => ({
        question: q.question,
        expected: q.expected,
        doc: q.doc,
      })),
      docIds,
    );
    await this.ensureEvalSet(
      user.id,
      collectionId,
      FULL_EVAL_SET,
      FULL_EVAL_QUESTIONS.map((q) => ({
        question: q.question,
        expected: q.expected,
        doc: q.doc,
        evidence: q.evidence,
      })),
      docIds,
    );
    this.logger.log(
      "Demo data is in place. Start the worker and the AI service so any new documents get processed.",
    );
  }

  /**
   * `npm run db:seed:bench`: a second collection in the demo account holding four long documents, with the 40-question
   * "DocMind docs benchmark" eval set. Used to tune retrieval (chunk size, top-k, ...); not part of the public demo.
   */
  private async seedBench(): Promise<void> {
    const user = await this.usersService.findByEmail(DEMO_USER.email);
    if (!user)
      throw new Error(
        "Run the normal seed first (it creates the demo account).",
      );
    const [existing] = await this.db
      .select({ id: collections.id })
      .from(collections)
      .where(
        and(
          eq(collections.userId, user.id),
          eq(collections.name, BENCH_COLLECTION.name),
        ),
      )
      .limit(1);
    const collectionId =
      existing?.id ??
      (await this.collections.create(user.id, { ...BENCH_COLLECTION }))
        .resourceId;

    const present = await this.db
      .select({ id: documents.id, title: documents.title })
      .from(documents)
      .where(eq(documents.collectionId, collectionId));
    const docIds: Record<string, string> = {};
    for (const key of Object.keys(BENCH_FILES) as BenchDocKey[]) {
      const filename = BENCH_FILES[key];
      const found = present.find((doc) => doc.title === filename);
      if (found) {
        docIds[key] = found.id;
        continue;
      }
      docIds[key] = await this.documents.uploadFile(user.id, collectionId, {
        filename,
        data: readFileSync(join(process.cwd(), "bench/corpus", filename)),
      });
      this.logger.log(`Added ${filename} (queued for processing)`);
    }
    await this.ensureEvalSet(
      user.id,
      collectionId,
      BENCH_SET,
      BENCH_QUESTIONS.map((q) => ({
        question: q.question,
        expected: q.expected,
        doc: q.doc,
        evidence: q.evidence,
      })),
      docIds,
    );
  }

  private async ensureEvalSet(
    userId: string,
    collectionId: string,
    set: { name: string; description: string },
    questions: {
      question: string;
      expected: string;
      doc?: string;
      evidence?: string;
    }[],
    docIds: Record<string, string>,
  ): Promise<void> {
    const [found] = await this.db
      .select({ id: evalSets.id })
      .from(evalSets)
      .where(and(eq(evalSets.userId, userId), eq(evalSets.name, set.name)))
      .limit(1);
    if (found) {
      this.logger.log(`Eval set "${set.name}" already exists, skipping.`);
      return;
    }
    const created = await this.evals.createSet(userId, {
      name: set.name,
      description: set.description,
      collectionId,
    });
    for (const q of questions) {
      await this.evals.addQuestion(userId, created.resourceId, {
        question: q.question,
        expectedAnswer: q.expected,
        expectedDocumentId: q.doc ? docIds[q.doc] : undefined,
        expectedEvidence: q.evidence,
      });
    }
    this.logger.log(
      `Created eval set "${set.name}" with ${questions.length} questions.`,
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
