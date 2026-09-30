import { Injectable, type PipeTransform } from "@nestjs/common";

import { AppError } from "../errors/app-error";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `@Param("id", new UuidParamPipe("Collection")) id: string`. A malformed id is answered as "not found" (404), exactly like an
 * id that doesn't exist or belongs to someone else, so ids can't be probed, and Postgres never sees a value it can't cast.
 */
@Injectable()
export class UuidParamPipe implements PipeTransform<string, string> {
  constructor(private readonly what = "Resource") {}

  transform(value: string): string {
    if (!UUID.test(value)) throw AppError.notFound(this.what);
    return value;
  }
}
