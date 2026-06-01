import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse_grammar } from "../src/grammar.ts";
import { morph_analyze } from "../src/morph.ts";
import { get_path } from "../src/featstruct.ts";

const here = dirname(fileURLToPath(import.meta.url));
const gram_dir = join(here, "..", "languages", "english");
const resolve = (rel: string): string => readFileSync(join(gram_dir, rel), "utf8");
const g = parse_grammar(readFileSync(join(gram_dir, "en.gram"), "utf8"), { resolve });

test("closed-class forms load as explicit lexicon entries", () => {
    for (const w of ["the", "a", "these", "i", "me"]) {
        assert.ok(g.lexicon.has(w), `missing lexicon entry: ${w}`);
    }
});

test("open-class forms come from paradigms (not explicit lexicon)", () => {
    for (const w of ["dog", "dogs", "cat", "cats", "bark", "barks", "like", "likes"]) {
        assert.equal(g.lexicon.has(w), false, `${w} should be paradigm-derived, not explicit`);
        assert.ok(morph_analyze(g, w).length > 0, `${w} should still be analysable`);
    }
});

test("regular past tense is productive (no explicit entry needed)", () => {
    for (const w of ["chased", "liked", "barked", "tried"]) {
        assert.equal(g.lexicon.has(w), false, `${w} should be paradigm-derived, not explicit`);

        const past = morph_analyze(g, w).find((e) => e.cat === "V");
        assert.ok(past, `${w} should analyse as a verb`);
        assert.deepEqual(get_path(past!.feats, ["tense"]), { kind: "atom", val: "past" });
    }
});

test("the %rule e-deletion recovers the lemma through the spelling change", () => {
    const [chased] = morph_analyze(g, "chased").filter((e) => e.cat === "V");
    assert.equal(chased.form, "chased");
    assert.deepEqual(get_path(chased.feats, ["lemma"]), { kind: "atom", val: "chase" });
});

test("a paradigm-derived noun carries its features", () => {
    const [dog] = morph_analyze(g, "dog");
    assert.equal(dog.cat, "N");
    assert.deepEqual(get_path(dog.feats, ["num"]), { kind: "atom", val: "sg" });
    assert.deepEqual(get_path(dog.feats, ["lemma"]), { kind: "atom", val: "dog" });
});

test("ambiguous form has multiple analyses", () => {
    // "bark" is a noun and a verb; the verb is itself syncretic (base form and
    // non-3sg present), so there are several analyses across two categories.
    const cats = [...new Set(morph_analyze(g, "bark").map((e) => e.cat))].sort();
    assert.deepEqual(cats, ["N", "V"]);
});

test("rules and the mal-rule are present", () => {
    assert.ok(g.rules.some((r) => r.name === "S -> NP VP"));
    assert.ok(g.rules.some((r) => r.name === "NP -> N"));
    assert.equal(g.malrules.length, 1);
    assert.equal(g.malrules[0].name, "S -> V NP");
    assert.match(g.malrules[0].err, /word order/i);
});

test("the subject-verb equation is tagged with a message and fixes", () => {
    const s = g.rules.find((r) => r.name === "S -> NP VP")!;
    const agr = s.eqs.find((e) => e.diag && /agreement/i.test(e.diag.message));
    assert.ok(agr && agr.diag);
    assert.deepEqual(agr.diag.fixes, ["agree-verb", "agree-subject"]);
});

test("en.gram declares N-reg and V-reg paradigms", () => {
    assert.ok(g.morph_fst);
    assert.ok(g.morph.roots.length > 0);
    assert.ok(g.morph.paradigms.has("N-reg"));
    assert.ok(g.morph.paradigms.has("V-reg"));
    assert.equal(g.morph.paradigms.get("N-reg")!.cat, "N");
    assert.equal(g.morph.paradigms.get("V-reg")!.cat, "V");
});

test("%lex block in .gram source populates morph and morph_fst", () => {
    const text = `
NP -> Det N

%lex Root
    dog : N-reg <lemma>=dog

%lex N-reg : N
    +N+Sg :   <num>=sg <pers>=3
    +N+Pl : s <num>=pl <pers>=3
`;
    const h = parse_grammar(text);

    assert.equal(h.morph.roots.length, 1);
    assert.equal(h.morph.roots[0].surface, "dog");
    assert.ok(h.morph.paradigms.has("N-reg"));
    assert.equal(h.morph.paradigms.get("N-reg")!.cat, "N");
    assert.ok(h.morph_fst);

    // the syntactic rule before the %lex blocks is still parsed
    assert.ok(h.rules.some((r) => r.name === "NP -> Det N"));
});

test("en.gram declares its features", () => {
    assert.deepEqual(g.features.get("num"), new Set(["sg", "pl"]));
    assert.equal(g.features.get("lemma"), null); // open feature
});

test("en.gram declares character classes", () => {
    assert.deepEqual(g.classes.get("Vowel"), ["a", "e", "i", "o", "u"]);
    assert.ok(g.classes.get("Cons")?.includes("b"));
});

test("%class parses members split on '|'", () => {
    const h = parse_grammar(`%class Vowel : a | e | i | o | u
S -> NP`);
    assert.deepEqual(h.classes.get("Vowel"), ["a", "e", "i", "o", "u"]);
});

test("a malformed %class fails at load", () => {
    assert.throws(() => parse_grammar("%class Vowel"), /%class needs/);
});

test("a value typo in a declared feature fails at load", () => {
    const text = `%feature num : sg | pl
dog : N <num>=sgular`;
    assert.throws(() => parse_grammar(text), /feature 'num' has undeclared value 'sgular'/);
});

test("an undeclared feature name fails at load", () => {
    const text = `%feature num : sg | pl
dog : N <nmu>=sg`;
    assert.throws(() => parse_grammar(text), /unknown feature 'nmu'/);
});

test("a bad value in a rule equation fails at load", () => {
    const text = `%feature case : nom | acc
S -> NP
    <NP case> = nomm`;
    assert.throws(() => parse_grammar(text), /feature 'case' has undeclared value 'nomm'/);
});

test("a typo in a paradigm entry fails at load", () => {
    const text = `%feature num : sg | pl
%lex Root
    dog : N-reg <lemma>=dog
%lex N-reg : N
    +N+Pl : s <num>=plural`;
    assert.throws(() => parse_grammar(text), /feature 'num' has undeclared value 'plural'/);
});

test("an open feature accepts any value", () => {
    const text = `%feature lemma : *
dog : N <lemma>=anything-goes`;
    assert.doesNotThrow(() => parse_grammar(text));
});

test("a grammar that declares no features opts out of validation", () => {
    // no %feature block -> the typo loads silently (it just never unifies)
    assert.doesNotThrow(() => parse_grammar(`dog : N <num>=sgular`));
});
