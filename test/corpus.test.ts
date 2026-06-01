import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse_corpus, run_corpus } from "../src/corpus.ts";
import { LANGUAGES, corpus_path, lang_dir, load_grammar } from "../src/languages.ts";

// One corpus per language. A language participates once both its grammar manifest
// and its test/<corpus> exist, so adding a language lights up its tests with no
// edits here.
const present = LANGUAGES.filter(
    (spec) => existsSync(join(lang_dir(spec), spec.manifest)) && existsSync(corpus_path(spec)),
);

for (const spec of present) {
    const g = load_grammar(spec.code);
    const cases = parse_corpus(readFileSync(corpus_path(spec), "utf8"));

    test(`[${spec.code}] regression corpus: every case meets its expected verdict and explanation`, () => {
        const results = run_corpus(g, cases);
        const failures = results.filter((r) => !r.passed);
        const report = failures.map((f) => `  [line ${f.c.line}] "${f.c.sentence}" — ${f.reason}`).join("\n");

        assert.equal(failures.length, 0, `${failures.length}/${cases.length} corpus cases failed:\n${report}`);
    });

    test(`[${spec.code}] regression corpus has meaningful, balanced coverage`, () => {
        assert.ok(cases.length >= 25, `expected a substantial corpus, got ${cases.length}`);

        for (const label of ["ok", "bad", "none", "unknown"] as const) {
            assert.ok(cases.some((c) => c.label === label), `corpus has no '${label}' cases`);
        }
    });
}
