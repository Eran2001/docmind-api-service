import { Injectable } from "@nestjs/common";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { InjectConfig } from "../../config/config.module";
import type { Env } from "../../config/env.schema";

/**
 * Uploaded files on local disk, at `STORAGE_DIR/<userId>/<documentId><ext>`. The database stores the path RELATIVE to STORAGE_DIR,
 * so the folder can move. Names are built from ids we generate, never from anything the user typed.
 */
@Injectable()
export class StorageService {
  private readonly root: string;

  constructor(@InjectConfig() config: Env) {
    this.root = resolve(config.STORAGE_DIR);
  }

  /** Writes the file and returns its relative path. */
  async save(userId: string, documentId: string, extension: string, data: Buffer): Promise<string> {
    const relativePath = join(userId, `${documentId}${extension}`);
    const target = this.resolveInside(relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data, { flag: "wx" }); // fail rather than overwrite
    return relativePath;
  }

  /** Copies a stored file to another user's folder under a new document id, and returns the new relative path. */
  async copy(fromRelativePath: string, userId: string, documentId: string, extension: string): Promise<string> {
    const relativePath = join(userId, `${documentId}${extension}`);
    const target = this.resolveInside(relativePath);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(this.resolveInside(fromRelativePath), target, constants.COPYFILE_EXCL);
    return relativePath;
  }

  async remove(relativePath: string | null | undefined): Promise<void> {
    if (!relativePath) return;
    await rm(this.resolveInside(relativePath), { force: true });
  }

  async removeMany(relativePaths: (string | null)[]): Promise<void> {
    await Promise.all(relativePaths.map((p) => this.remove(p)));
  }

  /** Deleting an account: everything that user ever uploaded. */
  async removeUserFiles(userId: string): Promise<void> {
    await rm(this.resolveInside(userId), { recursive: true, force: true });
  }

  async read(relativePath: string): Promise<Buffer> {
    return readFile(this.resolveInside(relativePath));
  }

  /** Absolute path for reading a stored file (the worker sends its bytes to the AI service). */
  absolutePath(relativePath: string): string {
    return this.resolveInside(relativePath);
  }

  // Belt and braces: whatever ends up in the database, never touch anything outside STORAGE_DIR.
  private resolveInside(relativePath: string): string {
    const target = resolve(this.root, relativePath);
    const rel = relative(this.root, target);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Path escapes the storage directory");
    return target;
  }
}
