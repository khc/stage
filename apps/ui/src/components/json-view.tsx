import { ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

const isContainer = (value: unknown): value is object =>
  typeof value === "object" && value !== null;

function Primitive({ value }: { value: unknown }) {
  if (typeof value === "string")
    return (
      <span className="break-words whitespace-pre-wrap text-emerald-700 dark:text-emerald-400">
        &quot;{value}&quot;
      </span>
    );
  if (typeof value === "number")
    return <span className="text-sky-700 dark:text-sky-400">{value}</span>;
  if (typeof value === "boolean")
    return <span className="text-violet-700 dark:text-violet-400">{String(value)}</span>;
  return <span className="text-muted-foreground italic">null</span>;
}

const Key = ({ name }: { name: string }) => (
  <>
    <span className="text-primary">&quot;{name}&quot;</span>
    <span className="text-muted-foreground">: </span>
  </>
);

function Node({ name, value, comma }: { name?: string; value: unknown; comma: boolean }) {
  const [open, setOpen] = useState(true);
  const trailing = comma ? <span className="text-muted-foreground">,</span> : null;
  if (!isContainer(value))
    return (
      <div>
        {name != null && <Key name={name} />}
        <Primitive value={value} />
        {trailing}
      </div>
    );
  const isArray = Array.isArray(value);
  const entries: [string | undefined, unknown][] = isArray
    ? value.map((item) => [undefined, item])
    : Object.entries(value);
  const [opener, closer] = isArray ? ["[", "]"] : ["{", "}"];
  if (!entries.length)
    return (
      <div>
        {name != null && <Key name={name} />}
        {opener}
        {closer}
        {trailing}
      </div>
    );
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        className="-ml-4 inline-flex items-center rounded text-left hover:bg-muted"
        onClick={() => setOpen(!open)}
      >
        <ChevronRight
          className={cn(
            "mr-1 size-3 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        {name != null && <Key name={name} />}
        <span>{opener}</span>
        {!open && (
          <span className="text-muted-foreground">
            {" "}
            {entries.length} {isArray ? "items" : "keys"} {closer}
            {comma && ","}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="ml-1 border-l border-border pl-3">
            {entries.map(([key, item], i) => (
              <Node key={key ?? i} name={key} value={item} comma={i < entries.length - 1} />
            ))}
          </div>
          <div>
            {closer}
            {trailing}
          </div>
        </>
      )}
    </div>
  );
}

// Renders parsed JSON as a collapsible, syntax-coloured tree.
export function JsonView({ value, className }: { value: unknown; className?: string }): ReactNode {
  return (
    <div className={cn("pl-4 font-mono text-xs leading-relaxed", className)}>
      <Node value={value} comma={false} />
    </div>
  );
}
