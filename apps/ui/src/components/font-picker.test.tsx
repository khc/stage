import { afterEach, expect, test } from "bun:test";

import { renderToStaticMarkup } from "react-dom/server";

import { FontPicker } from "@/components/font-picker";
import { ThemeProvider } from "@/components/theme-provider";

const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
afterEach(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

function render(stored: Record<string, string> = {}) {
  const store = new Map(Object.entries(stored));
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => store.get(key) ?? null, setItem: () => {} },
  });
  return renderToStaticMarkup(
    <ThemeProvider>
      <FontPicker />
    </ThemeProvider>,
  );
}

test("FontPicker renders nothing while there is only one font to choose", () => {
  expect(render()).toBe("");
  expect(render({ font: "comic-sans" })).toBe("");
});
