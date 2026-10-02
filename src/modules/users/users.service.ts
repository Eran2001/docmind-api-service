import { Injectable } from "@nestjs/common";

import { DEMO } from "../../config/constants";
import { UsersRepository, type UserRow } from "./users.repository";

/** What the API ever tells a client about a user: never the password hash. */
export interface PublicUser {
  resourceId: string;
  name: string;
  email: string;
  role: "user" | "admin";
  /** The picture itself comes from `GET /auth/me/avatar` (it needs the Bearer token, so an <img> tag can't load it). */
  hasAvatar: boolean;
  /** Set only for "Try the demo" accounts: what the visitor has left, and when the account is deleted. */
  demo: {
    questionsLeft: number;
    uploadsLeft: number;
    expiresAt: string;
  } | null;
  createdAt: string;
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    resourceId: row.id,
    name: row.name,
    email: row.email,
    role: row.role === "admin" ? "admin" : "user",
    hasAvatar: row.avatarPath !== null,
    demo: row.isDemo
      ? {
          questionsLeft: Math.max(0, DEMO.QUESTIONS - row.demoQuestionsUsed),
          uploadsLeft: Math.max(0, DEMO.UPLOADS - row.demoUploadsUsed),
          expiresAt: new Date(
            row.createdAt.getTime() + DEMO.TTL_HOURS * 3_600_000,
          ).toISOString(),
        }
      : null,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class UsersService {
  constructor(private readonly users: UsersRepository) {}

  findByEmail(email: string) {
    return this.users.findByEmail(email);
  }

  findById(id: string) {
    return this.users.findById(id);
  }

  create(input: { email: string; passwordHash: string; name: string }) {
    return this.users.create(input);
  }

  updateProfile(id: string, input: { name: string; email: string }) {
    return this.users.updateProfile(id, input);
  }

  updatePasswordHash(id: string, passwordHash: string) {
    return this.users.updatePasswordHash(id, passwordHash);
  }

  /** Stores the new avatar path (or null) and returns the previous one so its file can be removed. */
  setAvatarPath(id: string, avatarPath: string | null) {
    return this.users.setAvatarPath(id, avatarPath);
  }

  delete(id: string) {
    return this.users.delete(id);
  }
}
