import * as React from "react";

import { defaultFont, fonts, isFontId, type FontId } from "@/lib/fonts";
import { defaultPalette, isPalette, type Palette } from "@/lib/palettes";

type Theme = "dark" | "light" | "system";
type ResolvedTheme = "dark" | "light";

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
  disableTransitionOnChange?: boolean;
};

type ThemeProviderState = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  palette: Palette;
  setPalette: (palette: Palette) => void;
  font: FontId;
  setFont: (font: FontId) => void;
};

const COLOR_SCHEME_QUERY = "(prefers-color-scheme: dark)";
const THEME_VALUES = new Set<string>(["dark", "light", "system"]);

const ThemeProviderContext = React.createContext<ThemeProviderState | undefined>(undefined);

function isTheme(value: string | null): value is Theme {
  if (value === null) {
    return false;
  }

  return THEME_VALUES.has(value);
}

function getSystemTheme(): ResolvedTheme {
  if (window.matchMedia(COLOR_SCHEME_QUERY).matches) {
    return "dark";
  }

  return "light";
}

function disableTransitionsTemporarily() {
  const style = document.createElement("style");
  style.appendChild(
    document.createTextNode(
      "*,*::before,*::after{-webkit-transition:none!important;transition:none!important}",
    ),
  );
  document.head.appendChild(style);

  return () => {
    window.getComputedStyle(document.body);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        style.remove();
      });
    });
  };
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  const editableParent = target.closest("input, textarea, select, [contenteditable='true']");
  if (editableParent) {
    return true;
  }

  return false;
}

// A saved choice (palette, font) that stays in sync across tabs and falls back when the value is unknown.
function useStoredChoice<T extends string>(
  key: string,
  isValid: (value: string | null) => value is T,
  fallback: T,
) {
  const [value, setValue] = React.useState<T>(() => {
    const stored = localStorage.getItem(key);
    return isValid(stored) ? stored : fallback;
  });

  const set = React.useCallback(
    (next: T) => {
      localStorage.setItem(key, next);
      setValue(next);
    },
    [key],
  );

  React.useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea !== localStorage || event.key !== key) return;
      setValue(isValid(event.newValue) ? event.newValue : fallback);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [key, isValid, fallback]);

  return [value, set] as const;
}

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = "theme",
  disableTransitionOnChange = true,
  ...props
}: ThemeProviderProps) {
  const [theme, setThemeState] = React.useState<Theme>(() => {
    const storedTheme = localStorage.getItem(storageKey);
    if (isTheme(storedTheme)) {
      return storedTheme;
    }

    return defaultTheme;
  });

  const [palette, setPalette] = useStoredChoice("palette", isPalette, defaultPalette);
  const [font, setFont] = useStoredChoice("font", isFontId, defaultFont);

  React.useEffect(() => {
    document.documentElement.dataset.palette = palette;
  }, [palette]);

  // Load the chosen font first, so text never falls back to a stand-in while it downloads.
  React.useEffect(() => {
    let cancelled = false;
    const chosen = fonts.find(({ id }) => id === font);
    void (async () => {
      await chosen?.load();
      if (chosen && !cancelled)
        document.documentElement.style.setProperty("--app-font", chosen.family);
    })();
    return () => {
      cancelled = true;
    };
  }, [font]);

  const setTheme = React.useCallback(
    (nextTheme: Theme) => {
      localStorage.setItem(storageKey, nextTheme);
      setThemeState(nextTheme);
    },
    [storageKey],
  );

  const applyTheme = React.useCallback(
    (nextTheme: Theme) => {
      const root = document.documentElement;
      const resolvedTheme = nextTheme === "system" ? getSystemTheme() : nextTheme;
      const restoreTransitions = disableTransitionOnChange ? disableTransitionsTemporarily() : null;

      root.classList.remove("light", "dark");
      root.classList.add(resolvedTheme);

      if (restoreTransitions) {
        restoreTransitions();
      }
    },
    [disableTransitionOnChange],
  );

  React.useEffect(() => {
    applyTheme(theme);

    if (theme !== "system") {
      return undefined;
    }

    const mediaQuery = window.matchMedia(COLOR_SCHEME_QUERY);
    const handleChange = () => {
      applyTheme("system");
    };

    mediaQuery.addEventListener("change", handleChange);

    return () => {
      mediaQuery.removeEventListener("change", handleChange);
    };
  }, [theme, applyTheme]);

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) {
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      if (isEditableTarget(event.target)) {
        return;
      }

      if (event.key.toLowerCase() !== "d") {
        return;
      }

      setThemeState((currentTheme) => {
        const nextTheme =
          currentTheme === "dark"
            ? "light"
            : currentTheme === "light"
              ? "dark"
              : getSystemTheme() === "dark"
                ? "light"
                : "dark";

        localStorage.setItem(storageKey, nextTheme);
        return nextTheme;
      });
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [storageKey]);

  React.useEffect(() => {
    const handleStorageChange = (event: StorageEvent) => {
      if (event.storageArea !== localStorage) {
        return;
      }

      if (event.key !== storageKey) {
        return;
      }

      if (isTheme(event.newValue)) {
        setThemeState(event.newValue);
        return;
      }

      setThemeState(defaultTheme);
    };

    window.addEventListener("storage", handleStorageChange);

    return () => {
      window.removeEventListener("storage", handleStorageChange);
    };
  }, [defaultTheme, storageKey]);

  const value = React.useMemo(
    () => ({
      theme,
      setTheme,
      palette,
      setPalette,
      font,
      setFont,
    }),
    [theme, setTheme, palette, setPalette, font, setFont],
  );

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export const useTheme = () => {
  const context = React.useContext(ThemeProviderContext);

  if (context === undefined) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }

  return context;
};
