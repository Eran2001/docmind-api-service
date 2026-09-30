import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AppError } from "../errors/app-error";
import { ZodValidationPipe } from "./zod-validation.pipe";

const pipe = new ZodValidationPipe(z.object({ email: z.string().email("Enter a valid email"), age: z.coerce.number().default(18) }));

describe("ZodValidationPipe", () => {
  it("returns the parsed (and coerced) value", () => {
    expect(pipe.transform({ email: "a@b.co", age: "30" })).toEqual({ email: "a@b.co", age: 30 });
    expect(pipe.transform({ email: "a@b.co" })).toEqual({ email: "a@b.co", age: 18 });
  });

  it("throws a ValidationFailed AppError with the first message and all field errors", () => {
    try {
      pipe.transform({ email: "nope" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const e = err as AppError;
      expect(e.code).toBe("ValidationFailed");
      expect(e.status).toBe(400);
      expect(e.message).toBe("Enter a valid email");
      expect(e.details).toHaveProperty("fieldErrors.email");
    }
  });
});
