import { useMutation, useQuery } from "@tanstack/react-query";

import { apiDelete, apiGet, apiPost } from "./client";
import { queryClient } from "./queryClient";

export interface Notification {
  id: number;
  type: string;
  entity_type: string;
  entity_id: number;
  title: string;
  message: string | null;
  is_read: boolean;
  read_at: string | null;
  created_at: string;
}

export interface UnreadCountResponse {
  count: number;
}

export interface MarkReadPayload {
  ids?: number[];
}

export const notificationsKeys = {
  all: ["notifications"] as const,
  list: (isRead?: boolean) => ["notifications", "list", isRead] as const,
  unreadCount: ["notifications", "unread-count"] as const,
};

export function useNotifications(isRead?: boolean) {
  return useQuery({
    queryKey: notificationsKeys.list(isRead),
    queryFn: () =>
      apiGet<Notification[]>("/notifications", {
        params: { is_read: isRead === undefined ? undefined : isRead },
      }),
  });
}

export function useUnreadCount() {
  return useQuery({
    queryKey: notificationsKeys.unreadCount,
    queryFn: () => apiGet<UnreadCountResponse>("/notifications/unread-count"),
    refetchInterval: 60_000,
  });
}

export function useMarkNotificationsRead() {
  return useMutation({
    mutationFn: (payload: MarkReadPayload = {}) =>
      apiPost<{ updated: number }>("/notifications/mark-read", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: notificationsKeys.all });
    },
  });
}

export function useDeleteNotification() {
  return useMutation({
    mutationFn: (id: number) => apiDelete(`/notifications/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: notificationsKeys.all });
    },
  });
}
