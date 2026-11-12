import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  createThemeController,
  normalizePreference,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "./theme";

export function ThemeSwitch() {
  const [preference, setPreference] = useState<ThemePreference>(() =>
    normalizePreference(document.documentElement.dataset.themePreference),
  );
  const controller = useRef<ReturnType<typeof createThemeController> | null>(null);
  useEffect(() => {
    let storage: Storage | undefined;
    try {
      storage = window.localStorage;
    } catch {
      /* Use a page-local preference when storage is blocked. */
    }
    const manager = createThemeController({
      storage,
      media: window.matchMedia("(prefers-color-scheme: dark)"),
      onChange: (preference) => {
        document.documentElement.dataset.themePreference = preference;
        setPreference(preference);
      },
      apply: (theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.colorScheme = theme;
        document
          .querySelector('meta[name="theme-color"]')
          ?.setAttribute("content", theme === "dark" ? "#0b0d14" : "#f6f7fb");
      },
    });
    controller.current = manager;
    setPreference(manager.getPreference());
    const sync = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY || event.key === null)
        manager.setPreference(normalizePreference(event.newValue), false);
    };
    window.addEventListener("storage", sync);
    return () => {
      manager.destroy();
      controller.current = null;
      window.removeEventListener("storage", sync);
    };
  }, []);
  return (
    <div className="theme-switch" role="group" aria-label="Appearance">
      {(
        [
          { value: "light", label: "Light", icon: Sun },
          { value: "dark", label: "Dark", icon: Moon },
          { value: "system", label: "System", icon: Monitor },
        ] as const
      ).map((option) => (
        <button
          key={option.value}
          type="button"
          aria-label={`${option.label} theme`}
          aria-pressed={preference === option.value}
          title={`${option.label} theme`}
          onClick={() => controller.current?.setPreference(option.value)}
        >
          <option.icon size={13} />
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}
