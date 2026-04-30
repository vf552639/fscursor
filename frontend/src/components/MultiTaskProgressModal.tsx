import React, { useMemo, useState } from "react";

import { useTaskLog } from "../api/tasks";
import { Btn, Modal } from "./ui/Primitives";

export default function MultiTaskProgressModal({
  taskIds,
  onOpenTask,
  onClose,
}: {
  taskIds: number[];
  onOpenTask: (taskId: number) => void;
  onClose: () => void;
}) {
  const uniqueIds = useMemo(() => Array.from(new Set(taskIds)), [taskIds]);
  const [activeTaskId, setActiveTaskId] = useState<number | null>(uniqueIds[0] ?? null);

  const activeLog = useTaskLog(activeTaskId);

  if (uniqueIds.length === 0) return null;

  return (
    <Modal title={`Tasks progress (${uniqueIds.length})`} onClose={onClose} width={560}>
      <div style={{ display: "grid", gap: 8 }}>
        {uniqueIds.map((id) => (
          <button
            key={id}
            onClick={() => setActiveTaskId(id)}
            style={{
              textAlign: "left",
              border: "1px solid #e5e7eb",
              background: activeTaskId === id ? "#eff6ff" : "#fff",
              borderRadius: 8,
              padding: "8px 10px",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            #{id} - {activeTaskId === id ? (activeLog.data?.status ?? "pending") : "open"}
          </button>
        ))}
      </div>
      <div style={{ marginTop: 12, display: "flex", justifyContent: "space-between" }}>
        <Btn variant="secondary" onClick={onClose}>Close</Btn>
        {activeTaskId ? (
          <Btn variant="primary" onClick={() => onOpenTask(activeTaskId)}>
            Open Active Task
          </Btn>
        ) : null}
      </div>
    </Modal>
  );
}
