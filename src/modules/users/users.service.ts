import { Injectable } from "@nestjs/common";

import { UsersRepository, type UserRow } from "./users.repository";

/** What the API ever tells a client about a user: never the password hash. */
export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: "user" | "admin";
  createdAt: string;
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role === "admin" ? "admin" : "user",
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

  delete(id: string) {
    return this.users.delete(id);
  }
}
