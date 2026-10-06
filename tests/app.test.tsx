import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../src/App";

/** Integration tests for the application shell: navigation, global filters in links, drawers, theme and routing. */
describe("App shell", () => {
  it("renders six primary pages whose links carry the global range and technology", () => {
    window.location.hash = "#/overview?range=7d&tech=NR";
    render(<App />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Overview", "KPIs", "Alarms", "Packets", "Sites", "Report"]);
    for (const link of links) {
      expect(link.getAttribute("href")).toContain("range=7d");
      expect(link.getAttribute("href")).toContain("tech=NR");
    }
    expect(within(nav).getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
  });

  it("exposes a skip link, a theme toggle and pressed-state segmented filters", () => {
    window.location.hash = "#/overview";
    render(<App />);
    expect(screen.getByRole("link", { name: /skip to content/i })).toHaveAttribute("href", "#main");
    expect(screen.getByRole("group", { name: "Theme" })).toBeInTheDocument();
    const range = screen.getByRole("group", { name: "Time range" });
    expect(within(range).getByRole("button", { name: "24h" })).toHaveAttribute("aria-pressed", "true");
    expect(within(range).getByRole("button", { name: "7d" })).toHaveAttribute("aria-pressed", "false");
  });

  it("opens the thresholds and data drawers as dialogs", async () => {
    window.location.hash = "#/overview";
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Thresholds" }));
    const thresholds = await screen.findByRole("dialog");
    expect(within(thresholds).getByRole("heading", { name: /thresholds/i })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Data" }));
    const data = await screen.findByRole("dialog");
    expect(within(data).getByText(/synthetic/i)).toBeInTheDocument();
  });

  it("routes to the Sites and Report pages", () => {
    window.location.hash = "#/sites?range=7d";
    const { unmount } = render(<App />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/sites/i);
    unmount();
    window.location.hash = "#/report";
    render(<App />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/report/i);
  });
});
