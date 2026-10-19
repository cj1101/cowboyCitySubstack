"use client";

/**
 * StatFigure — one verified figure with its provenance affordance
 * (brief §6.2 / §7.1): the figure, and a "why?" link to the Log when the
 * read path supplied one. A null figure renders `—` plus its honest
 * caption and NO why-link — there is nothing to explain yet, and the
 * caption says so. Nothing here ever renders a published claim; claims
 * live in their own labeled blocks (brief §7.2), never in this component.
 */

import Link from "next/link";
import type { DashboardFigure } from "@/lib/dashboard/registry";

export function formatFigureValue(value: number): string {
  return value.toLocaleString("en-US");
}

export function StatFigure({
  figure,
  label,
}: {
  figure: DashboardFigure;
  label?: string;
}) {
  if (figure.value === null) {
    return (
      <span>
        {label ? <span className="text-text-muted">{label}: </span> : null}
        <span aria-label={figure.nullCaption ?? "No figure recorded"}>—</span>
        {figure.nullCaption ? (
          <span className="text-xs text-text-muted"> {figure.nullCaption}</span>
        ) : null}
      </span>
    );
  }
  return (
    <span>
      {label ? <span className="text-text-muted">{label}: </span> : null}
      <span className="font-bold">{formatFigureValue(figure.value)}</span>
      {figure.whyHref ? (
        <>
          {" "}
          <Link href={figure.whyHref} className="text-xs underline">
            why?
          </Link>
        </>
      ) : null}
    </span>
  );
}
