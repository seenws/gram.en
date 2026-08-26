// Benchmark harness: FST size + build time, grammar load time, parse time.
//
// Run with the Windows node (this WSL env has no native node):
//   NODE="/mnt/c/Program Files/nodejs/node.exe"
//   "$NODE" --experimental-strip-types "$(wslpath -w scripts/bench.ts)"
//
// Numbers are wall-clock on whatever machine runs it; treat them as relative,
// not absolute. Each measurement warms up, then reports min / median / mean.

import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse_grammar } from "../src/grammar.ts";
import { analyze } from "../src/analyze.ts";
import { morph_analyze } from "../src/morph.ts";
import { type resolver, flatten_grammar } from "../src/loader.ts";
import { type fst } from "../src/fst.ts";
import { type morph_data, type root_entry, compile_morph_fst } from "../src/morph_lexc.ts";
import { fs } from "../src/featstruct.ts";

// --- timing -----------------------------------------------------------------

type stats = { min: number; median: number; mean: number; iters: number };

function measure(fn: () => void, iters: number, warmup = Math.min(10, iters)): stats {
    for (let i = 0; i < warmup; i++) fn();

    const samples: number[] = new Array(iters);

    for (let i = 0; i < iters; i++) {
        const t0 = performance.now();
        fn();
        samples[i] = performance.now() - t0;
    }

    samples.sort((a, b) => a - b);
    const mean = samples.reduce((a, b) => a + b, 0) / iters;

    return { min: samples[0], median: samples[(iters / 2) | 0], mean, iters };
}

const ms = (x: number): string => (x < 1 ? x.toFixed(3) : x < 100 ? x.toFixed(2) : x.toFixed(1));
const num = (x: number): string => x.toLocaleString("en-US");

// nearest-rank percentile over an ascending-sorted array
function pct(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[i];
}

function timing_row(label: string, s: stats): void {
    console.log(
        `  ${label.padEnd(34)} ${(ms(s.median) + " ms").padStart(11)}   ` +
        `(min ${ms(s.min)}, mean ${ms(s.mean)}, n=${s.iters})`,
    );
}

function arc_count(f: fst): number {
    return f.out_arcs.reduce((a, arcs) => a + arcs.length, 0);
}

// --- synthetic lexicon ------------------------------------------------------

// Deterministic LCG so runs are reproducible; produces mixed-prefix stems of
// length 4-8 (some shared prefixes, mostly distinct) -- closer to a real
// dictionary than the all-"stem" prefixes of the unit scale test.
function make_rng(seed: number): () => number {
    let s = seed >>> 0;

    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0x100000000;
    };
}

function synth_data(n: number): morph_data {
    const rng = make_rng(12345);
    const seen = new Set<string>();
    const roots: root_entry[] = [];

    while (roots.length < n) {
        const len = 4 + ((rng() * 5) | 0);
        let stem = "";
        for (let j = 0; j < len; j++) stem += String.fromCharCode(97 + ((rng() * 26) | 0));

        if (seen.has(stem)) continue;
        seen.add(stem);
        roots.push({ surface: stem, paradigm: "N", feats: fs(), overrides: new Map() });
    }

    const paradigms = new Map([
        ["N", {
            name: "N",
            cat: "N",
            entries: [
                { tag: "+N+Sg", surface: "", feats: fs() },
                { tag: "+N+Pl", surface: "s", feats: fs() },
                { tag: "+N+Poss", surface: "'s", feats: fs() },
            ],
        }],
    ]);

    return { roots, paradigms };
}

// --- run --------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const gram_dir = join(here, "..", "languages", "english");
const resolve = (rel: string): string => readFileSync(join(gram_dir, rel), "utf8");
const en_src = readFileSync(join(gram_dir, "en.gram"), "utf8");
const en_flat = flatten_grammar(en_src, resolve);

console.log(`node ${process.version}\n`);

// 1. FST size + build time as the lexicon scales --------------------------------
console.log("FST build (synthetic noun lexicon, 3 forms per stem)");
console.log("  " + "stems".padStart(8) + "  " + "states".padStart(9) + "  " + "arcs".padStart(10) +
    "  " + "build".padStart(9) + "  states/stem");

for (const n of [100, 1_000, 10_000, 50_000]) {
    const data = synth_data(n);
    let f!: fst;
    const s = measure(() => { f = compile_morph_fst(data); }, n >= 10_000 ? 5 : 30);

    console.log(
        "  " + num(n).padStart(8) + "  " + num(f.n_states).padStart(9) + "  " + num(arc_count(f)).padStart(10) +
        "  " + (ms(s.median) + "ms").padStart(9) + "  " + (f.n_states / n).toFixed(2),
    );
}

// real grammar's compiled FST
{
    const g = parse_grammar(en_src, { resolve });
    const f = g.morph_fst!;
    console.log(`\n  en.gram morph FST: ${num(f.n_states)} states, ${num(arc_count(f))} arcs ` +
        `(${g.morph.roots.length} roots, ${g.morph.paradigms.size} paradigms, ${g.morph_cascade.length} rewrite rules)`);
}

// 2. Grammar load time ----------------------------------------------------------
console.log("\nGrammar load (parse + validate + FST compile + cascade)");
timing_row("en.gram (file IO + includes)", measure(() => parse_grammar(en_src, { resolve }), 200));
timing_row("pre-flattened string (no IO)", measure(() => parse_grammar(en_flat), 200));

// 3. Parse time -----------------------------------------------------------------
const g = parse_grammar(en_src, { resolve });

console.log("\nanalyze() per sentence (current grammar: adjectives, comparison, coordination, adverbs, auxiliaries)");
const sentences: [string, string][] = [
    // grammatical
    ["the dog barks", "grammatical"],
    ["the big old dog barks loudly", "grammatical (adj stack + adverb)"],
    ["the bigger dog chased the cat", "grammatical (comparative)"],
    ["the dog and the cat bark", "grammatical (coordination)"],
    ["he is barking", "grammatical (progressive)"],
    // relaxed / diagnostic (the path that re-parses repair candidates)
    ["the dog bark", "relaxed (subject-verb agreement)"],
    ["the dog and the cat barks", "relaxed (coordination agreement)"],
    ["an big dog barks", "relaxed (article through adjective)"],
    ["me and him bark", "relaxed (coordinate case)"],
    ["I'll barked", "relaxed (verb form)"],
    // mal-rule
    ["barks the dog", "mal-rule (word order)"],
];
for (const [s, note] of sentences) {
    timing_row(`"${s}"`, measure(() => { analyze(g, s); }, 300));
    console.log(`  ${" ".repeat(34)} -> ${analyze(g, s).verdict}  (${note})`);
}

// 4. morph_analyze per word -----------------------------------------------------
console.log("\nmorph_analyze() per word");
for (const [w, note] of [
    ["the", "explicit closed-class"],
    ["dogs", "trie + paradigm suffix"],
    ["chased", "rewrite cascade (e-deletion)"],
    ["glorp", "unknown (reject)"],
] as [string, string][]) {
    timing_row(`"${w}"`, measure(() => { morph_analyze(g, w); }, 20_000));
    console.log(`  ${" ".repeat(34)} -> ${morph_analyze(g, w).length} analysis/es  (${note})`);
}

// 5. Heavy scenario: 10k-word imported lexicon, real analyze() workload ----------

// A resolver that appends an N-word generated noun lexicon onto the real
// `lexicon.tsv` (every other %include falls through to the real file). Appending
// rather than replacing keeps the regular stems that live in lexicon.tsv -- the
// verbs `bark`/`chase`/`like` behind the workload's "barks"/"chased" sentences --
// available alongside the generated nouns. Returns the words so the workload can
// build sentences out of them.
function big_lexicon(n: number): { resolve: resolver; words: string[] } {
    const rng = make_rng(777);
    const seen = new Set<string>();
    const words: string[] = [];

    while (words.length < n) {
        const len = 5 + ((rng() * 4) | 0);            // 5-8 chars: avoids colliding with short function words
        let w = "";
        for (let j = 0; j < len; j++) w += String.fromCharCode(97 + ((rng() * 26) | 0));
        if (seen.has(w)) continue;
        seen.add(w);
        words.push(w);
    }

    const synthetic = words.map((w) => `${w}\tN-reg\t<lemma>=${w} <initial>=cons`).join("\n");
    const tsv = `${resolve("lexicon.tsv")}\n${synthetic}`;

    return { resolve: (rel) => (rel === "lexicon.tsv" ? tsv : resolve(rel)), words };
}

// ~84 sentences spanning the three outcome paths the engine treats differently.
function workload(words: string[]): { text: string; cat: string }[] {
    const out: { text: string; cat: string }[] = [];
    const w = (i: number) => words[i % words.length];
    let i = 0;

    for (let k = 0; k < 14; k++) {
        const a = w(i++), b = w(i++);
        out.push({ text: `the ${a} barks`, cat: "grammatical" });
        out.push({ text: `the ${a} chased the ${b}`, cat: "grammatical" });
        out.push({ text: `the big ${a} barks`, cat: "grammatical (adjective)" });
        out.push({ text: `the ${a} and the ${b} bark`, cat: "grammatical (coordination)" });
        out.push({ text: `barks the ${a}`, cat: "mal-rule" });
        out.push({ text: `the ${a} bark`, cat: "relaxed (S-V agreement)" });
        out.push({ text: `${a} barks`, cat: "relaxed (missing determiner)" });
        out.push({ text: `the ${a} and the ${b} barks`, cat: "relaxed (coordination)" });
    }

    return out;
}

console.log("\n=== heavy scenario: 10k imported noun lexicon ===");

const HEAVY_N = 10_000;
const { resolve: big_resolve, words } = big_lexicon(HEAVY_N);

let big_g!: ReturnType<typeof parse_grammar>;
const load = measure(() => { big_g = parse_grammar(en_src, { resolve: big_resolve }); }, 30);
const big_fst = big_g.morph_fst!;

console.log(`  load: ${ms(load.median)} ms (median, n=${load.iters})  | ` +
    `${num(big_g.morph.roots.length)} roots -> ${num(big_fst.n_states)} FST states, ${num(arc_count(big_fst))} arcs`);

const sentences2 = workload(words);

// warm the JIT over the whole workload, then time each call across several
// passes. One timed pass gives only n=14 per input class, so a per-class p95 is
// just "worst of 14" -- too noisy to report. Pooling passes stabilises it.
for (let pass = 0; pass < 3; pass++) for (const s of sentences2) analyze(big_g, s.text);

const TIMED_PASSES = 8;
const all: number[] = [];
const by_cat = new Map<string, number[]>();
const verdicts = new Map<string, number>();

for (let pass = 0; pass < TIMED_PASSES; pass++) {
    for (const s of sentences2) {
        const t0 = performance.now();
        const a = analyze(big_g, s.text);
        const dt = performance.now() - t0;

        all.push(dt);
        (by_cat.get(s.cat) ?? by_cat.set(s.cat, []).get(s.cat)!).push(dt);
        if (pass === 0) verdicts.set(a.verdict, (verdicts.get(a.verdict) ?? 0) + 1);
    }
}

all.sort((a, b) => a - b);

console.log(`  ${sentences2.length} analyze() calls | ` +
    `p50 ${ms(pct(all, 50))}  p95 ${ms(pct(all, 95))}  max ${ms(pct(all, 100))} ms  ` +
    `(verdicts: ${[...verdicts].map(([v, c]) => `${v}=${c}`).join(", ")})`);

console.log("  by input class:");
for (const [cat, xs] of by_cat) {
    xs.sort((a, b) => a - b);
    console.log(`    ${cat.padEnd(30)} n=${String(xs.length).padStart(3)}  ` +
        `p50 ${ms(pct(xs, 50)).padStart(6)}  p95 ${ms(pct(xs, 95)).padStart(6)}  max ${ms(pct(xs, 100)).padStart(6)} ms`);
}
