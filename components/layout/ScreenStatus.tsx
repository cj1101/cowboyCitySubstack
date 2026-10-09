import type { ReactNode } from "react";

export function ScreenStatus({ children }: { children: ReactNode }) {
  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] flex items-center justify-center p-6">
      <p className="text-text-muted text-lg text-center">{children}</p>
    </div>
  );
}
