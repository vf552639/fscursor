import React from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import Register from "./pages/Register";
import RecoverySetup from "./pages/RecoverySetup";
import Login from "./pages/Login";
import RecoveryRestore from "./pages/RecoveryRestore";
import Lock from "./pages/Lock";
import DesktopWorkspace from "./pages/DesktopWorkspace";
import { useAuthStore } from "./store/auth";

function RequireAuth({ children }: { children: React.ReactElement }) {
  const { userId, unlocked } = useAuthStore();
  if (!userId) return <Navigate to="/login" replace />;
  if (!unlocked) return <Navigate to="/lock" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/recovery-setup" element={<RecoverySetup />} />
      <Route path="/recover" element={<RecoveryRestore />} />
      <Route path="/lock" element={<Lock />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <DesktopWorkspace />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
