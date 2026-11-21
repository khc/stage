// Color themes. Each id has a matching `src/themes/<id>.css` that defines every color token.
export const palettes = [
  { id: "stage", label: "Stage" },
  { id: "violet", label: "Violet" },
  { id: "mono", label: "Mono" },
] as const;

export type Palette = (typeof palettes)[number]["id"];

// The default palette also owns the :root / .dark fallback in its CSS file, so it applies before data-palette is set.
export const defaultPalette: Palette = "stage";

export const isPalette = (value: string | null): value is Palette =>
  palettes.some((palette) => palette.id === value);
