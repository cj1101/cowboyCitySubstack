"use client";

import { useCallback, useEffect, useState } from "react";
import { getAllUsers, inviteEmail, setUserAdmin, setUserStatus } from "@/lib/firestore/admin";
import { notify } from "@/lib/firestore/notifications";
import type { AdminUser } from "@/lib/firestore/admin";
import { REQUIRE_APPROVAL } from "@/lib/membership";

interface UserManagementProps {
  currentUid: string;
}

export function UserManagement({ currentUid }: UserManagementProps) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatingUid, setUpdatingUid] = useState<string | null>(null);
  const [invite, setInvite] = useState("");

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

  const setStatus = async (user: AdminUser, status: string) => {
    setUpdatingUid(user.uid);
    try {
      await setUserStatus(user.uid, status);
      if (status === "suspended" || status === "removed" || status === "approved" || status === "denied") {
        await notify({
          recipientUid: user.uid,
          type: "approval",
          summary: status === "suspended"
            ? "The Sheriff suspended your membership."
            : status === "removed"
              ? "The Sheriff removed your membership."
              : status === "approved"
                ? "The Sheriff approved your membership."
                : `Membership ${status}.`,
          href: status === "approved" ? "/" : "/settings",
          actorUid: currentUid,
        }).catch(() => undefined);
      }
      setUsers((prev) => prev.map((item) => (item.uid === user.uid ? { ...item, status } : item)));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to update membership");
    } finally {
      setUpdatingUid(null);
    }
  };

  if (loading) {
    return <p className="text-text-muted">Loading users…</p>;
  }

  return (
    <div className="space-y-6">
      {REQUIRE_APPROVAL && (
      <form
        className="flex flex-wrap gap-2"
        onSubmit={async (event) => {
          event.preventDefault();
          await inviteEmail(invite, currentUid);
          setInvite("");
          alert("Invite saved. They are approved automatically when they sign up with that email.");
        }}
      >
        <input className="form-input flex-1 min-w-[200px]" type="email" required placeholder="friend@example.com" value={invite} onChange={(e) => setInvite(e.target.value)} />
        <button className="btn text-sm px-4 py-2" type="submit">Invite by email</button>
      </form>
      )}
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-text-muted border-b border-primary-brown">
            <th className="py-2 pr-4">Display Name</th>
            <th className="py-2 pr-4 hidden sm:table-cell">Email</th>
            <th className="py-2 pr-4 hidden lg:table-cell">UID</th>
            <th className="py-2 pr-4">Status</th>
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
              <td className="py-3 pr-4 capitalize">{user.status || "pending"}</td>
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
                {user.uid !== currentUid && (
                  <span className="inline-flex flex-wrap gap-1 ml-2">
                    {REQUIRE_APPROVAL && (
                      <>
                        <button type="button" className="btn text-xs px-2 py-1" onClick={() => setStatus(user, "approved")}>Approve</button>
                        <button type="button" className="btn btn-secondary text-xs px-2 py-1" onClick={() => setStatus(user, "denied")}>Deny</button>
                      </>
                    )}
                    <button type="button" className="btn btn-secondary text-xs px-2 py-1" disabled={updatingUid === user.uid} onClick={() => setStatus(user, "suspended")}>Suspend</button>
                    <button type="button" className="btn btn-danger text-xs px-2 py-1" disabled={updatingUid === user.uid} onClick={() => {
                      if (!confirm(`Remove ${user.displayName || user.email}?`)) return;
                      setStatus(user, "removed");
                    }}>Remove</button>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </div>
  );
}
