import React, { useEffect, useMemo, useRef, useState } from "react";

import { taskStreamUrl, useTaskLog } from "../api/tasks";
import { Btn, Modal } from "./ui/Primitives";

export default function TaskProgressModal({
  taskId,
  onClose,
}: {
  taskId: number;
  onClose: () => void;
}) {
  const { data } = useTaskLog(taskId);
  const [logText, setLogText] = useState(data?.log_text ?? "");
  const [status, setStatus] = useState(data?.status ?? "pending");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLogText(data?.log_text ?? "");
    setStatus(data?.status ?? "pending");
  }, [data?.log_text, data?.status]);

  useEffect(() => {
    const es = new EventSource(taskStreamUrl(taskId));
    es.onmessage = (e) => {
      const parsed = JSON.parse(e.data) as { status: string; log_text: string };
      setStatus(parsed.status);
      setLogText(parsed.log_text);
    };
    es.onerror = () => es.close();
    return () => es.close();
  }, [taskId]);

  useEffect(() => {
    if (boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight;
    }
  }, [logText]);

  const color = useMemo(() => {
    if (status === "failed") return "#fca5a5";
    if (status === "success") return "#86efac";
    return "#93c5fd";
  }, [status]);

  return (
    <Modal title={`Task #${taskId} progress`} onClose={onClose} width={700}>
      <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 10 }}>
        Status: <b style={{ color: "#111" }}>{status}</b>
      </div>
      <div
        ref={boxRef}
        style={{
          background: "#111827",
          color,
          fontFamily: "ui-monospace, monospace",
          fontSize: 12.5,
          borderRadius: 8,
          padding: 12,
          minHeight: 320,
          maxHeight: 460,
          overflow: "auto",
          whiteSpace: "pre-wrap",
        }}
      >
        {logText || "Waiting for log output..."}
      </div>
      <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
        <Btn variant="secondary" onClick={onClose}>
          Close
        </Btn>
      </div>
    </Modal>
  );
}
