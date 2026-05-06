import { describe, it, expect, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { OpenInDesktop } from "./OpenInDesktop";

describe("OpenInDesktop", () => {
  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("renders link on web", () => {
    const { container } = render(<OpenInDesktop action="provision?domainId=1" label="Run" desktopOnClick={() => {}} />);
    const a = container.querySelector("a");
    expect(a).toBeTruthy();
    expect(a?.getAttribute("href")).toBe("sdmp://provision?domainId=1");
  });

  it("renders button in Tauri", () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    const { container } = render(<OpenInDesktop action="x" label="Run" desktopOnClick={() => {}} />);
    expect(container.querySelector("button")).toBeTruthy();
  });
});
