import { ChevronDown, Type } from "lucide-react";

import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fonts, isFontId } from "@/lib/fonts";

// Load every font when the menu opens, so each name can be shown in its own typeface.
const preload = (open: boolean) => {
  if (open) for (const font of fonts) void font.load();
};

export function FontPicker() {
  const { font, setFont } = useTheme();
  const current = fonts.find(({ id }) => id === font);
  if (fonts.length < 2) return null; // nothing to choose yet; shows up when a second font is added
  return (
    <DropdownMenu onOpenChange={preload}>
      <div className="flex rounded-lg border p-0.5">
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="xs" aria-label="Font" className="max-md:h-8" />}
        >
          <Type />
          <span className="hidden sm:inline">{current?.label}</span>
          <ChevronDown />
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuRadioGroup
          value={font}
          onValueChange={(value) => isFontId(value) && setFont(value)}
        >
          {fonts.map(({ id, label, family }) => (
            <DropdownMenuRadioItem key={id} value={id} style={{ fontFamily: family }}>
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
