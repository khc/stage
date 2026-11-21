// UI fonts. Self-hosted through @fontsource-variable, loaded on demand, so picking one never calls a third party.
// To add one: `bun add @fontsource-variable/<id>`, then add a line here. The id is the package name.
type Font = {
  id: string;
  label: string;
  /** CSS font-family value, matching the @font-face name in the package. */
  family: string;
  load: () => Promise<unknown>;
};

const stack = (name: string) => `"${name} Variable", sans-serif`;

export const fonts = [
  {
    id: "plus-jakarta-sans",
    label: "Plus Jakarta Sans",
    family: stack("Plus Jakarta Sans"),
    load: () => import("@fontsource-variable/plus-jakarta-sans/index.css"),
  },
] as const satisfies readonly Font[];

export type FontId = (typeof fonts)[number]["id"];

export const defaultFont: FontId = "plus-jakarta-sans";

export const isFontId = (value: string | null): value is FontId =>
  fonts.some((font) => font.id === value);
