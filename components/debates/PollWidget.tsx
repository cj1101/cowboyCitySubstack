"use client";

import { useState } from "react";
import { doc, updateDoc, serverTimestamp } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import { useAuth } from "@/components/auth/AuthProvider";
import type { PostPoll } from "@/lib/types";

interface PollWidgetProps {
  postId: string;
  poll?: PostPoll;
  canCreate?: boolean;
}

export function PollWidget({ postId, poll, canCreate = false }: PollWidgetProps) {
  const { user } = useAuth();
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [creating, setCreating] = useState(false);
  const [voting, setVoting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);

  const userVoteIndex =
    user && poll?.votes ? poll.votes[user.uid] : undefined;

  const handleCreatePoll = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    const trimmedOptions = options.map((o) => o.trim()).filter(Boolean);
    if (!question.trim() || trimmedOptions.length < 2) {
      setError("Enter a question and at least two options.");
      return;
    }

    setCreating(true);
    setError(null);
    try {
      const db = getClientDb();
      await updateDoc(doc(db, "posts", postId), {
        poll: {
          question: question.trim(),
          options: trimmedOptions,
          votes: {},
        },
        updatedAt: serverTimestamp(),
      });
      setShowCreateForm(false);
    } catch {
      setError("Could not create poll. You may need faction owner permissions.");
    } finally {
      setCreating(false);
    }
  };

  const handleVote = async (optionIndex: number) => {
    if (!user || !poll) return;

    setVoting(true);
    setError(null);
    try {
      const db = getClientDb();
      const newVotes = { ...poll.votes, [user.uid]: optionIndex };
      await updateDoc(doc(db, "posts", postId), {
        poll: { ...poll, votes: newVotes },
        updatedAt: serverTimestamp(),
      });
    } catch {
      setError("Could not record vote.");
    } finally {
      setVoting(false);
    }
  };

  const updateOption = (index: number, value: string) => {
    setOptions((prev) => prev.map((o, i) => (i === index ? value : o)));
  };

  const addOption = () => {
    if (options.length < 6) setOptions((prev) => [...prev, ""]);
  };

  if (!poll) {
    if (!canCreate || !user) return null;

    return (
      <div className="mt-6 border-t border-accent-gold/30 pt-6">
        {!showCreateForm ? (
          <button
            type="button"
            onClick={() => setShowCreateForm(true)}
            className="btn btn-secondary text-sm px-4 py-2"
          >
            Add Poll
          </button>
        ) : (
          <form onSubmit={handleCreatePoll} className="space-y-4">
            <h3 className="text-accent-gold font-bold">Create Poll</h3>
            <div>
              <label className="form-label" htmlFor="poll-question">
                Question
              </label>
              <input
                id="poll-question"
                className="form-input"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="What should the council decide?"
                maxLength={200}
              />
            </div>
            {options.map((opt, i) => (
              <div key={i}>
                <label className="form-label" htmlFor={`poll-opt-${i}`}>
                  Option {i + 1}
                </label>
                <input
                  id={`poll-opt-${i}`}
                  className="form-input"
                  value={opt}
                  onChange={(e) => updateOption(i, e.target.value)}
                  placeholder={`Option ${i + 1}`}
                  maxLength={100}
                />
              </div>
            ))}
            {options.length < 6 && (
              <button
                type="button"
                onClick={addOption}
                className="text-accent-gold text-sm hover:text-accent-gold-hover"
              >
                + Add option
              </button>
            )}
            {error && <p className="text-danger text-sm">{error}</p>}
            <div className="flex gap-3">
              <button type="submit" disabled={creating} className="btn text-sm px-4 py-2">
                {creating ? "Creating…" : "Create Poll"}
              </button>
              <button
                type="button"
                onClick={() => setShowCreateForm(false)}
                className="btn btn-secondary text-sm px-4 py-2"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    );
  }

  const totalVotes = Object.keys(poll.votes).length;

  return (
    <div className="mt-6 border-t border-accent-gold/30 pt-6">
      <h3 className="text-accent-gold font-bold mb-1">Poll</h3>
      <p className="text-text-light mb-4">{poll.question}</p>

      <div className="space-y-2">
        {poll.options.map((option, index) => {
          const voteCount = Object.values(poll.votes).filter((v) => v === index).length;
          const percentage = totalVotes > 0 ? Math.round((voteCount / totalVotes) * 100) : 0;
          const isSelected = userVoteIndex === index;

          return (
            <button
              key={index}
              type="button"
              disabled={!user || voting}
              onClick={() => handleVote(index)}
              className={`w-full text-left rounded-lg border-2 p-3 transition-all relative overflow-hidden ${
                isSelected
                  ? "border-accent-gold bg-accent-gold/10"
                  : "border-primary-brown hover:border-accent-gold/60 bg-dark-brown/40"
              } ${!user ? "cursor-default" : "cursor-pointer"}`}
            >
              <div
                className="absolute inset-y-0 left-0 bg-accent-gold/15 transition-all"
                style={{ width: `${percentage}%` }}
              />
              <div className="relative flex justify-between items-center gap-2">
                <span className="text-text-light">{option}</span>
                <span className="text-text-muted text-sm shrink-0">
                  {voteCount} ({percentage}%)
                </span>
              </div>
            </button>
          );
        })}
      </div>

      <p className="text-text-muted text-sm mt-3">
        {totalVotes} vote{totalVotes !== 1 ? "s" : ""}
        {userVoteIndex !== undefined && " · You voted"}
      </p>
      {error && <p className="text-danger text-sm mt-2">{error}</p>}
    </div>
  );
}
