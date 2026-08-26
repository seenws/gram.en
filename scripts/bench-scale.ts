// Scaling benchmark: how does analyze() time grow as the imported lexicon grows?
//
// Reuses the "heavy scenario" of scripts/bench.ts (a generated noun lexicon
// appended onto the real english/lexicon.tsv, then a mixed grammatical/relaxed/
// mal-rule workload built from those words) and sweeps the lexicon size. Reports
// per-sentence analyze() p50/p95/max at each size and writes an SVG line chart.
//
// Run with the Windows node (this WSL env has no native node):
//   NODE="/mnt/c/Program Files/nodejs/node.exe"
//   "$NODE" --experimental-strip-types scripts/bench-scale.ts
//
// Optional: pass sizes as args, e.g. `... bench-scale.ts 100 1000 10000`.

import { performance } from "node:perf_hooks";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse_grammar } from "../src/grammar.ts";
import { analyze } from "../src/analyze.ts";
import { type resolver } from "../src/loader.ts";

// --- helpers (mirrors bench.ts) ---------------------------------------------

const ms = (x: number): string => (x < 1 ? x.toFixed(3) : x < 100 ? x.toFixed(2) : x.toFixed(1));
const num = (x: number): string => x.toLocaleString("en-US");

// nearest-rank percentile over an ascending-sorted array
function pct(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[i];
}

function make_rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0x100000000;
    };
}

// A resolver that appends an N-word generated noun lexicon onto the real
// lexicon.tsv (every other %include falls through). Identical generation to
// bench.ts's big_lexicon so the numbers are comparable.
function big_lexicon(base: resolver, n: number): { resolve: resolver; words: string[] } {
    const rng = make_rng(777);
    const seen = new Set<string>();
    const words: string[] = [];

    while (words.length < n) {
        const len = 5 + ((rng() * 4) | 0);            // 5-8 chars
        let w = "";
        for (let j = 0; j < len; j++) w += String.fromCharCode(97 + ((rng() * 26) | 0));
        if (seen.has(w)) continue;
        seen.add(w);
        words.push(w);
    }

    const synthetic = words.map((w) => `${w}\tN-reg\t<lemma>=${w} <initial>=cons`).join("\n");
    const tsv = `${base("lexicon.tsv")}\n${synthetic}`;

    return { resolve: (rel) => (rel === "lexicon.tsv" ? tsv : base(rel)), words };
}

// ~112 sentences spanning the outcome paths the engine treats differently.
// `diag` marks the diagnostic path (relaxed unification + mal-rules + re-parsing
// repair candidates) -- the expensive case -- vs a clean grammatical parse.
type cased = { text: string; diag: boolean };
function workload(words: string[]): cased[] {
    const out: cased[] = [];
    const w = (i: number) => words[i % words.length];
    let i = 0;

    for (let k = 0; k < 14; k++) {
        const a = w(i++), b = w(i++);
        out.push({ text: `the ${a} barks`, diag: false });
        out.push({ text: `the ${a} chased the ${b}`, diag: false });
        out.push({ text: `the big ${a} barks`, diag: false });
        out.push({ text: `the ${a} and the ${b} bark`, diag: false });
        out.push({ text: `barks the ${a}`, diag: true });            // mal-rule
        out.push({ text: `the ${a} bark`, diag: true });             // relaxed S-V agreement
        out.push({ text: `${a} barks`, diag: true });                // relaxed missing determiner
        out.push({ text: `the ${a} and the ${b} barks`, diag: true });// relaxed coordination
    }

    return out;
}

// --- run ---------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const gram_dir = join(here, "..", "languages", "english");
const base_resolve = (rel: string): string => readFileSync(join(gram_dir, rel), "utf8");
const en_src = readFileSync(join(gram_dir, "en.gram"), "utf8");

const SIZES = process.argv.length > 2
    ? process.argv.slice(2).map((x) => parseInt(x, 10)).filter((x) => x > 0)
    : [100, 1_000, 10_000, 50_000, 100_000];

const TIMED_PASSES = 8;   // repeat the workload this many times for stable percentiles

console.log(`node ${process.version}\n`);
// Medians are reported rather than p95 because on this platform the analyze()
// tail is dominated by GC pauses that strike at random lexicon sizes (a single
// call can spike to tens of ms), uncorrelated with the lexicon -- so p95 is noise,
// while the median is stable and is what the size-independence claim rests on. The
// overall p95 column is kept only to show the tail stays bounded, not as a trend.
console.log("analyze() per-sentence time vs imported lexicon size  (medians; p95 = noisy tail)");
console.log(
    "  " + "roots".padStart(8) + "  " + "states".padStart(10) + "  " + "load".padStart(9) +
    "  " + "gram.p50".padStart(9) + "  " + "diag.p50".padStart(9) + "  " + "all.p50".padStart(8) +
    "  " + "all.p95".padStart(8) + "  samples",
);

type point = { n: number; load: number; p50: number; p95: number; gram_p50: number; diag_p50: number };
const points: point[] = [];

for (const n of SIZES) {
    const { resolve, words } = big_lexicon(base_resolve, n);

    const t_load0 = performance.now();
    const g = parse_grammar(en_src, { resolve });
    const load = performance.now() - t_load0;
    const states = g.morph_fst!.n_states;

    const sents = workload(words);

    // warm the JIT over the whole workload before timing
    for (let pass = 0; pass < 3; pass++) for (const s of sents) analyze(g, s.text);

    const all: number[] = [], gram: number[] = [], diag: number[] = [];
    for (let pass = 0; pass < TIMED_PASSES; pass++) {
        for (const s of sents) {
            const t0 = performance.now();
            analyze(g, s.text);
            const dt = performance.now() - t0;
            all.push(dt);
            (s.diag ? diag : gram).push(dt);
        }
    }
    all.sort((a, b) => a - b); gram.sort((a, b) => a - b); diag.sort((a, b) => a - b);

    const p = { n, load, p50: pct(all, 50), p95: pct(all, 95), gram_p50: pct(gram, 50), diag_p50: pct(diag, 50) };
    points.push(p);

    console.log(
        "  " + num(n).padStart(8) + "  " + num(states).padStart(10) + "  " + (ms(load) + "ms").padStart(9) +
        "  " + (ms(p.gram_p50)).padStart(9) + "  " + (ms(p.diag_p50)).padStart(9) + "  " + (ms(p.p50)).padStart(8) +
        "  " + (ms(p.p95)).padStart(8) + "  " + num(all.length),
    );
}

// --- ASCII sparkline (quick terminal view) ----------------------------------

console.log("\ndiagnostic-path median across sizes (the expensive path; rows scaled to its max):");
const max_diag = Math.max(...points.map((p) => p.diag_p50));
for (const p of points) {
    const bar = "#".repeat(Math.max(1, Math.round((p.diag_p50 / max_diag) * 48)));
    console.log(`  ${num(p.n).padStart(8)}  ${bar} ${ms(p.diag_p50)} ms`);
}

// --- SVG line chart -----------------------------------------------------------

function svg_chart(pts: point[]): string {
    const W = 720, H = 420;
    const m = { l: 64, r: 120, t: 48, b: 64 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;

    const ymax = Math.max(...pts.map((p) => p.diag_p50)) * 1.4;

    // evenly spaced sample positions: one equal-width slot per measured size, so
    // 50k and 100k don't crowd together the way they would on a log/linear axis.
    const idx = new Map(pts.map((p, i) => [p.n, i]));
    const X = (n: number) => m.l + (pts.length <= 1 ? 0.5 : idx.get(n)! / (pts.length - 1)) * pw;
    const Y = (v: number) => m.t + ph - (v / ymax) * ph;

    const out: string[] = [];
    out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="sans-serif" font-size="13">`);
    out.push(`<rect width="${W}" height="${H}" fill="white"/>`);
    out.push(`<text x="${m.l}" y="28" font-size="16" font-weight="bold">analyze() time vs imported lexicon size</text>`);

    // y gridlines + labels (ms)
    const yticks = 5;
    for (let i = 0; i <= yticks; i++) {
        const v = (ymax / yticks) * i;
        const y = Y(v);
        out.push(`<line x1="${m.l}" y1="${y.toFixed(1)}" x2="${m.l + pw}" y2="${y.toFixed(1)}" stroke="#e3e3e3"/>`);
        out.push(`<text x="${m.l - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="#555">${v.toFixed(1)}</text>`);
    }
    out.push(`<text x="16" y="${m.t + ph / 2}" text-anchor="middle" fill="#333" transform="rotate(-90 16 ${m.t + ph / 2})">milliseconds</text>`);

    // x ticks at each measured size (evenly spaced)
    for (const p of pts) {
        const x = X(p.n);
        out.push(`<line x1="${x.toFixed(1)}" y1="${m.t}" x2="${x.toFixed(1)}" y2="${m.t + ph}" stroke="#f2f2f2"/>`);
        out.push(`<text x="${x.toFixed(1)}" y="${m.t + ph + 22}" text-anchor="middle" fill="#555">${num(p.n)}</text>`);
    }
    out.push(`<text x="${m.l + pw / 2}" y="${H - 12}" text-anchor="middle" fill="#333">imported roots (sampled sizes)</text>`);

    // Two stable medians tell the whole story: the diagnostic path (the expensive
    // one) and the grammatical path, each flat across sizes. Medians, not p95,
    // because the tail is GC noise (see the note above).
    const series: [string, string, (p: point) => number][] = [
        ["diagnostic median", "#c0392b", (p) => p.diag_p50],
        ["grammatical median", "#1e8449", (p) => p.gram_p50],
    ];
    for (const [label, color, sel] of series) {
        const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${X(p.n).toFixed(1)},${Y(sel(p)).toFixed(1)}`).join(" ");
        out.push(`<path d="${path}" fill="none" stroke="${color}" stroke-width="2.5"/>`);
        for (const p of pts) out.push(`<circle cx="${X(p.n).toFixed(1)}" cy="${Y(sel(p)).toFixed(1)}" r="3.5" fill="${color}"/>`);
        const last = pts[pts.length - 1];
        out.push(`<text x="${(X(last.n) + 10).toFixed(1)}" y="${(Y(sel(last)) + 4).toFixed(1)}" fill="${color}" font-weight="bold">${label} (${ms(sel(last))} ms)</text>`);
    }

    out.push(`</svg>`);
    return out.join("\n");
}

const svg_path = join(here, "..", "notes", "assets", "scaling.svg");
writeFileSync(svg_path, svg_chart(points));
console.log(`\nwrote ${svg_path}`);
