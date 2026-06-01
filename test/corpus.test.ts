import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse_grammar } from "../src/grammar.ts";
import { parse_corpus, run_corpus } from "../src/corpus.ts";

const here = dirname(fileURLToPath(import.meta.url));
const gram_dir = join(here, "..", "languages", "english");
const resolve = (rel: string): string => readFileSync(join(gram_dir, rel), "utf8");
const g = parse_grammar(readFileSync(join(gram_dir, "en.gram"), "utf8"), { resolve });
const cases = parse_corpus(readFileSync(join(here, "corpus.txt"), "utf8"));

test("regression corpus: every case meets its expected verdict and explanation", () => {
    const results = run_corpus(g, cases);
    const failures = results.filter((r) => !r.passed);
    const report = failures.map((f) => `  [line ${f.c.line}] "${f.c.sentence}" — ${f.reason}`).join("\n");

    assert.equal(failures.length, 0, `${failures.length}/${cases.length} corpus cases failed:\n${report}`);
});

test("regression corpus has meaningful, balanced coverage", () => {
    assert.ok(cases.length >= 25, `expected a substantial corpus, got ${cases.length}`);

    for (const label of ["ok", "bad", "none", "unknown"] as const) {
        assert.ok(cases.some((c) => c.label === label), `corpus has no '${label}' cases`);
    }
});
