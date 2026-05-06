import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./runtime";

export async function invokeIfTauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error(`${cmd} requires the desktop app`);
  }
  return invoke<T>(cmd, args as Record<string, unknown>);
}
