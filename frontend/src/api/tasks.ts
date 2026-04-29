import { useQuery } from "@tanstack/react-query";

import { API_BASE_URL, apiGet } from "./client";

export type TaskStatus = "pending" | "running" | "success" | "failed";

export interface TaskLog {
  id: number;
  entity_type: string;
  entity_id: number | null;
  task_type: string;
  status: TaskStatus | string;
  log_text: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskFilters {
  entity_type?: string;
  entity_id?: number;
  status?: TaskStatus;
}

export const tasksKeys = {
  all: ["tasks"] as const,
  list: (filters?: TaskFilters) => ["tasks", "list", filters ?? {}] as const,
  detail: (id: number) => ["tasks", id] as const,
};

export function useTaskLogs(filters?: TaskFilters) {
  return useQuery({
    queryKey: tasksKeys.list(filters),
    queryFn: () => apiGet<TaskLog[]>("/tasks", { params: filters }),
  });
}

export function useTaskLog(id: number | null | undefined) {
  return useQuery({
    queryKey: id ? tasksKeys.detail(id) : ["tasks", "disabled"],
    queryFn: () => apiGet<TaskLog>(`/tasks/${id}`),
    enabled: !!id,
  });
}

export function taskStreamUrl(taskId: number): string {
  const base = API_BASE_URL.replace(/\/$/, "");
  return `${base}/tasks/${taskId}/stream`;
}
