import { posix } from "node:path";

import { load } from "js-yaml";
import { toString } from "mdast-util-to-string";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";

// A section's own content: `path` is the heading titles from the document title down, `blocks`
// are its top-level nodes (paragraph, list, table, code ...) as markdown, without sub-sections.
export type DocSection = { path: string[]; depth: number; blocks: string[] };

export type ParsedDoc = {
  title: string;
  description?: string;
  sections: DocSection[];
  // Internal link targets as corpus-relative paths, in document order, each once.
  links: string[];
};

export type DocFormat = {
  extensions: string[];
  // Throws, with the file path in the message, when the text cannot be parsed.
  parse: (text: string, relPath: string) => ParsedDoc;
};

// A loose view of an mdast node: the transform below only reads these fields.
type MdNode = {
  type: string;
  children?: MdNode[];
  value?: string;
  url?: string;
  depth?: number;
  name?: string | null;
  attributes?: { name?: string; value?: unknown }[];
};

type Ctx = { links: string[] };

const markdownParser = unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]).use(remarkGfm);
const mdxParser = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ["yaml"])
  .use(remarkGfm)
  .use(remarkMdx);
const stringifier = unified().use(remarkStringify).use(remarkGfm);
type Tree = Parameters<typeof stringifier.stringify>[0];

const textOf = (node: MdNode) => toString(node as never);

// Applies `edit` to every line that is not inside a fenced code block.
const outsideFences = (text: string, edit: (line: string) => string) => {
  let fence: string | undefined;
  return text
    .split("\n")
    .map((line) => {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
        return line;
      }
      if (marker) {
        fence = marker;
        return line;
      }
      return edit(line);
    })
    .join("\n");
};

// An HTML block (<summary>, <details>) runs on until a blank line and swallows a fence that starts
// right after it, so a fence that opens straight after a non-blank line gets a blank line first.
const separateFences = (text: string) => {
  const lines = text.split("\n");
  const out: string[] = [];
  let fence: string | undefined;
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
    } else if (marker) {
      fence = marker;
      if ((out.at(-1) ?? "").trim() !== "") out.push("");
    }
    out.push(line);
  }
  return out.join("\n");
};

// remark-mdx reads `{#id}` as an expression and fails, so a trailing heading id is dropped first.
const dropHeadingIds = (text: string) =>
  outsideFences(text, (line) => {
    if (!/^#{1,6}\s/.test(line)) return line;
    const stripped = line.replace(/\{#[\w-]+\}\s*$/, "");
    return stripped === line ? line : stripped.trimEnd();
  });

// A `({% link ... %})` target is not a valid markdown link destination, so Liquid goes first. A
// link tag becomes a corpus-rooted path, a blog link a dead anchor, any other tag is removed.
export const dropLiquid = (text: string) =>
  outsideFences(text, (line) =>
    line
      .replace(/\]\(\s*\{%-?\s*link\s+docs\/[^/\s]+\/([^\s%]+)\s*-?%\}/g, "](/$1")
      .replace(/\]\(\s*\{%-?\s*post_url[^%\n]{0,200}%\}[^)\n]{0,200}\)/g, "](#)")
      .replace(/\{%-?[^%]*%\}/g, ""),
  );

const entities: Record<string, string> = {
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  amp: "&",
};

const decodeEntities = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const hex = entity[1]?.toLowerCase() === "x";
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    const name = entity.toLowerCase();
    return Object.hasOwn(entities, name) ? entities[name]! : match;
  });

// A pre-rendered highlighted code block (<pre><code> inside divs) becomes a code node; any other
// HTML is dropped.
const fromHtml = (node: MdNode): MdNode[] => {
  const html = node.value ?? "";
  if (!/<pre[\s>]/i.test(html) || !/<code[\s>]/i.test(html)) return [];
  const lang = /language-([\w+#-]+)/.exec(html)?.[1];
  const value = decodeEntities(html.replace(/<[^<>]*>/g, "")).replace(/\n+$/, "");
  return [{ type: "code", value, ...(lang && { lang }) } as MdNode];
};

// `{" "}` and `{'text'}` are string literals; every other expression (a comment) is dropped.
const stringLiteral = (source: string): string | undefined => {
  const value = source.trim();
  if (/^"(?:[^"\\]|\\.)*"$/.test(value)) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return undefined;
    }
  }
  return /^'(?:[^'\\]|\\.)*'$/.test(value) ? value.slice(1, -1) : undefined;
};

const fromExpression = (node: MdNode): MdNode[] => {
  const literal = stringLiteral(node.value ?? "");
  if (literal === undefined) return [];
  const text: MdNode = { type: "text", value: literal };
  return node.type === "mdxFlowExpression" ? [{ type: "paragraph", children: [text] }] : [text];
};

const attribute = (node: MdNode, name: string) => {
  const value = node.attributes?.find((attr) => attr.name === name)?.value;
  return typeof value === "string" ? value : undefined;
};

// JSX wrappers are replaced by their children. `ParamField` keeps its `path` and `type`, which
// hold the API names; lowercase HTML-like tags the parser also reports as JSX are mapped to text.
const fromJsx = (node: MdNode, ctx: Ctx): MdNode[] => {
  const children = rewrite(node.children ?? [], ctx);
  if (node.name === "br") return [{ type: "text", value: " " }];
  if (node.name === "code") {
    return [{ type: "inlineCode", value: textOf({ type: "paragraph", children }) }];
  }
  const path = attribute(node, "path");
  if (node.name === "ParamField" && node.type === "mdxJsxFlowElement" && path) {
    const type = attribute(node, "type");
    const lead: MdNode = {
      type: "paragraph",
      children: [
        { type: "inlineCode", value: path },
        ...(type ? [{ type: "text", value: ` (${type})` }] : []),
      ],
    };
    return [lead, ...children];
  }
  return children;
};

// Removes what carries no meaning for search, keeps link text and records link targets.
const replace = (node: MdNode, ctx: Ctx): MdNode[] => {
  switch (node.type) {
    case "yaml":
    case "mdxjsEsm":
    case "definition":
    case "thematicBreak":
      return [];
    case "html":
      return fromHtml(node);
    case "mdxFlowExpression":
    case "mdxTextExpression":
      return fromExpression(node);
    case "mdxJsxFlowElement":
    case "mdxJsxTextElement":
      return fromJsx(node, ctx);
    case "link":
      ctx.links.push(node.url ?? "");
      return rewrite(node.children ?? [], ctx);
    case "linkReference":
      return rewrite(node.children ?? [], ctx);
    default:
      return [node.children ? { ...node, children: rewrite(node.children, ctx) } : node];
  }
};

const rewrite = (nodes: MdNode[], ctx: Ctx): MdNode[] =>
  nodes.flatMap((node) => replace(node, ctx));

// A link target as a corpus-relative path, or undefined for anything that is not a document in the
// corpus: external, `mailto:`, anchor-only, empty, or outside the corpus root. A leading slash means
// corpus-rooted; any other path is relative to the directory of the document.
const internalTarget = (url: string, relPath: string): string | undefined => {
  const path = (url.split(/[#?]/)[0] ?? "").trim();
  if (!path || path.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(path)) return undefined;
  if (path.startsWith("/")) return path.replace(/^\/+/, "") || undefined;
  const joined = posix.normalize(posix.join(posix.dirname(relPath), path));
  return joined === "." || joined.startsWith("..") ? undefined : joined;
};

const frontMatterOf = (root: MdNode): Record<string, unknown> => {
  const yaml = root.children?.find((node) => node.type === "yaml")?.value;
  const data = yaml === undefined ? undefined : load(yaml);
  return typeof data === "object" && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
};

const textValue = (value: unknown) => {
  if (typeof value === "number") return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const toBlock = (node: MdNode) =>
  stringifier.stringify({ type: "root", children: [node] } as Tree).trim();

// Headings nest under the document title (an h1 equal to it merges into the root section); every
// other top-level node is one block of the section above it.
const toSections = (title: string, nodes: MdNode[]): DocSection[] => {
  const sections: DocSection[] = [{ path: [title], depth: 0, blocks: [] }];
  const stack: { depth: number; text: string }[] = [];
  let first = true;
  for (const node of nodes) {
    if (node.type === "heading") {
      const depth = node.depth ?? 1;
      const text = textOf(node).trim();
      const merges = first && depth === 1 && text === title;
      first = false;
      if (merges) continue;
      while (stack.length > 0 && stack[stack.length - 1]!.depth >= depth) stack.pop();
      stack.push({ depth, text });
      sections.push({ path: [title, ...stack.map((entry) => entry.text)], depth, blocks: [] });
      continue;
    }
    first = false;
    const block = toBlock(node);
    if (block) sections[sections.length - 1]!.blocks.push(block);
  }
  return sections;
};

const toParsedDoc = (root: MdNode, relPath: string, descriptionKey: string): ParsedDoc => {
  const meta = frontMatterOf(root);
  const ctx: Ctx = { links: [] };
  const nodes = rewrite(root.children ?? [], ctx);
  const h1 = nodes.find((node) => node.type === "heading" && node.depth === 1);
  const title =
    (textValue(meta.title) ?? (h1 ? textOf(h1).trim() : "")) ||
    posix.basename(relPath, posix.extname(relPath));
  const description = textValue(meta[descriptionKey]);
  return {
    title,
    ...(description && { description }),
    sections: toSections(title, nodes),
    links: [...new Set(ctx.links.flatMap((url) => internalTarget(url, relPath) ?? []))],
  };
};

type FormatSpec = {
  extensions: string[];
  parser: typeof markdownParser;
  prepare: (text: string) => string;
  descriptionKey: string;
};

const createFormat = ({ extensions, parser, prepare, descriptionKey }: FormatSpec): DocFormat => ({
  extensions,
  parse(text, relPath) {
    try {
      const root = parser.parse(prepare(text)) as unknown as MdNode;
      return toParsedDoc(root, relPath, descriptionKey);
    } catch (err) {
      throw new Error(`${relPath}: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }
  },
});

export const docFormats = {
  mdx: createFormat({
    extensions: [".mdx"],
    parser: mdxParser as unknown as typeof markdownParser,
    prepare: dropHeadingIds,
    descriptionKey: "description",
  }),
  jekyll: createFormat({
    extensions: [".md"],
    parser: markdownParser,
    prepare: (text) => dropLiquid(separateFences(text)),
    descriptionKey: "blurb",
  }),
} satisfies Record<string, DocFormat>;
