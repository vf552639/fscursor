import { useQuery } from "@tanstack/react-query";

import { API_BASE_URL, apiGet } from "./client";

/**
 * Значения `TaskLogStatus` из `backend/app/core/constants.py`, все.
 *
 * `partial` («дошло до конца, обработано не всё») пишет фоновый мониторинг
 * серверов. Без него union не описывал даже собственный фильтр страницы
 * Activity — тот ставит `partial`, — а компиляцию спасало `| string` у поля
 * `status` ниже, то есть отсутствие типа спасало неверный тип.
 */
export type TaskStatus = "pending" | "running" | "success" | "failed" | "partial";

export interface TaskLog {
  id: number;
  entity_type: string;
  entity_id: number | null;
  task_type: string;
  // `| string` оставлено намеренно: значение приходит с сервера строкой, и
  // страница Activity рисует в том числе то, чего в union нет (`installed`,
  // `ok`, `error` в её `stMap`). Union выше нужен там, где значение выбираем
  // МЫ, — например, пункты фильтра; здесь же он ничего не гарантирует, и
  // делать вид, что гарантирует, было бы хуже, чем не типизировать вовсе.
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
