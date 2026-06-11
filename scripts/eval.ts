// Held-out probe-set evaluation: precision and abstention, not regression.
//
// The regression corpus (test/corpus.txt) is engineered: every case exercises a
// known constraint, so recall is 100% by construction. This script runs the
// engine over a probe set written against the vocabulary list alone (not the
// rule inventory) and reports how the four-way verdict behaves on input the
// grammar was never tuned to: false positives on grammatical sentences,
// recall and diagnosis accuracy on in-scope errors, abstention on
// out-of-scope errors, and the unknown-word path.
//
//   <label> | <sentence> [| <detail>]
//
//   good     grammatical English; the engine should accept or abstain, never flag
//   bad      ungrammatical, error type within the grammar's declared constraints;
//            detail = substring the violation message/rule should contain
//   bad-oos  ungrammatical, error type outside the declared constraints;
//            correct behavior is abstention (flagging it for the right reason is
//            impossible: no rule names it)
//   oov      contains vocabulary the lexicon lacks; expected verdict unknown-word
//
// Run:  node --experimental-strip-types scripts/eval.ts [--lang en] [--verbose]

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { load_grammar } from "../src/languages.ts";
import { analyze, type analysis } from "../src/analyze.ts";

type gold = "good" | "bad" | "bad-oos" | "oov";

type probe = { label: gold; sentence: string; detail?: string; line: number };

function parse_probes(text: string): probe[] {
    const out: probe[] = [];
    const lines = text.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();

        if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

        const parts = trimmed.split("|").map((p) => p.trim());
        const label = parts[0] as gold;

        if (!["good", "bad", "bad-oos", "oov"].includes(label)) {
            throw new Error(`eval line ${i + 1}: unknown label '${parts[0]}'`);
        }
        if (!parts[1]) throw new Error(`eval line ${i + 1}: missing sentence`);

        out.push({ label, sentence: parts[1], detail: parts[2] || undefined, line: i + 1 });
    }

    return out;
}

// the three behaviors the metrics distinguish
type behavior = "accept" | "flag" | "abstain";

function behavior_of(a: analysis): behavior {
    switch (a.verdict) {
        case "grammatical": return "accept";
        case "ungrammatical": return "flag";
        default: return "abstain"; // no-analysis | unknown-word
    }
}

function diagnosis_matches(a: analysis, detail: string): boolean {
    const needle = detail.toLowerCase();

    return a.violations.some(
        (v) => v.message.toLowerCase().includes(needle) || v.rule.toLowerCase().includes(needle),
    );
}

const pct = (k: number, n: number): string => (n === 0 ? "  --" : `${((100 * k) / n).toFixed(1)}%`);

const args = process.argv.slice(2);
const lang_idx = args.indexOf("--lang");
const lang = lang_idx >= 0 ? args[lang_idx + 1] : "en";
const verbose = args.includes("--verbose");

const here = dirname(fileURLToPath(import.meta.url));
const probes = parse_probes(readFileSync(join(here, "..", "test", `eval.${lang}.txt`), "utf8"));
const g = load_grammar(lang);

type row = { p: probe; a: analysis; b: behavior };

const rows: row[] = probes.map((p) => {
    const a = analyze(g, p.sentence);

    return { p, a, b: behavior_of(a) };
});

const by = (label: gold): row[] => rows.filter((r) => r.p.label === label);
const count = (rs: row[], b: behavior): number => rs.filter((r) => r.b === b).length;

const good = by("good");
const bad = by("bad");
const oos = by("bad-oos");
const oov = by("oov");

console.log(`probe set [${lang}]: ${rows.length} sentences ` +
    `(${good.length} good, ${bad.length} bad in-scope, ${oos.length} bad out-of-scope, ${oov.length} oov)\n`);

// --- per-label behavior table ------------------------------------------------

console.log("            n   accept     flag  abstain");
for (const [name, rs] of [["good", good], ["bad", bad], ["bad-oos", oos], ["oov", oov]] as [string, row[]][]) {
    console.log(
        `  ${name.padEnd(8)}${String(rs.length).padStart(3)}` +
        `${pct(count(rs, "accept"), rs.length).padStart(9)}` +
        `${pct(count(rs, "flag"), rs.length).padStart(9)}` +
        `${pct(count(rs, "abstain"), rs.length).padStart(9)}`,
    );
}

// --- headline metrics ----------------------------------------------------------

// every flag is a claim; precision counts how many claims were true
const flagged = rows.filter((r) => r.b === "flag");
const true_flags = flagged.filter((r) => r.p.label !== "good").length;

// diagnosis accuracy: among flagged in-scope errors with a gold detail, how many
// named the right constraint
const flagged_bad = bad.filter((r) => r.b === "flag");
const with_detail = flagged_bad.filter((r) => r.p.detail !== undefined);
const right_reason = with_detail.filter((r) => diagnosis_matches(r.a, r.p.detail!)).length;

console.log("");
console.log(`  precision of 'ungrammatical'   ${pct(true_flags, flagged.length)}  (${true_flags}/${flagged.length} flags are real errors)`);
console.log(`  false-positive rate on good    ${pct(count(good, "flag"), good.length)}  (${count(good, "flag")}/${good.length} correct sentences flagged)`);
console.log(`  recall on in-scope errors      ${pct(count(bad, "flag"), bad.length)}  (${count(bad, "flag")}/${bad.length} flagged)`);
console.log(`  diagnosis accuracy when flagged${pct(right_reason, with_detail.length).padStart(7)}  (${right_reason}/${with_detail.length} name the right constraint)`);
console.log(`  abstention on out-of-scope     ${pct(count(oos, "abstain"), oos.length)}  (${count(oos, "abstain")}/${oos.length} abstain rather than guess)`);
console.log(`  overgeneration on out-of-scope ${pct(count(oos, "accept"), oos.length)}  (${count(oos, "accept")}/${oos.length} wrongly accepted)`);
console.log(`  oov routed to unknown-word     ${pct(oov.filter((r) => r.a.verdict === "unknown-word").length, oov.length)}`);

// --- mismatch listing ------------------------------------------------------------

const surprises = rows.filter((r) =>
    (r.p.label === "good" && r.b === "flag") ||
    (r.p.label === "bad" && r.b !== "flag") ||
    (r.p.label === "bad" && r.b === "flag" && r.p.detail !== undefined && !diagnosis_matches(r.a, r.p.detail)) ||
    (r.p.label === "bad-oos" && r.b === "accept") ||
    (r.p.label === "oov" && r.a.verdict !== "unknown-word"));

if (surprises.length > 0) {
    console.log(`\n${surprises.length} deviation${surprises.length === 1 ? "" : "s"}:`);

    for (const r of surprises) {
        const why = r.a.violations.map((v) => v.message).join(" / ");
        console.log(`  [${r.p.label}] line ${r.p.line}: "${r.p.sentence}" -> ${r.a.verdict}${why ? ` (${why})` : ""}`);
    }
}

if (verbose) {
    console.log("\nfull listing:");
    for (const r of rows) {
        console.log(`  [${r.p.label}] "${r.p.sentence}" -> ${r.a.verdict}`);
    }
}
