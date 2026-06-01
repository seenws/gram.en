// Human-readable regression-corpus report. Run with the Windows node:
//   "$NODE" --experimental-strip-types "$(wslpath -w scripts/corpus.ts)" [--lang en|sv]
// Loads the language's grammar + its test/<corpus>, runs every case, prints a
// per-label summary and any failures, and exits non-zero if a case regressed.

import { readFileSync } from "node:fs";
import { parse_corpus, run_corpus } from "../src/corpus.ts";
import { corpus_path, lang_spec_of, load_grammar } from "../src/languages.ts";

const lang_idx = process.argv.indexOf("--lang");
const code = lang_idx >= 0 ? process.argv[lang_idx + 1] : "en";
const spec = lang_spec_of(code);

const g = load_grammar(code);
const cases = parse_corpus(readFileSync(corpus_path(spec), "utf8"));
const results = run_corpus(g, cases);

const by_label = new Map<string, { pass: number; total: number }>();
for (const r of results) {
    const e = by_label.get(r.c.label) ?? { pass: 0, total: 0 };
    e.total++;
    if (r.passed) e.pass++;
    by_label.set(r.c.label, e);
}

console.log(`corpus [${spec.code}]: ${results.filter((r) => r.passed).length}/${results.length} passing\n`);
for (const [label, { pass, total }] of by_label) {
    console.log(`  ${label.padEnd(8)} ${pass}/${total}`);
}

const failures = results.filter((r) => !r.passed);
if (failures.length > 0) {
    console.log(`\n${failures.length} failure(s):`);
    for (const f of failures) console.log(`  [${f.c.line}] "${f.c.sentence}" — ${f.reason}`);
    process.exit(1);
}
