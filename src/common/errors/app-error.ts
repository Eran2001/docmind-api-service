import { ERROR_STATUS, type ErrorCode } from "./error-codes";

/** The error services throw on purpose. The exception filter turns it into the error envelope. */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }

  static validation(message: string, details?: unknown) {
    return new AppError("ValidationFailed", message, details);
  }
  static unauthorized(message = "Authentication required.") {
    return new AppError("Unauthorized", message);
  }
  static notFound(what = "Resource") {
    return new AppError("NotFound", `${what} not found.`);
  }
  static duplicate(message: string) {
    return new AppError("DuplicateDocument", message);
  }
  static emailTaken(message = "An account with this email already exists.") {
    // `fieldErrors` matches zod's flatten() so the UI can show it under the email field.
    return new AppError("EmailAlreadyRegistered", message, {
      fieldErrors: { email: [message] },
    });
  }
  static limit(message: string) {
    return new AppError("LimitReached", message);
  }
  static demoRestricted(
    message = "That isn't available in the demo. Create a free account to unlock it.",
  ) {
    return new AppError("DemoRestricted", message);
  }
  static demoLimit(message: string) {
    return new AppError("DemoLimitReached", message);
  }
  static rateLimited(message = "Too many requests. Try again shortly.") {
    return new AppError("RateLimited", message);
  }
  static unavailable(
    message = "A required service is unavailable. Try again shortly.",
  ) {
    return new AppError("ServiceUnavailable", message);
  }
  static aiService(message = "The AI service is unavailable.") {
    return new AppError("AiServiceFailed", message);
  }
}
