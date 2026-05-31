// Regression corpus: a labeled set of sentences and the verdict each must
// produce, plus a runner over analyze(). This is the correctness net for grammar
// growth -- every lexicon/rule change is checked against it. The corpus data
// lives in test/corpus.txt; this module parses and runs it, and is shared by the
// enforcing test (test/corpus.test.ts) and the report script (scripts/corpus.ts).

import { type grammar } from "./grammar.ts";
import { analyze } from "./analyze.ts";

export type expectation = "ok" | "bad" | "none" | "unknown";

export type corpus_case = { label: expectation; sentence: string; detail?: string; line: number };
export type case_result = { c: corpus_case; passed: boolean; got: string; reason?: string };

// label -> the analyze() verdict it asserts
const VERDICT: Record<expectation, string> = {
    ok: "grammatical",
    bad: "ungrammatical",
    none: "no-analysis",
    unknown: "unknown-word",
};

// One case per line:  <label> | <sentence> [| <detail>]
//   ok      grammatical
//   bad     ungrammatical; detail = a substring the reported violation's message
//           or rule must contain (the explanation, not just the verdict)
//   none    no-analysis (out of coverage)
//   unknown unknown-word; detail = comma-separated expected unknown words
// '#' lines and blank lines are ignored.
export function parse_corpus(text: string): corpus_case[] {
    const out: corpus_case[] = [];
    const lines = text.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();

        if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

        const parts = trimmed.split("|").map((p) => p.trim());
        const label = parts[0] as expectation;

        if (!(label in VERDICT)) throw new Error(`corpus line ${i + 1}: unknown label '${parts[0]}'`);
        if (!parts[1]) throw new Error(`corpus line ${i + 1}: missing sentence`);

        out.push({ label, sentence: parts[1], detail: parts[2] || undefined, line: i + 1 });
    }

    return out;
}

export function run_case(g: grammar, c: corpus_case): case_result {
    const a = analyze(g, c.sentence);
    const want = VERDICT[c.label];

    if (a.verdict !== want) {
        return { c, passed: false, got: a.verdict, reason: `expected ${want}, got ${a.verdict}` };
    }

    // For an ungrammatical case, the *explanation* matters: a detail must match
    // some reported violation's message or rule (case-insensitive substring).
    if (c.label === "bad" && c.detail) {
        const needle = c.detail.toLowerCase();
        const hit = a.violations.some(
            (v) => v.message.toLowerCase().includes(needle) || v.rule.toLowerCase().includes(needle),
        );

        if (!hit) {
            const got = a.violations.map((v) => v.message).join(" / ") || "(none)";
            return { c, passed: false, got: a.verdict, reason: `no violation matched '${c.detail}' (got: ${got})` };
        }
    }

    if (c.label === "unknown" && c.detail) {
        const want_words = JSON.stringify(c.detail.split(",").map((w) => w.trim().toLowerCase()).sort());
        const got_words = JSON.stringify([...a.unknown_words].map((w) => w.toLowerCase()).sort());

        if (want_words !== got_words) {
            return { c, passed: false, got: a.verdict, reason: `unknown words ${got_words} != expected ${want_words}` };
        }
    }

    return { c, passed: true, got: a.verdict };
}

export function run_corpus(g: grammar, cases: corpus_case[]): case_result[] {
    return cases.map((c) => run_case(g, c));
}
