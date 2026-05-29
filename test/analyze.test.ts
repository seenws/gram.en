import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse_grammar } from "../src/grammar.ts";
import { analyze } from "../src/analyze.ts";
import { build_lex_items } from "../src/parser.ts";

const here = dirname(fileURLToPath(import.meta.url));
const g = parse_grammar(readFileSync(join(here, "..", "languages", "en.gram"), "utf8"));

// A self-contained grammar that exercises the morphology path: "puppy" and
// "puppies" are reachable only through the N-reg-y paradigm, not via an
// explicit lexicon entry.
const morph_g = parse_grammar(`
S -> NP VP
    <NP vagr> = <VP vagr>   ! "subject-verb agreement"  fix: agree-verb

NP -> Det N
    <NP num>  = <N num>
    <NP vagr> = <N vagr>

VP -> V
    <VP vagr> = <V vagr>

the   : Det

# verb forms are still explicit -- only the noun comes from the paradigm
barks : V  <vagr>=3sg   <lemma>=bark
bark  : V  <vagr>=n3sg  <lemma>=bark

%lex Root
    pupp : N-reg-y <lemma>=puppy

%lex N-reg-y : N
    +N+Sg : y   <num>=sg <pers>=3 <vagr>=3sg
    +N+Pl : ies <num>=pl <pers>=3 <vagr>=n3sg
`);

test("grammatical controls parse cleanly", () => {
    assert.equal(analyze(g, "the dog barks").verdict, "grammatical");
    assert.equal(analyze(g, "dogs bark").verdict, "grammatical");
    assert.equal(analyze(g, "the cat chased the dog").verdict, "grammatical");
});

test("unknown word is reported, not called ungrammatical", () => {
    const a = analyze(g, "glorp barks");
    assert.equal(a.verdict, "unknown-word");
    assert.deepEqual(a.unknown_words, ["glorp"]);
});

// Morphological mal-rules (Phase 8) -------------------------------------------

test("'the children bark' parses cleanly via the irregular plural", () => {
    assert.equal(analyze(g, "the children bark").verdict, "grammatical");
});

test("'the childs bark' fires the morph mal-rule, not unknown-word", () => {
    const a = analyze(g, "the childs bark");
    assert.equal(a.verdict, "ungrammatical");
    assert.equal(a.unknown_words.length, 0);
    const v = a.violations[0];
    assert.ok(v, "expected a morph violation");
    assert.equal(v.rule, "morph");
    assert.match(v.message, /irregular plural/i);
    assert.ok(v.fixes.includes("the children bark"), `fixes ${JSON.stringify(v.fixes)}`);
});

test("morph error highlights only the offending token", () => {
    const a = analyze(g, "the childs bark");
    assert.deepEqual(a.violations[0].span, [1, 2]);
});

test("clean noun analysis carries no morph_err (negative control)", () => {
    const lex = build_lex_items(g, ["dog"]);
    assert.equal(lex[0].length, 1);
    assert.equal(lex[0][0].morph_err, undefined);
});

test("agreement-fix suggestions never propose a known-wrong morphology", () => {
    // *childs is in the FST as an error-tagged entry. A fix for an unrelated
    // agreement error must not surface "childs" as a candidate plural form.
    const a = analyze(g, "the dog bark");
    for (const v of a.violations) {
        for (const fix of v.fixes) {
            assert.ok(!fix.includes("childs"), `fix should not propose '*childs': ${fix}`);
        }
    }
});

test("paradigm-derived forms reach the parser via morph_analyze", () => {
    // 'puppy' and 'puppies' are not in the explicit lexicon of morph_g
    assert.equal(morph_g.lexicon.has("puppy"), false);
    assert.equal(morph_g.lexicon.has("puppies"), false);

    // ...but both parse, because the N-reg-y paradigm derives them
    assert.equal(analyze(morph_g, "the puppy barks").verdict, "grammatical");
    assert.equal(analyze(morph_g, "the puppies bark").verdict, "grammatical");

    // and number-disagreement is still caught against the derived form
    const bad = analyze(morph_g, "the puppy bark");
    assert.equal(bad.verdict, "ungrammatical");
    assert.match(bad.violations[0].message, /agreement/i);
});

const cases: [string, string, RegExp, string][] = [
    ["the dog bark", "S -> NP VP", /subject-verb agreement/i, "the dog barks"],
    ["the dog bark", "S -> NP VP", /subject-verb agreement/i, "the dogs bark"],
    ["the dogs barks", "S -> NP VP", /subject-verb agreement/i, "the dogs bark"],
    ["these dog barks", "NP -> Det N", /determiner-noun/i, "this dog barks"],
    ["an dog barks", "NP -> Det N", /article form/i, "a dog barks"],
    ["i like dog", "NP -> N", /need.*determiner/i, "i like the dog"],
    ["a dogs bark", "NP -> Det N", /determiner-noun/i, "the dogs bark"],
    ["me like dogs", "S -> NP VP", /nominative/i, "I like dogs"],
    ["the cat chased I", "VP -> V NP", /accusative/i, "the cat chased me"],
    ["barks the dog", "S -> V NP", /word order/i, "the dog barks"],
];

for (const [sentence, rule, msg, fix] of cases) {
    test(`"${sentence}" -> ${rule} (offers "${fix}")`, () => {
        const a = analyze(g, sentence);
        assert.equal(a.verdict, "ungrammatical", `verdict for "${sentence}"`);
        const v = a.violations[0];
        assert.ok(v, "expected at least one violation");
        assert.equal(v.rule, rule);
        assert.match(v.message, msg);
        assert.ok(v.fixes.includes(fix), `fixes ${JSON.stringify(v.fixes)} should include "${fix}"`);
    });
}

test('span for "the dog bark" highlights the verb', () => {
    const a = analyze(g, "the dog bark");
    assert.deepEqual(a.violations[0].span, [2, 3]);
});

test('"me like dog" reports both the case and the missing-determiner errors', () => {
    const a = analyze(g, "me like dog");
    assert.equal(a.verdict, "ungrammatical");
    const messages = a.violations.map((v) => v.message).join(" | ");
    assert.match(messages, /nominative/i);
    assert.match(messages, /need.*determiner/i);
});

// ----- PP attachment (left recursion) ----------------------------------------

test("PP modifier on the subject NP parses (NP -> NP PP, left-recursive)", () => {
    assert.equal(analyze(g, "the dog with the cat barks").verdict, "grammatical");
});

test("PP modifier on the VP parses (VP -> VP PP, left-recursive)", () => {
    assert.equal(analyze(g, "the dog barks with the cat").verdict, "grammatical");
});

test("genuinely ambiguous PP attachment still resolves to grammatical", () => {
    // "with the dog" can attach to the object NP (NP -> NP PP) or to the VP
    // (VP -> VP PP); both are valid, and packing must not explode or drop them.
    assert.equal(analyze(g, "the cat chased the dog with the dog").verdict, "grammatical");
});

test("deep PP nesting terminates (regression for the old stack-overflow)", () => {
    const deep = "the dog" + " with the cat".repeat(15) + " barks";
    let verdict: string | undefined;
    assert.doesNotThrow(() => {
        verdict = analyze(g, deep).verdict;
    });
    assert.equal(verdict, "grammatical");
});

test("object of a preposition must be accusative", () => {
    assert.equal(analyze(g, "the dog with him barks").verdict, "grammatical");

    const a = analyze(g, "the dog with he barks");
    assert.equal(a.verdict, "ungrammatical");
    const v = a.violations[0];
    assert.ok(v, "expected a violation");
    assert.match(v.message, /accusative/i);
    assert.ok(v.fixes.includes("the dog with him barks"), `fixes ${JSON.stringify(v.fixes)}`);
});
