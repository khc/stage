import { expect, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";

import { ConfirmDelete } from "./confirm-delete";

// The opening tag of the trash button that opens the dialog.
const trigger = (props: { disabled?: boolean }) =>
  /<button[^>]*aria-label="Delete task"[^>]*>/.exec(
    renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <ConfirmDelete
          label="Delete task"
          question="Delete this task?"
          remove={async () => {}}
          onDeleted={() => {}}
          {...props}
        />
      </QueryClientProvider>,
    ),
  )?.[0] ?? "";

test("the delete button can be disabled", () => {
  expect(trigger({ disabled: true })).toContain('disabled=""');
});

test("the delete button is enabled by default", () => {
  expect(trigger({})).not.toContain('disabled=""');
});
