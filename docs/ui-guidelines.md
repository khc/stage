# UI/UX build rules

Rules for building and changing `apps/ui`. They record how the UI is built after the AI Elements rebuild, so a new screen looks and behaves like the existing ones. When a rule and the code disagree, fix whichever is wrong in the same change.

## Stack

- React SPA on Vite, TanStack Router and Query, Tailwind 4, shadcn/ui (`base-nova`, built on `@base-ui/react`, not Radix) and lucide icons.
- Add a shadcn component with `bunx --bun shadcn@latest add <name>` from `apps/ui`. The CLI asks before overwriting; it reformats existing files but does not change behavior, so check `git diff -w` after it runs.
- shadcn files in `src/components/ui/` are generated. Edit them only for a fix every screen needs, and say so in the commit.
- Do not add another component or table library. Use what is in `src/components/ui/` before writing markup by hand.

## Where things live

| What                        | Where                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| shadcn primitives           | `src/components/ui/`                                                                                  |
| Shared composed pieces      | `src/components/` (`states.tsx`, `data-table.tsx`, `agent-trace.tsx`, `search-input.tsx`, `pane.tsx`) |
| A screen and its parts      | `src/features/<feature>/`, files named in kebab-case                                                  |
| Route tree, shell, Overview | `src/router.tsx`                                                                                      |
| API client and types        | `src/lib/api.ts` (types come from the service through Eden; do not retype them)                       |
| Server state                | `src/lib/queries.ts` and TanStack Query                                                               |

A component used by two features moves to `src/components/`. Tests sit next to the file and end in `.test.ts(x)`.

## Layout

- Every page inside the shell has one `<h1>` (the page title). The Assistant uses its conversation title. Do not add a second `<main>`: `SidebarInset` already renders it.
- A list page is a `Card` with a header (icon, title, count `Badge`, `SearchInput`), a body and a `CardFooter`.
- A list page's create action is a filled button in the card header next to the search (Tasks: New task, Providers: Add provider); the page header holds only Refresh. Jobs keeps the page-level New task because its rows create tasks per job.
- The footer is always the same: a count on the left, how the data stays fresh on the right (see Lists).
- The Assistant is the one full-height page. It has no page header or footer and owns its scrolling.
- Details open in a `Sheet` (task, job) and creation in a `Dialog`. State that decides what is open lives in the URL (`/tasks/$taskId`, `?job=`, `?new=`), through `useNav`.
- Pane headers use `PaneHeader`, `PaneTabsList` and `PaneTab` so task and job panes match.

## Lists and tables

- A list of records is a Data Table: TanStack Table v9 with the shared `features` from `components/data-table.tsx`, rendered with the shadcn `Table`.
- Make Task/Job/Name-style columns sortable with `SortHeader`, and set `aria-sort` through `ariaSort`.
- Search is a `SearchInput` bound to the table's global filter. It must keep the `data-search` attribute so `/` focuses it.
- Page with `TablePagination` (10 rows). A summary on the Overview passes `limit` and links to the full list instead of paging.
- Children (sub-tasks) are table sub-rows, collapsed by default and opened by a search.
- A row can be clicked as a mouse shortcut, but it must contain one real button or link for the keyboard. Buttons inside the row call `stopPropagation`.
- Hide secondary columns below `md` and fold their content into the first cell's subtitle.
- The first cell of a record shows an icon, its name and one line of detail: an `Item` for jobs, a title with the prompt underneath for tasks.
- Footer left text: `N of M <things> shown`, or `N matching` while a search is active. Right text: `Live updates` only if the list is fed by the event stream, otherwise `Refreshes every 15 seconds`. Never claim live updates the query does not have.
- Every list has the same four states, built from `states.tsx`: `Loading`, `ErrorBox` with retry, `Empty` for no data (with the create action if there is one) and `Empty` for no search match.

## Agent output (chat and sessions)

Anything an agent does is shown with the AI Elements patterns, built on `Trace`. Use the helpers in `agent-trace.tsx`; do not hand-roll a new disclosure.

- Thinking: `ReasoningTrace`. Tool call: `ToolTrace`. A tool named `<job>__<agent>` is a delegation: `SubagentTrace`.
- Arguments and results are shown in a `CodeBlock` (`JsonCode`), never as raw colored JSON. Plain text results are shown as text or Markdown.
- Running steps use the `running` status (shimmer), not a custom spinner. Failed ones use `error`.
- Messages are `Message` with a `Bubble`; the thread is a `MessageScroller`.
- The prompt input is an `InputGroup` with a textarea, `Attachment` chips, a `+` attach button, the agent picker as a radio `DropdownMenu` and a round send button. Enter sends and Shift+Enter adds a line; show the hint with `Kbd`.
- The empty thread uses `Empty` and one-click starter prompts as outline `Button`s.
- The model for a message is chosen with `ModelPicker` (`features/models/model-picker.tsx`) beside the send button, preselected to the task's default model. A change in a session that already has messages asks for confirmation first, because the whole conversation is re-sent to the new model.
- Keep a new agent step type in `agent-trace.tsx` so the chat and the task session render it the same way.

## Visual rules

- Colors come from tokens: `primary`, `muted`, `destructive`, `success`, `warning` and so on. Do not use raw Tailwind palette colors (`emerald-500`) for meaning. The JSON tree's syntax colors are the only exception.
- Color themes live in `src/themes/<id>.css`, one file per palette (`stage`, `violet`, `mono`), chosen with `data-palette` on `<html>` by the theme picker. Each file defines the same tokens in a light block and a `.dark` block; `src/lib/palettes.test.ts` fails when a token is missing. `stage` is the default: its file also owns the `:root` and `.dark` fallback and is imported first. To add a theme, copy a file, add its id to `src/lib/palettes.ts` and import it in `src/index.css`.
- Status colors (`destructive`, `success`, `warning`) and `--radius` are shared and stay in `src/index.css`. Add a new status color there with light and dark values, then map it in `@theme inline`. Add a new theme token to every palette file.
- Keep muted text at 4.5:1 in every palette. `violet` (the original theme) has a few pairs just under that; fix them when you next touch it.
- Use the Tailwind type scale (`text-xs`, `text-sm`, `text-base`). No `text-[13px]`.
- Truncate single lines with `truncate` (with `min-w-0` on every flex parent), not `line-clamp-1`.
- Icons are lucide, sized by the component (`size-4`) unless there is a reason.
- The `Stage` wordmark uses `font-display` with `leading-tight` so descenders are not clipped.
- Support light and dark. Check every change in both.

## Interaction

- One primary action per view, filled (`Button` default). Secondary actions are `outline` or `ghost`. Maintenance actions (Register agents) are never the primary.
- Destructive actions use `ConfirmDelete`, sit apart from the primary action and name what will be deleted.
- Every async action shows a pending state (`Spinner` in the button, button disabled) and an outcome: a `toast` for a started action, an inline `role="alert"` message for a failure that stays in the form.
- A disabled action says why: a `title` on a wrapper for pointer users and a reason in the `aria-label` or nearby text. Do not rely on `title` alone.
- Forms: a `Label` for every field, `Required` or `Optional` in the label, a hint line under the field and a submit button that stays disabled until the form is valid, with the reason shown.

## Accessibility

- One `<h1>` per page, headings in order, landmarks not duplicated.
- Every icon-only button has an `aria-label`. Decorative icons and the status dot are `aria-hidden`.
- Controls are at least 28px high on desktop and 44px where touch is the main input: use `max-md:` classes to enlarge sidebar items, copy buttons and toggles.
- Do not convey state by color alone: pair it with text or an icon.
- Keyboard: every action reachable by Tab, visible focus ring (the shadcn default), `Escape` closes sheets and dialogs, `/` focuses search.
- Muted text must keep 4.5:1 contrast against its background in both themes.

## Responsive

- Design for 390px first, then widen. No horizontal page scroll: wide content (tables, code) scrolls inside its own container.
- Below `md`, the sidebar becomes a sheet, secondary table columns hide and row actions stack or shrink.
- Check each page at 390px and at desktop width before finishing.

## Checklist before you finish a UI change

1. `bun run typecheck` (in `apps/ui`), `bun test apps/ui`, `bun run lint` and `bun run format:check` pass.
2. The page works in light and dark, and at 390px.
3. Loading, error, empty and no-match states exist and look right.
4. No new raw colors, arbitrary font sizes or duplicated components.
5. Keyboard path works and nothing is nested-interactive.
6. The browser console shows no errors or warnings.
