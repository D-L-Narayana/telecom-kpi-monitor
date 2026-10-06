import { useTheme, type ThemePref } from "./useTheme";

const OPTIONS: { value: ThemePref; label: string; title: string }[] = [
  { value: "light", label: "Light", title: "Light theme" },
  { value: "dark", label: "Dark", title: "Dark theme" },
  { value: "system", label: "System", title: "Follow the operating system colour scheme" },
];

/** Three-state segmented control (Light / Dark / System) bound to useTheme(). */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <div className="seg" role="group" aria-label="Theme">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          className={theme === o.value ? "active" : ""}
          aria-pressed={theme === o.value}
          title={o.title}
          onClick={() => setTheme(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
