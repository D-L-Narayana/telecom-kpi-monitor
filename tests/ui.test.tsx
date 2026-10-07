import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Card, Drawer, Empty, LevelBadge, Notice, SeverityBadge, StateBadge, VisuallyHidden, fmtTime } from "../src/components/ui";

const noop = () => {};

/** A page fragment with a trigger button, so focus restoration can be observed. */
function DrawerFixture({ onClose = noop, footer, width }: { onClose?: () => void; footer?: ReactNode; width?: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(true)}>Open settings</button>
      <button>Other</button>
      <Drawer open={open} onClose={() => { onClose(); setOpen(false); }} title="Settings" footer={footer} width={width}>
        <label>
          Name <input defaultValue="x" />
        </label>
        <button>Apply</button>
      </Drawer>
    </div>
  );
}

describe("Drawer", () => {
  it("renders nothing while closed", () => {
    render(<Drawer open={false} onClose={noop} title="Closed"><p>Hidden body</p></Drawer>);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Hidden body")).toBeNull();
  });

  it('is a modal dialog labelled by its <h2> title', () => {
    render(<Drawer open onClose={noop} title="Settings"><p>Body text</p></Drawer>);
    const dialog = screen.queryByRole("dialog");
    expect(dialog).not.toBeNull();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const labelledBy = dialog!.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    const heading = document.getElementById(labelledBy!);
    expect(heading?.tagName).toBe("H2");
    expect(heading).toHaveTextContent("Settings");
    expect(dialog).toHaveAccessibleName("Settings");
    expect(within(dialog!).getByText("Body text")).toBeInTheDocument();
  });

  it("calls onClose on Escape", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Drawer open onClose={onClose} title="Settings"><button>Apply</button></Drawer>);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("has a Close button that calls onClose", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Drawer open onClose={onClose} title="Settings"><p>Body</p></Drawer>);
    const dialog = screen.queryByRole("dialog");
    expect(dialog).not.toBeNull();
    await user.click(within(dialog!).getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves focus inside on open and returns it to the trigger on close", async () => {
    const user = userEvent.setup();
    render(<DrawerFixture />);
    const trigger = screen.getByRole("button", { name: "Open settings" });
    await user.click(trigger);
    const dialog = screen.queryByRole("dialog");
    expect(dialog).not.toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(dialog!.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on backdrop click but not on clicks inside", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<Drawer open onClose={onClose} title="Settings"><button>Apply</button></Drawer>);
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onClose).not.toHaveBeenCalled();
    const backdrop = container.querySelector(".drawer-backdrop");
    expect(backdrop).not.toBeNull();
    await user.click(backdrop as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("traps Tab and Shift+Tab inside the dialog", async () => {
    const user = userEvent.setup();
    render(<Drawer open onClose={noop} title="Settings"><input aria-label="Name" /><button>Apply</button></Drawer>);
    const dialog = screen.queryByRole("dialog");
    expect(dialog).not.toBeNull();
    const close = within(dialog!).getByRole("button", { name: /close/i });
    const input = within(dialog!).getByRole("textbox", { name: "Name" });
    const apply = within(dialog!).getByRole("button", { name: "Apply" });
    expect(document.activeElement).toBe(close);
    await user.tab();
    expect(document.activeElement).toBe(input);
    await user.tab();
    expect(document.activeElement).toBe(apply);
    await user.tab();
    expect(document.activeElement).toBe(close);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(apply);
  });

  it("ignores hidden controls when trapping focus", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <button>Outside</button>
        <Drawer open onClose={noop} title="Settings">
          <input aria-label="Name" />
          <button hidden>Hidden action</button>
          <label className="btn small file">Load<input type="file" aria-label="Capture file" style={{ display: "none" }} /></label>
        </Drawer>
      </div>,
    );
    const dialog = screen.getByRole("dialog");
    const close = within(dialog).getByRole("button", { name: /close/i });
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    expect(document.activeElement).toBe(close);
    await user.tab();
    expect(document.activeElement).toBe(name);
    await user.tab();
    expect(document.activeElement).toBe(close);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(name);
  });

  it("keeps Shift+Tab inside when the panel itself is focused", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <button>Outside</button>
        <Drawer open onClose={noop} title="Settings"><button>Apply</button></Drawer>
      </div>,
    );
    const dialog = screen.getByRole("dialog");
    dialog.focus();
    expect(document.activeElement).toBe(dialog);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Apply" }));
    dialog.focus();
    await user.tab();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: /close/i }));
  });

  it("locks body scroll while open and restores it on close", async () => {
    const user = userEvent.setup();
    render(<DrawerFixture />);
    expect(document.body.style.overflow).toBe("");
    await user.click(screen.getByRole("button", { name: "Open settings" }));
    expect(document.body.style.overflow).toBe("hidden");
    await user.keyboard("{Escape}");
    expect(document.body.style.overflow).toBe("");
  });

  it("renders an optional footer and honours the width and className props", () => {
    render(<Drawer open onClose={noop} title="Settings" width={520} className="drawer-wide" footer={<button>Save</button>}><p>Body</p></Drawer>);
    const dialog = screen.queryByRole("dialog");
    expect(dialog).not.toBeNull();
    expect(within(dialog!).getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(dialog).toHaveStyle({ width: "520px" });
    expect(dialog).toHaveClass("drawer", "drawer-wide");
  });

  it("keeps the legacy .drawer-backdrop / .drawer class names", () => {
    const { container } = render(<Drawer open onClose={noop} title="Settings"><p>Body</p></Drawer>);
    expect(container.querySelector(".drawer-backdrop > .drawer[role='dialog']")).not.toBeNull();
  });
});

describe("stylesheet: transition state keeps text contrast", () => {
  const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  /**
   * Animating any of these blends text against its background for the duration of the transition
   * (a theme switch cross-fades them in opposite directions). Border colours never touch text contrast.
   * "all" and the "background" shorthand are listed because they include the colour properties.
   */
  const COLOUR_PROPS = new Set(["color", "background-color", "background", "opacity", "fill", "stroke", "all"]);
  /** Innermost `selector { body }` pairs, so rules nested inside @media blocks are included. */
  const rules = [...css.matchAll(/([^{};]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim().replace(/\s+/g, " "), body: m[2] }));
  /** Every @keyframes block (handles the nested from/to/percentage braces). */
  function keyframeBlocks(): { name: string; body: string }[] {
    const blocks: { name: string; body: string }[] = [];
    for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
      const start = (m.index ?? 0) + m[0].length;
      let depth = 1;
      let i = start;
      for (; i < css.length && depth > 0; i++) {
        if (css[i] === "{") depth++;
        else if (css[i] === "}") depth--;
      }
      blocks.push({ name: m[1], body: css.slice(start, i - 1) });
    }
    return blocks;
  }

  it("never transitions a colour-affecting property on any element (theme switch, hover, pressed)", () => {
    const declarations: { selector: string; value: string }[] = [];
    for (const rule of rules) {
      for (const m of rule.body.matchAll(/(?:^|;)\s*transition\s*:\s*([^;]+)/g)) declarations.push({ selector: rule.selector, value: m[1].trim() });
    }
    expect(declarations.length, "the stylesheet is expected to declare at least one transition").toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const d of declarations) {
      for (const item of d.value.split(",")) {
        const property = item.trim().split(/\s+/)[0]; // exact first token: "border-color" must not be mistaken for "color"
        if (COLOUR_PROPS.has(property)) offenders.push(`${d.selector} → ${property}`);
      }
    }
    expect(offenders, "text must keep its contrast at every frame while controls re-colour").toEqual([]);
  });

  it("never animates a colour-affecting property in a @keyframes block", () => {
    const blocks = keyframeBlocks();
    expect(blocks.map((b) => b.name)).toContain("drawer-in");
    const offenders: string[] = [];
    for (const b of blocks) {
      for (const m of b.body.matchAll(/([a-z-]+)\s*:/g)) if (COLOUR_PROPS.has(m[1])) offenders.push(`@keyframes ${b.name} → ${m[1]}`);
    }
    expect(offenders).toEqual([]);
  });

  it("slides the drawer in without fading its content", () => {
    // The keyframes block is a precondition: the slide-in stays.
    const block = css.match(/@keyframes\s+drawer-in\s*\{([\s\S]*?)\}\s*\}/);
    expect(block, "the drawer-in keyframes block must exist").not.toBeNull();
    const body = block![1];
    expect(body).toMatch(/transform\s*:/);
    // A fade makes every label semi-transparent mid-animation, so a contrast scan that starts as soon as
    // the dialog is visible sees blended colours. Dialog text must keep its contrast at every frame.
    expect(body, "dialog text must keep its contrast at every animation frame").not.toMatch(/opacity\s*:/);
  });

  it("does not fade the drawer or its backdrop through a transition either", () => {
    const drawerRules = css.match(/^\.drawer(?:-backdrop)?\s*\{[^}]*\}/gm) ?? [];
    expect(drawerRules.length).toBeGreaterThanOrEqual(2);
    for (const rule of drawerRules) expect(rule).not.toMatch(/opacity|transition/);
  });
});

describe("Notice", () => {
  it('uses role="alert" for errors', () => {
    render(<Notice kind="error">Boom</Notice>);
    const el = screen.getByText("Boom");
    expect(el).toHaveAttribute("role", "alert");
    expect(el).toHaveClass("notice", "notice-error");
  });

  it('uses role="status" for info, warning and success', () => {
    for (const kind of ["info", "warning", "success"] as const) {
      const { unmount } = render(<Notice kind={kind}>{`msg-${kind}`}</Notice>);
      const el = screen.getByText(`msg-${kind}`);
      expect(el).toHaveAttribute("role", "status");
      expect(el).toHaveClass("notice", `notice-${kind}`);
      unmount();
    }
  });
});

describe("VisuallyHidden", () => {
  it("renders screen-reader-only text", () => {
    render(<VisuallyHidden>Hidden label</VisuallyHidden>);
    expect(screen.getByText("Hidden label")).toHaveClass("visually-hidden");
  });
});

describe("fmtTime", () => {
  it("formats in IST by default", () => {
    expect(fmtTime("2026-09-23T12:00:00Z", false)).toBe("17:30");
    expect(fmtTime("2026-09-23T12:00:00Z")).toContain("17:30");
  });

  it("accepts a time zone as third argument", () => {
    expect(fmtTime("2026-09-23T12:00:00Z", false, "UTC")).toBe("12:00");
    const withDate = fmtTime("2026-09-23T12:00:00Z", true, "UTC");
    expect(withDate).toContain("12:00");
    expect(withDate).toMatch(/23 Sep/);
    expect(fmtTime(Date.parse("2026-09-23T12:00:00Z"), false, "Europe/London")).toBe("13:00");
  });
});

describe("stable primitives", () => {
  it("badges keep their class names and labels", () => {
    render(<><SeverityBadge s="Critical" /><LevelBadge level="warning" /><StateBadge s="acknowledged" /></>);
    expect(screen.getByText("Critical")).toHaveClass("badge", "sev-critical");
    expect(screen.getByText("Warning")).toHaveClass("badge", "lvl-warning");
    expect(screen.getByText("acknowledged")).toHaveClass("badge", "state-acknowledged");
  });

  it("Card renders a section with an h2 title and actions; Empty renders the text", () => {
    render(<Card title="Alarms" actions={<button>Export</button>}><Empty text="Nothing here" /></Card>);
    expect(screen.getByRole("heading", { level: 2, name: "Alarms" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export" })).toBeInTheDocument();
    expect(screen.getByText("Nothing here")).toHaveClass("empty");
  });
});
