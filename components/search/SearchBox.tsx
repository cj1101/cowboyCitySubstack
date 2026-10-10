"use client";

import { FormEvent, useId, useState } from "react";
import { useRouter } from "next/navigation";

export function SearchBox({ className }: { className?: string }) {
  const router = useRouter();
  const inputId = useId();
  const [q, setQ] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const needle = q.trim();
    router.push(needle ? `/search?q=${encodeURIComponent(needle)}` : "/search");
  };

  return (
    <form role="search" className={className || "flex items-center gap-1 min-w-0"} onSubmit={submit}>
      <label className="sr-only" htmlFor={inputId}>Search the realm</label>
      <input
        id={inputId}
        className="form-input py-1.5 text-sm w-28 sm:w-36 lg:w-44 min-h-11"
        placeholder="Search"
        value={q}
        onChange={(event) => setQ(event.target.value)}
        autoComplete="off"
      />
      <button className="btn text-sm px-3 py-1.5 min-h-11" type="submit">Search</button>
    </form>
  );
}
