"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildMentionToken,
  searchMentionTargets,
  type MentionTarget,
} from "@/lib/mentions";

interface MentionAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  className?: string;
  disabled?: boolean;
}

export function MentionAutocomplete({
  value,
  onChange,
  placeholder = "Write lore… Use @ to mention factions, characters, or posts",
  rows = 8,
  className = "",
  disabled = false,
}: MentionAutocompleteProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [suggestions, setSuggestions] = useState<MentionTarget[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionStart, setMentionStart] = useState<number | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const loadSuggestions = useCallback(async (query: string) => {
    const results = await searchMentionTargets(query);
    setSuggestions(results);
    setSelectedIndex(0);
  }, []);

  useEffect(() => {
    if (!showSuggestions) return;
    const timer = setTimeout(() => {
      void loadSuggestions(mentionQuery);
    }, 150);
    return () => clearTimeout(timer);
  }, [mentionQuery, showSuggestions, loadSuggestions]);

  const handleChange = (nextValue: string) => {
    onChange(nextValue);

    const textarea = textareaRef.current;
    if (!textarea) return;

    const cursor = textarea.selectionStart;
    const textBeforeCursor = nextValue.slice(0, cursor);
    const atMatch = textBeforeCursor.match(/@([a-zA-Z0-9_-]*)$/);

    if (atMatch) {
      setMentionStart(cursor - atMatch[0].length);
      setMentionQuery(atMatch[1]);
      setShowSuggestions(true);
    } else {
      setShowSuggestions(false);
      setMentionStart(null);
      setMentionQuery("");
    }
  };

  const insertMention = (target: MentionTarget) => {
    if (mentionStart === null) return;

    const textarea = textareaRef.current;
    const cursor = textarea?.selectionStart ?? value.length;
    const token = buildMentionToken(target.type, target.id);
    const before = value.slice(0, mentionStart);
    const after = value.slice(cursor);
    const nextValue = `${before}${token} ${after}`;

    onChange(nextValue);
    setShowSuggestions(false);
    setMentionStart(null);
    setMentionQuery("");

    requestAnimationFrame(() => {
      if (!textarea) return;
      const newCursor = before.length + token.length + 1;
      textarea.focus();
      textarea.setSelectionRange(newCursor, newCursor);
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!showSuggestions || suggestions.length === 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((i) => (i + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      insertMention(suggestions[selectedIndex]);
    } else if (event.key === "Escape") {
      setShowSuggestions(false);
    }
  };

  return (
    <div className="relative">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        className={`form-input resize-y min-h-[120px] ${className}`}
      />

      {showSuggestions && suggestions.length > 0 && (
        <ul className="absolute z-20 left-0 right-0 mt-1 max-h-48 overflow-y-auto glass-panel border border-accent-gold rounded shadow-lg">
          {suggestions.map((target, index) => (
            <li key={`${target.type}-${target.id}`}>
              <button
                type="button"
                className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                  index === selectedIndex
                    ? "bg-accent-yellow text-on-yellow"
                    : "text-text-light hover:bg-primary-brown"
                }`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertMention(target);
                }}
              >
                <span className="text-xs uppercase opacity-70 mr-2">{target.type}</span>
                {target.label}
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="text-text-muted text-xs mt-1">
        Type <code className="text-accent-gold">@</code> to link factions, characters, or posts.
      </p>
    </div>
  );
}
