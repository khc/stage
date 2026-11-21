import { expect, test } from "bun:test";

import { renderToStaticMarkup } from "react-dom/server";

import type { ModelOption } from "@/lib/models";

import { ModelPicker, SwitchModelDialog, switchModelCopy } from "./model-picker";

const options: ModelOption[] = [
  { ref: { providerId: "p1", model: "flash" }, label: "Express · flash" },
  { ref: { providerId: "p1", model: "pro" }, label: "Express · pro" },
  { ref: { providerId: "p2", model: "gpt-4o" }, label: "OpenAI · gpt-4o" },
];

test("the picker shows the selected model, or Job default when none is selected", () => {
  const selected = renderToStaticMarkup(
    <ModelPicker options={options} value={options[1]!.ref} onChange={() => {}} />,
  );
  expect(selected).toContain('aria-label="Model"');
  expect(selected).toContain("Express · pro");
  const openaiSelected = renderToStaticMarkup(
    <ModelPicker options={options} value={options[2]!.ref} onChange={() => {}} />,
  );
  expect(openaiSelected).toContain("OpenAI · gpt-4o");
  const none = renderToStaticMarkup(<ModelPicker options={options} onChange={() => {}} />);
  expect(none).toContain("Job default");
});

test("with no usable models the picker is disabled and says why", () => {
  const html = renderToStaticMarkup(<ModelPicker options={[]} onChange={() => {}} />);
  expect(html).toContain("No models");
  expect(html).toMatch(/disabled/);
});

test("the switch warning names both models and explains the token-usage risk", () => {
  const copy = switchModelCopy("Express · flash", "Express · pro");
  expect(copy.title).toBe("Switch model?");
  expect(copy.body).toContain("whole conversation");
  expect(copy.body).toContain("input tokens");
  expect(copy.body).toContain("Express · flash");
  expect(copy.keep).toBe("Keep Express · flash");
  expect(copy.switch).toBe("Switch to Express · pro");
});

test("the dialog renders nothing while closed", () => {
  const html = renderToStaticMarkup(
    <SwitchModelDialog open={false} from="a" to="b" onKeep={() => {}} onSwitch={() => {}} />,
  );
  expect(html).not.toContain("Switch model?");
});
