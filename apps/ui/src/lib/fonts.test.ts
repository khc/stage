import { expect, test } from "bun:test";

import { defaultFont, fonts, isFontId } from "./fonts";

test("font ids are unique and include the default", () => {
  const ids = fonts.map(({ id }) => id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(isFontId(defaultFont)).toBe(true);
  expect(isFontId("comic-sans")).toBe(false);
  expect(isFontId(null)).toBe(false);
});

test("each font family matches the @font-face name in its package", async () => {
  for (const { id, family } of fonts) {
    const css = await Bun.file(
      new URL(`../../node_modules/@fontsource-variable/${id}/index.css`, import.meta.url),
    ).text();
    expect(css, id).toContain(`font-family: '${family.split('"')[1]}'`);
  }
});

test("the default font is the one index.css imports and falls back to", async () => {
  const css = await Bun.file(new URL("../index.css", import.meta.url)).text();
  expect(css).toContain(`@import "@fontsource-variable/${defaultFont}";`);
});
