/**
 * Every response, success or failure, has the same top-level keys in the same order:
 *
 *   success:  { code: "OK", data, message, resourceId, requestId }
 *   failure:  { code: "NotFound", error, debug?, message, resourceId, requestId }
 *
 *   data (single):  { ...object }
 *   data (list):    { result: [ {...}, {...} ], total?, nextCursor? }
 *   error:          { status, details? }          debug (not in production): { name, message, stack, method, path, timestamp }
 *
 * `code` says what happened: "OK" for every success; on failure the error code (NotFound, ApiRouteFailed, ...).
 * Controllers return `respond.ok(...)`, `respond.list(...)` etc. (or a plain value, wrapped as `ok`); the
 * ResponseInterceptor adds `requestId` and sets the HTTP status. Failures are built by the exception filter.
 */

export interface ListData<T> {
  /** The rows the frontend maps over. */
  result: T[];
  /** Total rows across all pages, when known. */
  total?: number;
  /** Cursor for the next page (spec 8.1); null when there is no next page. */
  nextCursor?: string | null;
}

export interface ApiEnvelope<T> {
  code: string;
  data: T;
  message: string;
  /** Id of the resource this request created or acted on; null when there isn't one. */
  resourceId: string | null;
  requestId: string;
}

export interface ApiErrorDetail {
  status: number;
  details?: unknown;
}

export interface ApiDebugInfo {
  name: string;
  message: string;
  stack?: string;
  method: string;
  path: string;
  timestamp: string;
}

export interface ApiErrorEnvelope {
  code: string;
  error: ApiErrorDetail;
  /** Only outside production. */
  debug?: ApiDebugInfo;
  message: string;
  resourceId: string | null;
  requestId: string;
}

interface ApiResponseInit<T> {
  data: T;
  status?: number;
  code?: string;
  message?: string;
  resourceId?: string;
}

/** Marker returned by controllers; the interceptor turns it into an `ApiEnvelope`. */
export class ApiResponse<T = unknown> {
  readonly data: T;
  readonly status?: number;
  readonly code: string;
  readonly message: string;
  readonly resourceId?: string;

  constructor(init: ApiResponseInit<T>) {
    this.data = init.data;
    this.status = init.status;
    this.code = init.code ?? "OK";
    this.message = init.message ?? "OK";
    this.resourceId = init.resourceId;
  }
}

export const respond = {
  /** 200 with a single object: `data: { ... }`. */
  ok<T>(data: T, message = "OK"): ApiResponse<T> {
    return new ApiResponse({ data, message });
  },

  /** 200 with a list: `data: { result: [...], total?, nextCursor? }`. */
  list<T>(result: T[], meta: { total?: number; nextCursor?: string | null } = {}): ApiResponse<ListData<T>> {
    return new ApiResponse({ data: { result, ...meta } });
  },

  /** 201 for a newly created resource; `resourceId` is the new id. Still code "OK". */
  created<T>(data: T, resourceId?: string, message = "Created"): ApiResponse<T> {
    return new ApiResponse({ data, status: 201, message, resourceId });
  },

  /** 202 for work queued in the background (uploads, eval runs). Still code "OK". */
  accepted<T>(data: T, resourceId?: string, message = "Accepted"): ApiResponse<T> {
    return new ApiResponse({ data, status: 202, message, resourceId });
  },

  /** Anything else, e.g. a 503 that still carries a report. */
  of<T>(init: ApiResponseInit<T>): ApiResponse<T> {
    return new ApiResponse(init);
  },
};

export function toEnvelope<T>(res: ApiResponse<T>, requestId: string): ApiEnvelope<T> {
  return {
    code: res.code,
    data: res.data,
    message: res.message,
    resourceId: res.resourceId ?? null,
    requestId,
  };
}
