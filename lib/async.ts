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
