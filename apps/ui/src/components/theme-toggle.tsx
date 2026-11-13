import { Monitor, Moon, Sun } from "lucide-react";

import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";

const options = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const;

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <div role="group" aria-label="Appearance" className="flex rounded-lg border p-0.5">
      {options.map(({ value, label, icon: Icon }) => (
        <Button
          key={value}
          variant={theme === value ? "secondary" : "ghost"}
          size="xs"
          aria-label={`${label} theme`}
          aria-pressed={theme === value}
          title={`${label} theme`}
          onClick={() => setTheme(value)}
        >
          <Icon />
          <span className="hidden sm:inline">{label}</span>
        </Button>
      ))}
    </div>
  );
}
