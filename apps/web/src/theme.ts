export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";
export const THEME_STORAGE_KEY = "agent-jobs-theme";
export const normalizePreference = (value: unknown): ThemePreference =>
  value === "light" || value === "dark" ? value : "system";

type ThemeStorage = Pick<Storage, "getItem" | "setItem">;
type ThemeMedia = {
  matches: boolean;
  addEventListener: (type: "change", listener: () => void) => void;
  removeEventListener: (type: "change", listener: () => void) => void;
};
export function createThemeController({
  storage,
  media,
  apply,
  onChange,
}: {
  storage?: ThemeStorage;
  media: ThemeMedia;
  apply: (theme: ResolvedTheme) => void;
  onChange?: (preference: ThemePreference) => void;
}) {
  let preference: ThemePreference = "system";
  try {
    preference = normalizePreference(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    /* Storage can be disabled by browser settings. */
  }
  const update = () =>
    apply(preference === "system" ? (media.matches ? "dark" : "light") : preference);
  update();
  media.addEventListener("change", update);
  return {
    getPreference: () => preference,
    setPreference(next: ThemePreference, persist = true) {
      preference = next;
      if (persist) {
        try {
          storage?.setItem(THEME_STORAGE_KEY, next);
        } catch {
          /* Keep the choice for this page even if persistence is unavailable. */
        }
      }
      update();
      onChange?.(next);
    },
    destroy: () => media.removeEventListener("change", update),
  };
}
