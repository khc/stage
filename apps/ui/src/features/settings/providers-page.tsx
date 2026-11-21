import { useQueryClient } from "@tanstack/react-query";
import { createColumnHelper, useTable } from "@tanstack/react-table";
import { KeyRound, Pencil, Plus, RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { ConfirmDelete } from "@/components/confirm-delete";
import {
  ariaSort,
  features,
  SortHeader,
  TablePagination,
  type DataTableFeatures,
} from "@/components/data-table";
import { SearchInput } from "@/components/search-input";
import { Empty, ErrorBox, Loading } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api, type Provider, type ProviderKind } from "@/lib/api";
import { useProviders } from "@/lib/queries";

import { ProviderDialog } from "./provider-dialog";

const NAME = "name";
const MOBILE_HIDDEN = new Set(["kind", "status", "models", "key", "baseUrl"]);
const columnHelper = createColumnHelper<DataTableFeatures, Provider>();

const KIND_LABELS: Record<ProviderKind, string> = {
  google: "Google",
  "google-express": "Google Express",
  openai: "OpenAI",
};

export const kindLabel = (kind: ProviderKind) => KIND_LABELS[kind];

export const providerMatches = (provider: Provider, query: string) => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [
    provider.name,
    provider.kind,
    kindLabel(provider.kind),
    provider.defaultModel,
    provider.baseUrl,
    ...(provider.models ?? []),
  ].some((value) => value?.toLowerCase().includes(q));
};

function ProviderIdentity({ provider }: { provider: Provider }) {
  const summary = [
    kindLabel(provider.kind),
    provider.enabled ? "Enabled" : "Disabled",
    provider.defaultModel,
    provider.hasApiKey ? `Key ${provider.apiKeyHint ?? "saved"}` : "No key",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Item size="xs" className="p-0">
      <ItemMedia variant="icon" className="rounded-lg bg-primary/10 p-2 text-primary">
        <KeyRound />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="truncate">{provider.name}</ItemTitle>
        <ItemDescription className="truncate text-xs">
          <span className="md:hidden">{summary}</span>
          <span className="hidden font-mono md:inline">{provider.providerId}</span>
        </ItemDescription>
      </ItemContent>
    </Item>
  );
}

export function ProvidersPage() {
  const queryClient = useQueryClient();
  const providersQuery = useProviders();
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Provider | undefined>(undefined);

  const openCreate = () => {
    setEditing(undefined);
    setDialogOpen(true);
  };
  const openEdit = (provider: Provider) => {
    setEditing(provider);
    setDialogOpen(true);
  };

  const columns = useMemo(
    () =>
      columnHelper.columns([
        columnHelper.accessor("name", {
          id: NAME,
          header: ({ column }) => <SortHeader column={column} title="Provider" />,
          sortFn: "text",
          cell: ({ row }) => <ProviderIdentity provider={row.original} />,
        }),
        columnHelper.accessor((p) => kindLabel(p.kind), {
          id: "kind",
          header: ({ column }) => <SortHeader column={column} title="Type" />,
          sortFn: "text",
          cell: ({ getValue }) => <Badge variant="secondary">{getValue()}</Badge>,
        }),
        columnHelper.accessor((p) => (p.enabled ? "Enabled" : "Disabled"), {
          id: "status",
          header: ({ column }) => <SortHeader column={column} title="Status" />,
          sortFn: "text",
          cell: ({ row }) => (
            <Badge variant={row.original.enabled ? "default" : "outline"}>
              {row.original.enabled ? "Enabled" : "Disabled"}
            </Badge>
          ),
        }),
        columnHelper.accessor((p) => p.defaultModel ?? "", {
          id: "models",
          header: "Models",
          cell: ({ row }) => {
            const { defaultModel, models } = row.original;
            if (!defaultModel && !models?.length)
              return <span className="text-xs text-muted-foreground">Default</span>;
            return (
              <div className="flex flex-col text-xs">
                {defaultModel && <span className="font-mono">{defaultModel}</span>}
                {models?.length ? (
                  <span className="text-muted-foreground">
                    {models.length} model{models.length === 1 ? "" : "s"}
                  </span>
                ) : null}
              </div>
            );
          },
        }),
        columnHelper.display({
          id: "key",
          header: "API key",
          cell: ({ row }) =>
            row.original.hasApiKey ? (
              <Badge variant="outline" className="font-mono">
                {row.original.apiKeyHint ?? "Configured"}
              </Badge>
            ) : (
              <span className="text-xs text-muted-foreground">Not set</span>
            ),
        }),
        columnHelper.accessor((p) => p.baseUrl ?? "", {
          id: "baseUrl",
          header: "Base URL",
          cell: ({ getValue }) =>
            getValue() ? (
              <code className="block max-w-48 truncate text-xs text-muted-foreground">
                {getValue()}
              </code>
            ) : (
              <span className="text-xs text-muted-foreground">Default</span>
            ),
        }),
        columnHelper.display({
          id: "actions",
          header: () => <span className="sr-only">Actions</span>,
          cell: ({ row }) => {
            const item = row.original;
            return (
              <div className="flex items-center justify-end gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Edit ${item.name}`}
                  onClick={() => openEdit(item)}
                >
                  <Pencil />
                  <span className="max-md:hidden">Edit</span>
                </Button>
                <ConfirmDelete
                  label={`Delete ${item.name}`}
                  question={`Delete provider "${item.name}"? Its saved configuration and API key will be removed.`}
                  remove={() => api.deleteProvider(item.providerId)}
                  onDeleted={() => {
                    void queryClient.invalidateQueries({ queryKey: ["providers"] });
                    toast.success("Provider deleted");
                  }}
                />
              </div>
            );
          },
        }),
      ]),
    [queryClient],
  );

  const data = providersQuery.data?.providers ?? [];
  const table = useTable({
    features,
    data,
    columns,
    getRowId: (row) => row.providerId,
    globalFilterFn: (row, _columnId, query: string) => providerMatches(row.original, query),
    getColumnCanGlobalFilter: (column) => column.id === NAME,
    state: { globalFilter: search },
    initialState: { pagination: { pageIndex: 0, pageSize: 10 } },
  });
  const rows = table.getRowModel().rows;

  return (
    <>
      <Card className="gap-0">
        <CardHeader className="flex flex-wrap items-center justify-between gap-2 pb-4">
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4" />
            Configured providers
            {providersQuery.data && <Badge variant="secondary">{data.length}</Badge>}
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput label="Search providers" value={search} onChange={setSearch} />
            <Button onClick={openCreate}>
              <Plus />
              Add provider
            </Button>
          </div>
        </CardHeader>
        <CardContent className="px-0">
          {providersQuery.isPending ? (
            <Loading label="Loading providers…" />
          ) : providersQuery.isError ? (
            <div className="px-4">
              <ErrorBox error={providersQuery.error} retry={() => void providersQuery.refetch()} />
            </div>
          ) : !data.length ? (
            <Empty
              icon={<KeyRound />}
              title="No providers configured"
              action={
                <Button size="sm" onClick={openCreate}>
                  <Plus />
                  Add provider
                </Button>
              }
            >
              Add Google or OpenAI credentials to configure model providers for this workspace.
            </Empty>
          ) : !rows.length ? (
            <Empty icon={<Search />} title="No matching providers">
              Try another provider name, type, or model ID.
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                {table.getHeaderGroups().map((group) => (
                  <TableRow key={group.id}>
                    {group.headers.map((header) => (
                      <TableHead
                        key={header.id}
                        aria-sort={ariaSort(header.column.getIsSorted())}
                        className={
                          MOBILE_HIDDEN.has(header.column.id)
                            ? "hidden md:table-cell"
                            : header.column.id === NAME
                              ? "pl-4"
                              : "pr-4"
                        }
                      >
                        {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getAllCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        className={
                          MOBILE_HIDDEN.has(cell.column.id)
                            ? "hidden md:table-cell"
                            : cell.column.id === NAME
                              ? "max-w-xs pl-4"
                              : "pr-4"
                        }
                      >
                        <table.FlexRender cell={cell} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
        <CardFooter className="flex-wrap justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {providersQuery.data
              ? search
                ? `${rows.length} matching`
                : `${rows.length} of ${data.length} providers shown`
              : "Provider settings"}
          </span>
          <TablePagination table={table} />
          <span className="flex items-center gap-1">
            <RefreshCw className="size-3" />
            Refreshes every 15 seconds
          </span>
        </CardFooter>
      </Card>

      <ProviderDialog open={dialogOpen} provider={editing} onOpenChange={setDialogOpen} />
    </>
  );
}
