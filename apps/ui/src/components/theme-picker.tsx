import { ChevronDown } from "lucide-react";

import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isPalette, palettes, type Palette } from "@/lib/palettes";

// Scoping data-palette on the swatch makes it use that palette's tokens, whatever theme is active.
function Swatches({ palette }: { palette: Palette }) {
  return (
    <span data-palette={palette} aria-hidden className="flex gap-0.5">
      {["bg-primary", "bg-chart-3", "bg-chart-4", "bg-chart-5"].map((color) => (
        <i key={color} className={`size-2.5 rounded-full ${color}`} />
      ))}
    </span>
  );
}

export function ThemePicker() {
  const { palette, setPalette } = useTheme();
  const current = palettes.find(({ id }) => id === palette);
  return (
    <DropdownMenu>
      <div className="flex rounded-lg border p-0.5">
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="xs" aria-label="Color theme" className="max-md:h-8" />
          }
        >
          <Swatches palette={palette} />
          <span className="hidden sm:inline">{current?.label}</span>
          <ChevronDown />
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuRadioGroup
          value={palette}
          onValueChange={(value) => isPalette(value) && setPalette(value)}
        >
          {palettes.map(({ id, label }) => (
            <DropdownMenuRadioItem key={id} value={id}>
              <Swatches palette={id} />
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
