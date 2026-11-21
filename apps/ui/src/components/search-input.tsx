import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";

// The list search box; `data-search` lets the "/" shortcut in the shell focus it.
export function SearchInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="relative w-64 max-w-full">
      <Search className="absolute top-2 left-2.5 size-4 text-muted-foreground" />
      <Input
        data-search
        aria-label={label}
        aria-keyshortcuts="/"
        placeholder={`${label}…`}
        className="pr-8 pl-8"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {!value && (
        <kbd
          aria-hidden
          className="pointer-events-none absolute top-1.5 right-2 hidden rounded border px-1.5 text-xs text-muted-foreground md:block"
        >
          /
        </kbd>
      )}
    </div>
  );
}
