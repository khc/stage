import { expect, test } from "bun:test";

type Evidence = { imdb?: unknown[]; web?: { url: string; note?: string }[] };
type GoldenCase = {
  id: string;
  scenario: string | null;
  turn: number;
  prompt: string;
  stability: "stable" | "volatile";
  retrievedOn?: string;
  reviewBy?: string;
  answer: { mustInclude?: string[]; mustIncludeAny?: string[]; acceptableOutcomes?: string[] };
  facts: string[];
  evidence: Evidence;
};

const golden = (await Bun.file(new URL("./golden/cases.json", import.meta.url)).json()) as {
  version: number;
  cases: GoldenCase[];
};
const scenarioSources = await Promise.all(
  [
    ...new Bun.Glob("scenarios/*.eval.ts").scanSync({
      cwd: new URL(".", import.meta.url).pathname,
    }),
  ].map((path) => Bun.file(new URL(`./${path}`, import.meta.url)).text()),
);
const scenarioSource = scenarioSources.join("\n");
const isDate = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

test("case ids are unique", () => {
  const ids = golden.cases.map((c) => c.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test("every case has a prompt, facts and some evidence", () => {
  for (const c of golden.cases) {
    expect(c.prompt.trim(), c.id).not.toBe("");
    expect(c.facts.length, c.id).toBeGreaterThan(0);
    const { imdb = [], web = [] } = c.evidence;
    expect(imdb.length + web.length, c.id).toBeGreaterThan(0);
  }
});

test("web evidence is https", () => {
  for (const c of golden.cases)
    for (const { url } of c.evidence.web ?? []) expect(new URL(url).protocol, c.id).toBe("https:");
});

test("stable cases state what the answer must include", () => {
  for (const c of golden.cases.filter((x) => x.stability === "stable"))
    expect(c.answer.mustInclude?.length ?? 0, c.id).toBeGreaterThan(0);
});

test("volatile cases say when they were retrieved and when to re-check", () => {
  for (const c of golden.cases.filter((x) => x.stability === "volatile")) {
    expect(isDate(c.retrievedOn), c.id).toBe(true);
    expect(isDate(c.reviewBy), c.id).toBe(true);
    expect(c.reviewBy! > c.retrievedOn!, c.id).toBe(true);
  }
});

test("a case that names a scenario matches a prompt and a scenario name in the scenario files", () => {
  for (const c of golden.cases.filter((x) => x.scenario !== null)) {
    expect(scenarioSource, `${c.id}: scenario name`).toContain(c.scenario!);
    const firstLine = c.prompt.split("\n")[0]!;
    expect(scenarioSource, `${c.id}: prompt`).toContain(firstLine);
  }
});
