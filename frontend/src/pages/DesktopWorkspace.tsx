import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import Dashboard from "./Dashboard";
import Servers from "./Servers";
import ServerDetail from "./ServerDetail";
import Domains from "./Domains";
import Cloudflare from "./Cloudflare";
import Activity from "./Activity";
import Notifications from "./Notifications";
import Settings from "./Settings";
import { useUnreadCount } from "../api/notifications";
import { useAuthStore, bumpMasterKeyActivity } from "../store/auth";
import { invokeIfTauri } from "../lib/tauri-invoke";
import { isTauri } from "../lib/runtime";
import { apiPost } from "../api/client";
import { handleSdmpDeepLinkInTauri, type InstallFastpanelResult } from "../lib/deepLink";
import { FastPanelCredsModal } from "../components/FastPanelCredsModal";
import { ProvisionResultModal } from "../components/ProvisionResultModal";
import { useShowOnceQueue } from "../hooks/useShowOnceQueue";
import type { ProvisionOutcome } from "../api/domains";

/**
 * Шаг установки FastPanel → текст в тосте (события `fastpanel:progress`).
 * Экспортируется ради теста: неизвестный шаг слушатель молча выбрасывает, то
 * есть забытая строчка здесь делает шаг невидимым.
 */
export const FASTPANEL_STEP_LABEL: Record<string, string> = {
  ssh_connect: "FastPanel: connecting over SSH…",
  updating: "FastPanel: updating the system, this takes a while…",
  installing: "FastPanel: running the installer, this takes a while…",
  creds_unparsed: "FastPanel installed, but its credentials could not be read",
  audit_failed: "FastPanel installed, but the audit entry was not recorded",
  // Панель стоит, но сервер об этом не знает: fastpanel_status остался прежним,
  // и проверка идемпотентности в следующий раз пропустит переустановку.
  writeback_failed: "FastPanel installed, but the result could not be saved on the server",
};

/**
 * Шаг provision → текст в тосте (события `provision:progress`, шлёт
 * `commands/provision.rs`). Провижн идёт минутами и до этого не показывал
 * ничего. Неизвестные шаги игнорируем — сырые имена шагов пользователю не текст.
 */
export const PROVISION_STEP_LABEL: Record<string, string> = {
  ssh_connect: "Provision: connecting over SSH…",
  fastpanel_path: "Provision: locating FastPanel…",
  firewall_preflight: "Provision: checking the firewall…",
  firewall_warning: "Provision: firewall may block HTTP/HTTPS — SSL can fail",
  ftp: "Provision: creating the FTP account…",
  db: "Provision: creating the database…",
  ssl_exists: "Provision: certificate already present, skipping issue",
  ssl_dns_check: "Provision: checking DNS before issuing SSL…",
  ssl_skipped_dns: "Provision: SSL skipped — the domain does not resolve here yet",
  ssl_skipped_no_email: "Provision: SSL skipped — no contact email configured",
  ssl_issue: "Provision: issuing the certificate, this takes a while…",
  audit_failed: "Provisioned, but the audit entry was not recorded",
  // Сайт создан, но домен на сервере остался в прежнем статусе: следующий
  // провижн не увидит, что делать уже нечего.
  writeback_failed: "Provisioned, but the result could not be saved on the server",
  bulk_item: "Bulk provision: next domain…",
  bulk_failed: "Bulk provision: a domain failed, continuing…",
};

/**
 * Действие cf/registrar → его название для канала `audit:progress`. Сообщается
 * только то, что не удалось ЗАПИСАТЬ: строчку в audit log (`audit_failed`) или
 * результат на сервере (`writeback_failed`).
 *
 * Название подставляется в утвердительном прошедшем времени («Nameservers set,
 * but …»), поэтому Rust обязан слать эти шаги ТОЛЬКО после состоявшегося
 * действия. Для `audit_failed` это гарантировано устройством
 * `audit_best_effort` (он зовётся после успеха), для `writeback_failed` —
 * явной проверкой в `registrar_set_nameservers`: write-back там выполняется и
 * на отказе регистратора, но событие о его провале на этом пути не шлётся,
 * иначе тост «Nameservers set…» встал бы рядом с баннером об ошибке.
 */
export const AUDIT_ACTION_LABEL: Record<string, string> = {
  "cf.zone.create": "Zone created",
  "cf.dns.create": "DNS record created",
  "cf.dns.update": "DNS record updated",
  "cf.dns.delete": "DNS record deleted",
  "cf.cache_purge": "Cache purged",
  "registrar.ns_set": "Nameservers set",
};

const TWEAK_DEFAULTS = {
  accentColor: "#2563eb",
  sidebarWidth: 200,
  compactMode: false,
  defaultPage: "dashboard",
};

export default function DesktopWorkspace() {
  const navigate = useNavigate();
  const { userId, email, clear, masterKey } = useAuthStore();
  const { data: unreadData } = useUnreadCount();
  const [page, setPage] = useState<string>(() => {
    try {
      return localStorage.getItem("sdmp_page") || TWEAK_DEFAULTS.defaultPage;
    } catch {
      return "dashboard";
    }
  });
  const [srvCtx, setSrv] = useState<any>(null);
  const [toast, setToast] = useState<string | null>(null);
  // Креды FastPanel живут только в стейте этого компонента: их нет ни на
  // сервере, ни в кэше, и они НЕ должны туда попадать. Поставщика два —
  // deep link `sdmp://install-fastpanel` и кнопка на ServerDetail, — а место
  // показа одно.
  //
  // Пароли БД и FTP после provision — та же история и то же место показа: их
  // нет ни на сервере, ни в кэше, и страница `Domains`, которая их заказала,
  // размонтируется при уходе пользователя. Держать их обязан тот, кто
  // смонтирован всегда.
  //
  // Очередь, а не один слот: гейты в UI подоменные и посерверные, поэтому вторая
  // операция запускается, пока идёт первая (это намеренно — обе идут минутами).
  // Одноместный слот означал бы, что второй результат затирает первый прямо на
  // глазах у читающего пароли, а взять их больше негде.
  const fpQueue = useShowOnceQueue<InstallFastpanelResult>();
  const provisionQueue = useShowOnceQueue<ProvisionOutcome>();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [tweaks, setTweaks] = useState(false);
  const [tw, setTw] = useState(TWEAK_DEFAULTS);

  useEffect(() => {
    try {
      localStorage.setItem("sdmp_page", page);
    } catch {}
  }, [page]);

  useEffect(() => {
    if (!masterKey) return;
    const onAct = () => bumpMasterKeyActivity();
    window.addEventListener("pointerdown", onAct);
    return () => window.removeEventListener("pointerdown", onAct);
  }, [masterKey]);

  useEffect(() => {
    const h = (e: any) => {
      if (e.data?.type === "__activate_edit_mode") setTweaks(true);
      if (e.data?.type === "__deactivate_edit_mode") setTweaks(false);
    };
    window.addEventListener("message", h);
    window.parent.postMessage({ type: "__edit_mode_available" }, "*");
    return () => window.removeEventListener("message", h);
  }, []);

  const applyTweak = (k: string, v: any) => {
    const next = { ...tw, [k]: v };
    setTw(next);
    window.parent.postMessage({ type: "__edit_mode_set_keys", edits: { [k]: v } }, "*");
  };

  const nav = (pg: string, ctx?: any) => {
    if (pg === "server-detail") {
      setSrv(ctx);
      setPage("server-detail");
    } else {
      setPage(pg);
      setSrv(ctx || null);
    }
  };

  const showToast = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 2200);
  };

  useEffect(() => {
    if (!isTauri() || !userId) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      const { onOpenUrl, getCurrent } = await import("@tauri-apps/plugin-deep-link");
      const runDeepLink = async (url: string) => {
        try {
          const res = await handleSdmpDeepLinkInTauri(url, userId);
          if (!res.handled) showToast(`Deep link: ${url}`);
          else if (res.cancelled) showToast("Deep link cancelled — nothing was run");
          else if (res.fastpanel) fpQueue.push(res.fastpanel);
          else if (res.provision) provisionQueue.push(res.provision);
        } catch (e) {
          showToast(e instanceof Error ? e.message : String(e));
        }
      };
      const start = await getCurrent();
      if (start?.length) {
        for (const url of start) await runDeepLink(url);
      }
      unlisten = await onOpenUrl((urls) => {
        void (async () => {
          for (const url of urls) await runDeepLink(url);
        })();
      });
    })();
    return () => {
      unlisten?.();
    };
  }, [userId]);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<{ host: string; port: number; fingerprint: string }>(
        "ssh:host-key-prompt",
        (event) => {
          const { host, port, fingerprint } = event.payload;
          const ok = window.confirm(
            `Unknown SSH host key for ${host}:${port}\n\n${fingerprint}\n\nTrust this host and save the key?`,
          );
          if (ok) {
            void invokeIfTauri("ssh_accept_host_key", { host, port, fingerprint }).catch(() => {
              setToast("Could not save host key");
              setTimeout(() => setToast(null), 2200);
            });
          }
        },
      );
    })();
    return () => {
      unlisten?.();
    };
  }, []);

  // Установка FastPanel идёт десятки минут — показываем, на каком она шаге.
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<{ step: string; server_id: string }>("fastpanel:progress", (event) => {
        const label = FASTPANEL_STEP_LABEL[event.payload.step];
        if (label) showToast(label);
      });
    })();
    return () => {
      unlisten?.();
    };
  }, []);

  // Провижн тоже идёт минутами — те же тосты по шагам.
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<{ step: string; domain_id: string }>("provision:progress", (event) => {
        const label = PROVISION_STEP_LABEL[event.payload.step];
        if (label) showToast(label);
      });
    })();
    return () => {
      unlisten?.();
    };
  }, []);

  // cf/registrar-мутации выполняются, даже если запись их следа не прошла: ни
  // про потерянную строчку аудита, ни про незаписанный на сервере результат
  // молчать нельзя — иначе действие исчезает незаметно.
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<{
        step: string;
        action: string;
        target_type: string;
        target_id: string;
      }>("audit:progress", (event) => {
        const label = AUDIT_ACTION_LABEL[event.payload.action];
        if (!label) return;
        if (event.payload.step === "audit_failed") {
          showToast(`${label}, but the audit entry was not recorded`);
        } else if (event.payload.step === "writeback_failed") {
          showToast(`${label}, but the result could not be saved on the server`);
        }
      });
    })();
    return () => {
      unlisten?.();
    };
  }, []);

  const handleLogout = async () => {
    if (isTauri() && userId) {
      try {
        // camelCase: с `user_id` команда падала, forget_master_key не вызывался
        // и мастер-ключ оставался в OS-keychain после выхода.
        await invokeIfTauri("auth_logout", { userId });
      } catch {
        /* still clear local session */
      }
    } else {
      try {
        await apiPost("/auth/logout");
      } catch {
        /* still clear local session */
      }
    }
    try {
      localStorage.removeItem("sdmp_token");
      localStorage.removeItem("token");
    } catch {}
    clear();
    navigate("/login", { replace: true });
  };

  const handleLock = () => {
    if (!isTauri()) {
      useAuthStore.getState().clearMasterKey();
      return;
    }
    useAuthStore.getState().setUnlocked(false);
    navigate("/lock", { replace: true });
  };

  const active = page === "server-detail" ? "servers" : page;
  const accent = tw.accentColor;
  const initial = (email || "?").slice(0, 1).toUpperCase();

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <aside
        style={{
          width: tw.sidebarWidth,
          background: "#fff",
          borderRight: "1px solid #e5e7eb",
          display: "flex",
          flexDirection: "column",
          position: "fixed",
          top: 0,
          left: 0,
          bottom: 0,
          zIndex: 10,
        }}
      >
        <div
          style={{
            padding: "18px 18px 14px",
            borderBottom: "1px solid #e5e7eb",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <div
            style={{
              width: 36,
              height: 36,
              background: accent,
              borderRadius: 8,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
              fontWeight: 700,
              fontSize: 13,
              letterSpacing: "-0.5px",
              flexShrink: 0,
            }}
          >
            SD
          </div>
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: "#111", lineHeight: 1.2 }}>SDMP</div>
            <div
              style={{
                fontSize: 9,
                fontWeight: 500,
                color: "#6b7280",
                textTransform: "uppercase",
                letterSpacing: "0.5px",
              }}
            >
              Infrastructure
            </div>
          </div>
        </div>
        <nav style={{ padding: "12px 10px", flex: 1 }}>
          {[
            { key: "dashboard", label: "Dashboard", icon: "⊞" },
            { key: "servers", label: "Servers", icon: "▤" },
            { key: "domains", label: "Domains", icon: "◎" },
            { key: "cloudflare", label: "Cloudflare", icon: "☁" },
            { key: "notifications", label: "Notifications", icon: "🔔" },
            { key: "activity", label: "Activity", icon: "∿" },
            { key: "settings", label: "Settings", icon: "⚙" },
          ].map((n) => (
            <div
              key={n.key}
              onClick={() => nav(n.key)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: tw.compactMode ? "6px 10px" : "8px 10px",
                borderRadius: 7,
                cursor: "pointer",
                fontSize: 13.5,
                fontWeight: 500,
                marginBottom: 2,
                transition: "all 0.15s",
                background: active === n.key ? `${accent}18` : "transparent",
                color: active === n.key ? accent : "#6b7280",
              }}
              onMouseEnter={(e) => {
                if (active !== n.key) {
                  e.currentTarget.style.background = "#f3f4f6";
                  e.currentTarget.style.color = "#111";
                }
              }}
              onMouseLeave={(e) => {
                if (active !== n.key) {
                  e.currentTarget.style.background = "transparent";
                  e.currentTarget.style.color = "#6b7280";
                }
              }}
            >
              <span style={{ width: 16, textAlign: "center" }}>{n.icon}</span>
              {n.label}
            </div>
          ))}
        </nav>
        <div style={{ padding: 14, borderTop: "1px solid #e5e7eb" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12.5,
              fontWeight: 500,
              color: "#16a34a",
              background: "#f0fdf4",
              padding: "8px 12px",
              borderRadius: 20,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "#16a34a",
                display: "inline-block",
              }}
            />
            System Status
          </div>
        </div>
      </aside>

      <header
        style={{
          position: "fixed",
          top: 0,
          left: tw.sidebarWidth,
          right: 0,
          height: 57,
          background: "#fff",
          borderBottom: "1px solid #e5e7eb",
          display: "flex",
          alignItems: "center",
          padding: "0 24px",
          gap: 12,
          zIndex: 9,
        }}
      >
        <div style={{ flex: 1 }} />
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <button
            onClick={() => nav("notifications")}
            style={{
              position: "relative",
              width: 34,
              height: 34,
              borderRadius: 8,
              border: "1px solid #e5e7eb",
              background: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            🔔
            {(unreadData?.count || 0) > 0 && (
              <span
                style={{
                  position: "absolute",
                  top: -4,
                  right: -4,
                  minWidth: 16,
                  height: 16,
                  borderRadius: 999,
                  background: "#dc2626",
                  color: "#fff",
                  fontSize: 10,
                  fontWeight: 700,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "0 4px",
                }}
              >
                {unreadData?.count}
              </span>
            )}
          </button>
          {["☀", "🌙"].map((ic) => (
            <div
              key={ic}
              onClick={() => showToast("Dark mode coming soon")}
              style={{
                width: 34,
                height: 34,
                borderRadius: 8,
                border: "1px solid #e5e7eb",
                background: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                fontSize: 14,
              }}
            >
              {ic}
            </div>
          ))}
          <div style={{ position: "relative" }}>
            <div
              onClick={() => setUserMenuOpen((v) => !v)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "5px 10px 5px 6px",
                border: "1px solid #e5e7eb",
                borderRadius: 8,
                cursor: "pointer",
              }}
            >
              <div
                style={{
                  width: 26,
                  height: 26,
                  background: "#e5e7eb",
                  borderRadius: "50%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 11,
                  fontWeight: 600,
                  color: "#555",
                }}
              >
                {initial}
              </div>
              <div>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: "#111", lineHeight: 1.3 }}>
                  Account
                </div>
                <div style={{ fontSize: 11, color: "#6b7280" }}>{email || "—"}</div>
              </div>
              <span style={{ fontSize: 11, color: "#9ca3af", marginLeft: 4 }}>▾</span>
            </div>
            {userMenuOpen && (
              <div
                style={{
                  position: "absolute",
                  right: 0,
                  top: 42,
                  minWidth: 160,
                  border: "1px solid #e5e7eb",
                  borderRadius: 8,
                  background: "#fff",
                  boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
                  overflow: "hidden",
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    setUserMenuOpen(false);
                    handleLock();
                  }}
                  style={{
                    width: "100%",
                    border: "none",
                    background: "#fff",
                    padding: "10px 12px",
                    textAlign: "left",
                    cursor: "pointer",
                    fontSize: 13,
                    color: "#374151",
                  }}
                >
                  Lock
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setUserMenuOpen(false);
                    void handleLogout();
                  }}
                  style={{
                    width: "100%",
                    border: "none",
                    background: "#fff",
                    padding: "10px 12px",
                    textAlign: "left",
                    cursor: "pointer",
                    fontSize: 13,
                    color: "#374151",
                  }}
                >
                  Logout
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main
        key={page}
        style={{
          marginLeft: tw.sidebarWidth,
          marginTop: 57,
          padding: 28,
          flex: 1,
          minWidth: 0,
          animation: "fadeIn 0.18s ease",
        }}
      >
        {page === "dashboard" && <Dashboard onNav={nav} />}
        {page === "servers" && <Servers onNav={nav} />}
        {page === "domains" && (
          <Domains onNav={nav} ctx={srvCtx} onProvisionResult={provisionQueue.push} />
        )}
        {page === "cloudflare" && <Cloudflare onNav={nav} />}
        {page === "notifications" && <Notifications onNav={nav} />}
        {page === "activity" && <Activity />}
        {page === "settings" && <Settings />}
        {page === "server-detail" && (
          <ServerDetail
            server={srvCtx}
            onBack={(pg: string) => nav(pg || "servers")}
            onNav={nav}
            onFastpanelCreds={fpQueue.push}
          />
        )}
      </main>

      {fpQueue.current && (
        <FastPanelCredsModal creds={fpQueue.current} onClose={fpQueue.dismiss} />
      )}
      {provisionQueue.current && (
        <ProvisionResultModal
          domain={provisionQueue.current.domain}
          result={provisionQueue.current.result}
          onClose={provisionQueue.dismiss}
        />
      )}

      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            right: 24,
            background: "#111",
            color: "#fff",
            padding: "10px 18px",
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 500,
            zIndex: 200,
            animation: "slideIn 0.2s ease",
          }}
        >
          ✓ {toast}
        </div>
      )}

      {tweaks && (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            right: 24,
            background: "#fff",
            border: "1px solid #e5e7eb",
            borderRadius: 14,
            padding: 20,
            width: 270,
            boxShadow: "0 8px 32px rgba(0,0,0,0.14)",
            zIndex: 300,
            animation: "slideIn 0.2s ease",
          }}
        >
          <div
            style={{
              fontSize: 13.5,
              fontWeight: 700,
              color: "#111",
              marginBottom: 16,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            Tweaks
            <button
              type="button"
              onClick={() => setTweaks(false)}
              style={{ background: "none", border: "none", cursor: "pointer", color: "#9ca3af", fontSize: 16 }}
            >
              ✕
            </button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <div
                style={{
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: "#9ca3af",
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                  marginBottom: 8,
                }}
              >
                Accent Color
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {(
                  [
                    ["#2563eb", "Blue"],
                    ["#7c3aed", "Purple"],
                    ["#059669", "Green"],
                    ["#dc2626", "Red"],
                    ["#d97706", "Amber"],
                  ] as const
                ).map(([c, l]) => (
                  <div
                    key={c}
                    onClick={() => applyTweak("accentColor", c)}
                    title={l}
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: "50%",
                      background: c,
                      cursor: "pointer",
                      border: tw.accentColor === c ? "3px solid #111" : "3px solid transparent",
                      transition: "all 0.15s",
                    }}
                  />
                ))}
              </div>
            </div>
            <div>
              <div
                style={{
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: "#9ca3af",
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                  marginBottom: 6,
                }}
              >
                Sidebar Width: {tw.sidebarWidth}px
              </div>
              <input
                type="range"
                min={160}
                max={260}
                value={tw.sidebarWidth}
                onChange={(e) => applyTweak("sidebarWidth", Number(e.target.value))}
                style={{ width: "100%" }}
              />
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13 }}>
              <input
                type="checkbox"
                checked={tw.compactMode}
                onChange={(e) => applyTweak("compactMode", e.target.checked)}
              />{" "}
              Compact Sidebar
            </label>
            <div>
              <div
                style={{
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: "#9ca3af",
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                  marginBottom: 6,
                }}
              >
                Default Page
              </div>
              <select
                value={tw.defaultPage}
                onChange={(e) => applyTweak("defaultPage", e.target.value)}
                style={{
                  width: "100%",
                  padding: "7px 10px",
                  border: "1px solid #e5e7eb",
                  borderRadius: 7,
                  fontSize: 13,
                  fontFamily: "inherit",
                  outline: "none",
                }}
              >
                {["dashboard", "servers", "domains", "cloudflare", "notifications", "activity", "settings"].map(
                  (p) => (
                    <option key={p} value={p}>
                      {p.charAt(0).toUpperCase() + p.slice(1)}
                    </option>
                  ),
                )}
              </select>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
