import { expect, test } from "bun:test";

import { defaultPalette, palettes } from "./palettes";

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();
const tokens = (block: string) => [...block.matchAll(/--([a-z0-9-]+):/g)].map((match) => match[1]!);
const rules = (css: string) => css.split("}").filter((part) => part.includes("{"));

const themes = await Promise.all(
  palettes.map(async ({ id }) => ({ id, css: await read(`../themes/${id}.css`) })),
);

test("every palette file defines a light and a dark block with the same tokens", () => {
  for (const { id, css } of themes) {
    const [light, dark, ...rest] = rules(css);
    expect(rest, id).toEqual([]);
    expect(light, id).toContain(`[data-palette="${id}"]`);
    expect(dark, id).toContain(`.dark[data-palette="${id}"]`);
    expect(tokens(dark!).sort(), id).toEqual(tokens(light!).sort());
  }
});

test("all palettes define the same set of tokens", () => {
  const [first, ...others] = themes.map(({ css }) => tokens(rules(css)[0]!).sort());
  for (const other of others) expect(other).toEqual(first!);
});

test("palettes leave the shared status colors and radius to index.css", () => {
  for (const { id, css } of themes) {
    expect(
      tokens(css).filter((token) => /^(destructive|success|warning|radius)$/.test(token)),
      id,
    ).toEqual([]);
  }
});

test("only the default palette owns the :root and .dark fallback", () => {
  for (const { id, css } of themes) {
    const [light, dark] = rules(css);
    const owns = /(^|\n):root,/.test(light!) && /(^|\n)\.dark,/.test(dark!);
    expect(owns, id).toBe(id === defaultPalette);
  }
});

test("index.css imports the default palette first", async () => {
  const index = await read("../index.css");
  const imports = [...index.matchAll(/@import "\.\/themes\/([a-z]+)\.css";/g)].map((m) => m[1]);
  expect(imports[0]).toBe(defaultPalette);
});

test("index.css imports every palette file", async () => {
  const index = await read("../index.css");
  for (const { id } of palettes) expect(index).toContain(`@import "./themes/${id}.css";`);
});
