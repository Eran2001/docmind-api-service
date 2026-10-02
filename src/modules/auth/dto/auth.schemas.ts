import { z } from "zod";

// Mirrors the web app's src/schemas/auth.schema.ts.
const email = z
  .string({ required_error: "Enter your email address" })
  .trim()
  .toLowerCase()
  .min(1, "Enter your email address")
  .email("Enter a valid email, like name@company.com");

export const registerSchema = z.object({
  name: z
    .string({ required_error: "Enter your full name" })
    .trim()
    .min(1, "Enter your full name")
    .max(100),
  email,
  password: z
    .string({ required_error: "Create a password" })
    .min(8, "Password must be at least 8 characters")
    .max(128),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email,
  password: z
    .string({ required_error: "Enter your password" })
    .min(1, "Enter your password"),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const updateProfileSchema = z.object({
  name: registerSchema.shape.name,
  email,
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z
    .string({ required_error: "Enter your current password" })
    .min(1, "Enter your current password"),
  newPassword: registerSchema.shape.password,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
