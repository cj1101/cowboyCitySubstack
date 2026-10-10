export const SLOW_ACTION_MESSAGE = "That took too long. Check your connection and try again.";

export function withTimeout<T>(promise: Promise<T>, ms = 12000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(SLOW_ACTION_MESSAGE)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export function isPermissionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: unknown }).code) : "";
  if (code === "permission-denied" || code.endsWith("/permission-denied")) return true;
  const message = error instanceof Error ? error.message : "";
  return /permission|insufficient/i.test(message);
}

/** Run once, and on a permission error wait briefly and try a single time more. */
export async function retryOnceOnPermission<T>(run: () => Promise<T>, waitMs = 400): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return await run();
  }
}

export function actionError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    if (/storage\/[a-z0-9-]+/.test(error.message)) return error.message;
    if (/failed to get documents from server|client is offline|unavailable/i.test(error.message)) {
      return fallback;
    }
    if (/permission|insufficient/i.test(error.message)) {
      return "You don't have permission to do that.";
    }
    return error.message;
  }
  return fallback;
}
