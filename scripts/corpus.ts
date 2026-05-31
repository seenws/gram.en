// Human-readable regression-corpus report. Run with the Windows node:
//   "$NODE" --experimental-strip-types "$(wslpath -w scripts/corpus.ts)"
// Loads en.gram + test/corpus.txt, runs every case, prints a per-label summary
// and any failures, and exits non-zero if a case regressed.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse_grammar } from "../src/grammar.ts";
import { parse_corpus, run_corpus } from "../src/corpus.ts";

const here = dirname(fileURLToPath(import.meta.url));
const gram_dir = join(here, "..", "languages");
const resolve = (rel: string): string => readFileSync(join(gram_dir, rel), "utf8");

const g = parse_grammar(readFileSync(join(gram_dir, "en.gram"), "utf8"), { resolve });
const cases = parse_corpus(readFileSync(join(here, "..", "test", "corpus.txt"), "utf8"));
const results = run_corpus(g, cases);

const by_label = new Map<string, { pass: number; total: number }>();
for (const r of results) {
    const e = by_label.get(r.c.label) ?? { pass: 0, total: 0 };
    e.total++;
    if (r.passed) e.pass++;
    by_label.set(r.c.label, e);
}

console.log(`corpus: ${results.filter((r) => r.passed).length}/${results.length} passing\n`);
for (const [label, { pass, total }] of by_label) {
    console.log(`  ${label.padEnd(8)} ${pass}/${total}`);
}

const failures = results.filter((r) => !r.passed);
if (failures.length > 0) {
    console.log(`\n${failures.length} failure(s):`);
    for (const f of failures) console.log(`  [${f.c.line}] "${f.c.sentence}" — ${f.reason}`);
    process.exit(1);
}
