import { afterEach, expect, test } from "bun:test";

import { renderToStaticMarkup } from "react-dom/server";

import { ThemePicker } from "@/components/theme-picker";
import { ThemeProvider } from "@/components/theme-provider";
import { restoreLocalStorage, stubLocalStorage } from "@/test-utils";

afterEach(restoreLocalStorage);

function render(stored: Record<string, string> = {}) {
  stubLocalStorage(stored);
  return renderToStaticMarkup(
    <ThemeProvider>
      <ThemePicker />
    </ThemeProvider>,
  );
}

test("ThemePicker shows the default palette and a labelled trigger", () => {
  const html = render();
  expect(html).toContain('aria-label="Color theme"');
  expect(html).toContain("Stage");
});

test("ThemePicker shows the saved palette", () => {
  expect(render({ palette: "violet" })).toContain("Violet");
  expect(render({ palette: "mono" })).toContain("Mono");
});

test("ThemePicker falls back to the default for an unknown saved palette", () => {
  const html = render({ palette: "neon" });
  expect(html).toContain("Stage");
  expect(html).not.toContain("neon");
});
