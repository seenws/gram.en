import test from "node:test";
import assert from "node:assert/strict";
import { parse_grammar } from "../src/grammar.ts";
import { analyze } from "../src/analyze.ts";

// A deliberately tiny, feature-free grammar whose only point is to exercise LEFT
// RECURSION (NP -> NP PP). The previous recursive-descent parser set its memo
// only after computing results, so parse_sym("NP", i) recursed into itself before
// the memo existed and overflowed the stack. The Earley engine terminates this
// via predictor dedup. These tests fix that behavior in isolation from en.gram.
const g = parse_grammar(`
the   : Det
dog   : N
with  : P
barks : V

S  -> NP VP
NP -> Det N
NP -> NP PP
PP -> P NP
VP -> V
`);

test("left-recursive grammar parses the base case", () => {
    assert.equal(analyze(g, "the dog barks").verdict, "grammatical");
});

test("one application of the left-recursive rule parses", () => {
    assert.equal(analyze(g, "the dog with the dog barks").verdict, "grammatical");
});

test("deep left recursion terminates and parses (old engine overflowed here)", () => {
    // each "with the dog" re-enters NP -> NP PP; the old parser never returned.
    const deep = "the dog" + " with the dog".repeat(20) + " barks";
    let verdict: string | undefined;
    assert.doesNotThrow(() => {
        verdict = analyze(g, deep).verdict;
    });
    assert.equal(verdict, "grammatical");
});
