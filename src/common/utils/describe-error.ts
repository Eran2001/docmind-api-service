/** A readable one-liner for any thrown value. Connection errors (ECONNREFUSED) often have an empty `message`. */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return err.message || (code ? `${err.name} (${code})` : err.name);
  }
  return String(err);
}

/** Runs `log` at most once per `intervalMs`, so a dependency outage doesn't flood the logs while it retries. */
export function throttle(
  log: (message: string) => void,
  intervalMs = 30_000,
): (message: string) => void {
  let last = 0;
  return (message) => {
    const now = Date.now();
    if (now - last < intervalMs) return;
    last = now;
    log(message);
  };
}
