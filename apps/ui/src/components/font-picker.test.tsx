import { afterEach, expect, test } from "bun:test";

import { renderToStaticMarkup } from "react-dom/server";

import { FontPicker } from "@/components/font-picker";
import { ThemeProvider } from "@/components/theme-provider";
import { restoreLocalStorage, stubLocalStorage } from "@/test-utils";

afterEach(restoreLocalStorage);

function render(stored: Record<string, string> = {}) {
  stubLocalStorage(stored);
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
