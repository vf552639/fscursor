import React, { useMemo, useState } from "react";

import {
  Badge,
  Btn,
  Card,
  Sel,
  StatCard,
  fmtDT,
} from "../components/ui/Primitives";
import {
  Notification,
  useDeleteNotification,
  useMarkNotificationsRead,
  useNotifications,
} from "../api/notifications";

export default function Notifications({ onNav }: { onNav?: (pg: string, ctx?: any) => void }) {
  const [filter, setFilter] = useState("all");
  const isRead = filter === "all" ? undefined : filter === "read";

  const { data, isLoading } = useNotifications(isRead);
  const markRead = useMarkNotificationsRead();
  const deleteNotification = useDeleteNotification();

  const notifications = data || [];
  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.is_read).length,
    [notifications]
  );
  const readCount = notifications.length - unreadCount;

  const Th = ({ children }: { children: React.ReactNode }) => (
    <th
      style={{
        padding: "10px 16px",
        textAlign: "left",
        fontSize: 11.5,
        fontWeight: 600,
        color: "#6b7280",
        textTransform: "uppercase",
        letterSpacing: "0.4px",
        background: "#f9fafb",
        borderBottom: "1px solid #e5e7eb",
      }}
    >
      {children}
    </th>
  );

  if (isLoading) {
    return (
      <div style={{ padding: 40, textAlign: "center", color: "#6b7280" }}>
        Loading notifications...
      </div>
    );
  }

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 20,
        }}
      >
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#111", marginBottom: 2 }}>
            Notifications
          </h1>
          <div style={{ fontSize: 13, color: "#6b7280" }}>
            Renewal reminders and system notices
          </div>
        </div>
        <Btn
          variant="secondary"
          onClick={() => markRead.mutate({ ids: [] })}
          disabled={markRead.isPending || unreadCount === 0}
        >
          {markRead.isPending ? "Marking..." : "Mark all read"}
        </Btn>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14, marginBottom: 20 }}>
        <StatCard label="Total" value={notifications.length} color="#2563eb" />
        <StatCard label="Unread" value={unreadCount} color="#d97706" />
        <StatCard label="Read" value={readCount} color="#16a34a" />
      </div>

      <Card>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid #e5e7eb", display: "flex", gap: 10 }}>
          <Sel value={filter} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setFilter(e.target.value)}>
            <option value="all">All</option>
            <option value="unread">Unread</option>
            <option value="read">Read</option>
          </Sel>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["#", "Type", "Title", "Message", "Status", "Created", ""].map((h) => (
                  <Th key={h}>{h}</Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {notifications.map((n: Notification) => (
                <tr
                  key={n.id}
                  onClick={() => {
                    if (n.type === "domain_renewal" && n.entity_type === "domain" && n.entity_id) {
                      if (!n.is_read) {
                        markRead.mutate({ ids: [n.id] });
                      }
                      onNav?.("domains", { domainId: n.entity_id });
                    }
                  }}
                  style={{ cursor: n.type === "domain_renewal" ? "pointer" : "default" }}
                  onMouseEnter={e => { if (n.type === "domain_renewal") e.currentTarget.style.background = "#fafbfc"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = ""; }}
                >
                  <td style={{ padding: "11px 16px", fontSize: 13, color: "#9ca3af", fontFamily: "monospace" }}>
                    #{n.id}
                  </td>
                  <td style={{ padding: "11px 16px", fontSize: 13 }}>{n.type}</td>
                  <td style={{ padding: "11px 16px", fontSize: 13, fontWeight: 600 }}>{n.title}</td>
                  <td style={{ padding: "11px 16px", fontSize: 13, color: "#6b7280" }}>{n.message || "—"}</td>
                  <td style={{ padding: "11px 16px" }}>
                    <Badge variant={n.is_read ? "gray" : "yellow"}>
                      {n.is_read ? "Read" : "Unread"}
                    </Badge>
                  </td>
                  <td style={{ padding: "11px 16px", fontSize: 12, color: "#9ca3af", whiteSpace: "nowrap" }}>
                    {fmtDT(n.created_at)}
                  </td>
                  <td style={{ padding: "11px 16px", display: "flex", gap: 8 }}>
                    <Btn
                      size="sm"
                      variant="secondary"
                      onClick={(e: React.MouseEvent<HTMLButtonElement>) => { e.stopPropagation(); markRead.mutate({ ids: [n.id] }); }}
                      disabled={markRead.isPending || n.is_read}
                    >
                      Mark read
                    </Btn>
                    <Btn
                      size="sm"
                      variant="danger"
                      onClick={(e: React.MouseEvent<HTMLButtonElement>) => { e.stopPropagation(); deleteNotification.mutate(n.id); }}
                      disabled={deleteNotification.isPending}
                    >
                      Delete
                    </Btn>
                  </td>
                </tr>
              ))}
              {notifications.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ textAlign: "center", padding: 40, color: "#6b7280" }}>
                    No notifications found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
