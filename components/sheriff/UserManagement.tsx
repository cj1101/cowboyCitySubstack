"use client";

import { useCallback, useEffect, useState } from "react";
import { getAllUsers, setUserAdmin } from "@/lib/firestore/admin";
import type { AdminUser } from "@/lib/firestore/admin";

interface UserManagementProps {
  currentUid: string;
}

export function UserManagement({ currentUid }: UserManagementProps) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatingUid, setUpdatingUid] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const all = await getAllUsers();
      all.sort((a, b) => a.displayName.localeCompare(b.displayName));
      setUsers(all);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggleAdmin = async (user: AdminUser) => {
    if (user.uid === currentUid && user.isAdmin) {
      alert("You cannot remove your own admin status.");
      return;
    }
    const action = user.isAdmin ? "remove admin from" : "grant admin to";
    if (!confirm(`${action} ${user.displayName || user.email}?`)) return;

    setUpdatingUid(user.uid);
    try {
      await setUserAdmin(user.uid, !user.isAdmin);
      setUsers((prev) =>
        prev.map((u) =>
          u.uid === user.uid ? { ...u, isAdmin: !user.isAdmin } : u
        )
      );
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to update user");
    } finally {
      setUpdatingUid(null);
    }
  };

  if (loading) {
    return <p className="text-text-muted">Loading users…</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-text-muted border-b border-primary-brown">
            <th className="py-2 pr-4">Display Name</th>
            <th className="py-2 pr-4 hidden sm:table-cell">Email</th>
            <th className="py-2 pr-4 hidden lg:table-cell">UID</th>
            <th className="py-2 pr-4">Admin</th>
            <th className="py-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.uid} className="border-b border-primary-brown/50">
              <td className="py-3 pr-4">
                {user.displayName || "—"}
                {user.uid === currentUid && (
                  <span className="text-text-muted text-xs ml-1">(you)</span>
                )}
              </td>
              <td className="py-3 pr-4 hidden sm:table-cell text-text-muted">
                {user.email}
              </td>
              <td className="py-3 pr-4 hidden lg:table-cell font-mono text-xs text-text-muted">
                {user.uid}
              </td>
              <td className="py-3 pr-4">
                {user.isAdmin ? (
                  <span className="text-accent-gold font-bold">Sheriff</span>
                ) : (
                  <span className="text-text-muted">Member</span>
                )}
              </td>
              <td className="py-3">
                <button
                  type="button"
                  onClick={() => toggleAdmin(user)}
                  disabled={updatingUid === user.uid}
                  className="btn btn-secondary text-xs px-3 py-1 disabled:opacity-50"
                >
                  {updatingUid === user.uid
                    ? "Saving…"
                    : user.isAdmin
                      ? "Revoke Admin"
                      : "Make Sheriff"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
