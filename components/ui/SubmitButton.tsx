import type { ButtonHTMLAttributes } from "react";

export function SubmitButton({
  busy,
  children,
  busyLabel = "Saving…",
  className = "btn",
  type = "submit",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean; busyLabel?: string }) {
  return (
    <button type={type} className={className} disabled={busy || props.disabled} aria-busy={busy} {...props}>
      {busy ? (
        <span className="inline-flex items-center justify-center gap-2">
          <span className="pixel-spinner" aria-hidden />
          {busyLabel}
        </span>
      ) : (
        children
      )}
    </button>
  );
}
