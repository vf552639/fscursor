import { invoke } from "@tauri-apps/api/core";

/** Parse `sdmp://…` URLs from the desktop app or web CTAs. */
export function parseSdmpDeepLink(url: string): URL | null {
  try {
    if (!url.startsWith("sdmp:")) return null;
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Handle deep links inside Tauri: provision / bulk provision / install FastPanel.
 * Other URLs are ignored (caller may toast).
 */
export async function handleSdmpDeepLinkInTauri(url: string, userId: string | null): Promise<boolean> {
  const u = parseSdmpDeepLink(url);
  if (!u || !userId) return false;
  const host = u.hostname.toLowerCase();

  if (host === "provision") {
    const id = u.searchParams.get("domainId") || u.searchParams.get("id");
    if (!id) return false;
    await invoke("provision_domain", {
      userId,
      domainId: id,
      siteOnly: false,
    });
    return true;
  }

  if (host === "bulk-provision") {
    const ids =
      u.searchParams
        .get("ids")
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean) ?? [];
    if (ids.length === 0) return false;
    await invoke("provision_bulk", { userId, domainIds: ids });
    return true;
  }

  if (host === "install-fastpanel") {
    const sid = u.searchParams.get("serverId") || u.searchParams.get("id");
    if (!sid) return false;
    await invoke("install_fastpanel", { userId, serverId: sid, force: false });
    return true;
  }

  return false;
}
