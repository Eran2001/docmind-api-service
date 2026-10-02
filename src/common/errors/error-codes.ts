// The `code` of an error response, and the HTTP status each one carries. (Success is always code "OK".)
export const ERROR_STATUS = {
  ValidationFailed: 400,
  Unauthorized: 401,
  NotFound: 404, // a resource (collection, document, ...) doesn't exist or isn't yours
  ApiRouteFailed: 404, // the URL itself doesn't exist
  DuplicateDocument: 409,
  EmailAlreadyRegistered: 409,
  LimitReached: 422,
  DemoLimitReached: 403, // a demo visitor used up their questions or upload
  DemoRestricted: 403, // an action the demo account may not do (change password, delete things, ...)
  RateLimited: 429,
  InternalError: 500,
  AiServiceFailed: 502,
  ServiceUnavailable: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;
