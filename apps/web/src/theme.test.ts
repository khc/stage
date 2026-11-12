import { expect, test } from "bun:test";

import { createThemeController, THEME_STORAGE_KEY } from "./theme";

const setup = (stored: string | null = null, dark = false) => {
  const values = new Map<string, string>();
  if (stored !== null) values.set(THEME_STORAGE_KEY, stored);
  let listener: (() => void) | undefined;
  const applied: string[] = [];
  const media = {
    matches: dark,
    addEventListener: (_type: "change", callback: () => void) => {
      listener = callback;
    },
    removeEventListener: (_type: "change", callback: () => void) => {
      if (listener === callback) listener = undefined;
    },
  };
  const controller = createThemeController({
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
    },
    media,
    apply: (theme) => {
      applied.push(theme);
    },
  });
  return {
    controller,
    applied,
    values,
    changeSystem: (matches: boolean) => {
      media.matches = matches;
      listener?.();
    },
  };
};

test("defaults to system and follows operating system appearance changes", () => {
  const { controller, applied, changeSystem } = setup();
  expect(controller.getPreference()).toBe("system");
  expect(applied.at(-1)).toBe("light");
  changeSystem(true);
  expect(applied.at(-1)).toBe("dark");
  controller.destroy();
  changeSystem(false);
  expect(applied.at(-1)).toBe("dark");
});

test("restores a saved preference and explicit choices ignore system changes", () => {
  const { controller, applied, changeSystem, values } = setup("dark");
  expect(applied.at(-1)).toBe("dark");
  controller.setPreference("light");
  expect(values.get(THEME_STORAGE_KEY)).toBe("light");
  changeSystem(true);
  expect(applied.at(-1)).toBe("light");
  controller.setPreference("system");
  expect(applied.at(-1)).toBe("dark");
  controller.destroy();
});

test("invalid saved preferences fall back to system", () => {
  const { controller, applied } = setup("invalid", true);
  expect(controller.getPreference()).toBe("system");
  expect(applied.at(-1)).toBe("dark");
  controller.destroy();
});

test("can apply cross-tab changes without writing them back to storage", () => {
  const { controller, values } = setup("dark");
  controller.setPreference("light", false);
  expect(controller.getPreference()).toBe("light");
  expect(values.get(THEME_STORAGE_KEY)).toBe("dark");
  controller.destroy();
});

test("storage failures do not prevent changing appearance", () => {
  let current = "";
  const controller = createThemeController({
    storage: {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    },
    media: {
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    apply: (theme) => {
      current = theme;
    },
  });
  controller.setPreference("dark");
  expect(current).toBe("dark");
  controller.destroy();
});
