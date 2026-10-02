import { Injectable, type PipeTransform } from "@nestjs/common";
import type { ZodTypeAny, z } from "zod";

import { AppError } from "../errors/app-error";

/** Validates a body/query/param against a zod schema: `@Body(new ZodValidationPipe(schema)) body: Input`. */
@Injectable()
export class ZodValidationPipe<S extends ZodTypeAny> implements PipeTransform<
  unknown,
  z.infer<S>
> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw AppError.validation(
        result.error.issues[0]?.message ?? "The request is invalid.",
        result.error.flatten(),
      );
    }
    return result.data;
  }
}
