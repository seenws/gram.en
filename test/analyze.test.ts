import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse_grammar } from "../src/grammar.ts";
import { analyze } from "../src/analyze.ts";
import { build_lex_items } from "../src/parser.ts";

const here = dirname(fileURLToPath(import.meta.url));
const gram_dir = join(here, "..", "languages", "english");
const resolve = (rel: string): string => readFileSync(join(gram_dir, rel), "utf8");
const g = parse_grammar(readFileSync(join(gram_dir, "en.gram"), "utf8"), { resolve });

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

// Clitics (contractions) -----------------------------------------------------

test("contracted copula and auxiliary clitics parse", () => {
    for (const s of [
        "he's a dog",        // 's = is (copula)
        "I'm a dog",         // 'm = am
        "they're dogs",      // 're = are
        "I don't bark",      // do + n't
        "he doesn't bark",   // does + n't
        "I'll bark",         // 'll = will (modal)
        "he'll bark",        // modal: no agreement, so 3sg subject is fine
        "I've liked the dog", // 've = have (perfect)
        "he's liked the dog", // 's = has
        "I'd bark",          // 'd = would
    ]) {
        assert.equal(analyze(g, s).verdict, "grammatical", `expected grammatical: ${s}`);
    }
});

// Trace / debug mode ---------------------------------------------------------

test("trace mode emits morphology and chart lines without changing the verdict", () => {
    const lines: string[] = [];
    const a = analyze(g, "the dog barks", { trace: (l) => lines.push(l) });

    // verdict is unchanged by tracing
    assert.equal(a.verdict, "grammatical");

    const dump = lines.join("\n");
    assert.match(dump, /=== morphology ===/);
    assert.match(dump, /\[0\] "the"/);            // per-token morphology
    assert.match(dump, /predict <NP>/);            // a predict step
    assert.match(dump, /scan <Pron> ✗/);           // a scan miss is flagged
    assert.match(dump, /complete <S>/);            // the start symbol completes
    assert.match(dump, /=== final chart ===|final chart/); // chart dump header
});

test("trace flags where scanning dead-ends on an uncovered sentence", () => {
    const lines: string[] = [];
    analyze(g, "the dog the dog", { trace: (l) => lines.push(l) });
    // no verb after the subject NP -> the VP scans dead-end
    assert.ok(lines.some((l) => /scan <V> ✗/.test(l)));
});

test("not passing a tracer leaves analysis silent (no trace coupling)", () => {
    // a plain call must behave exactly as before tracing existed
    assert.equal(analyze(g, "the dog barks").verdict, "grammatical");
});

test("clitic agreement and case errors are caught", () => {
    // "I's" -- 's is 3sg, subject I is not
    assert.equal(analyze(g, "I's a dog").verdict, "ungrammatical");
    // "he don't" -- do is non-3sg, subject he is 3sg
    assert.equal(analyze(g, "he don't bark").verdict, "ungrammatical");
    // subject case still enforced through the auxiliary phrase
    assert.equal(analyze(g, "me'll bark").verdict, "ungrammatical");
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
    // expanded pronoun paradigm: nom/acc swaps follow the shared lemma
    ["us bark", "S -> NP VP", /nominative/i, "we bark"],
    ["the cat chased she", "VP -> V NP", /accusative/i, "the cat chased her"],
    ["her barks", "S -> NP VP", /nominative/i, "she barks"],
    // expanded determiners: the always-first `the` repair stays within the cap
    ["those dog barks", "NP -> Det N", /determiner-noun/i, "the dog barks"],
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

// ----- expanded closed-class inventory: determiners & pronouns ----------------

const grammatical_forms = [
    "she barks", "it barks", "we bark", "you bark",
    "she chased him", "we chased them",
    "my dog barks", "that dog barks", "those dogs bark",
];

for (const s of grammatical_forms) {
    test(`"${s}" is grammatical`, () => {
        assert.equal(analyze(g, s).verdict, "grammatical");
    });
}

test("case-invariant pronouns fill subject and object alike", () => {
    // `you` and `it` leave <case> unset, so they parse in either position
    assert.equal(analyze(g, "you bark").verdict, "grammatical");
    assert.equal(analyze(g, "the cat chased you").verdict, "grammatical");
    assert.equal(analyze(g, "it barks").verdict, "grammatical");
    assert.equal(analyze(g, "the cat chased it").verdict, "grammatical");
});

test("possessive determiners are number-unmarked (combine with sg and pl nouns)", () => {
    assert.equal(analyze(g, "my dog barks").verdict, "grammatical");
    assert.equal(analyze(g, "my dogs bark").verdict, "grammatical");
});

test("`her` resolves both as a possessive determiner and an accusative pronoun", () => {
    assert.equal(analyze(g, "her dog barks").verdict, "grammatical");   // Det reading
    assert.equal(analyze(g, "the cat chased her").verdict, "grammatical"); // Pron acc reading
});

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
