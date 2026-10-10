export function LoadNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  if (!message) return null;
  return (
    <div className="glass-panel p-4 flex flex-wrap items-center justify-between gap-3" role="alert">
      <p className="text-sm font-bold">{message}</p>
      <button type="button" className="btn text-sm px-4 py-2 min-h-11" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}
