import { useMutation, useQuery } from "@tanstack/react-query";

import { apiGet, apiPost, apiPut } from "./client";
import { queryClient } from "./queryClient";

export interface SystemConfigItem {
  key: string;
  value: string;
  editable: boolean;
}

export const settingsKeys = {
  config: ["settings", "config"] as const,
};

export function useSystemConfig() {
  return useQuery({
    queryKey: settingsKeys.config,
    queryFn: () => apiGet<SystemConfigItem[]>("/settings/config"),
  });
}

export function useUpdateSystemConfig() {
  return useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) =>
      apiPut<SystemConfigItem>(`/settings/config/${encodeURIComponent(key)}`, { value }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: settingsKeys.config }),
  });
}

export interface NotificationTestResult {
  webhook: string;
  telegram: string;
}

export function useTestNotificationDelivery() {
  return useMutation({
    mutationFn: ({ title, message }: { title: string; message: string }) =>
      apiPost<NotificationTestResult>("/settings/notifications/test", { title, message }),
  });
}
