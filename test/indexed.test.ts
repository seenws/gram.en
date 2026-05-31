import test from "node:test";
import assert from "node:assert/strict";
import { parse_grammar } from "../src/grammar.ts";
import { analyze } from "../src/analyze.ts";

// Indexed constituent addressing: a production may carry two daughters of the
// same category, each addressed by an alias and constrained independently --
// impossible under the old symbol-keyed equation environment.

// -- ditransitive: two NP objects, constrained and reported independently ------

const ditrans = parse_grammar(`
S -> subj:NP VP
VP -> V obj1:NP obj2:NP
    <obj1 case> = acc   ! "first object must be accusative"   fix: a
    <obj2 case> = acc   ! "second object must be accusative"  fix: b
gave : V
I   : NP <case>=nom
me  : NP <case>=acc
him : NP <case>=acc
`);

test("ditransitive: both objects accusative parses cleanly", () => {
    assert.equal(analyze(ditrans, "I gave him me").verdict, "grammatical");
});

test("ditransitive: a bad first object is flagged on the first object", () => {
    const a = analyze(ditrans, "I gave I him");
    assert.equal(a.verdict, "ungrammatical");
    assert.match(a.violations[0].message, /first object/);
    assert.deepEqual(a.violations[0].span, [2, 3]); // the second token "I" = obj1
});

test("ditransitive: a bad second object is flagged on the second object", () => {
    const a = analyze(ditrans, "I gave him I");
    assert.equal(a.verdict, "ungrammatical");
    assert.match(a.violations[0].message, /second object/);
    assert.deepEqual(a.violations[0].span, [3, 4]); // the last token "I" = obj2
});

// -- coordination: a rule with two same-category daughters ---------------------

const coord = parse_grammar(`
S -> subj:NP pred:V
    <subj num> = <pred num>  ! "subject-verb number agreement"  fix: x
NP -> N
    <NP num> = <N num>
NP -> NP Conj NP
    <NP num> = pl
dog : N <num>=sg
cat : N <num>=sg
and : Conj
bark  : V <num>=pl
barks : V <num>=sg
`);

test("coordination: two singular NPs coordinate to a plural subject", () => {
    assert.equal(analyze(coord, "dog and cat bark").verdict, "grammatical");
});

test("coordination: a coordinated (plural) subject with a singular verb is flagged", () => {
    assert.equal(analyze(coord, "dog and cat barks").verdict, "ungrammatical");
});

test("coordination: a single noun stays singular", () => {
    assert.equal(analyze(coord, "dog barks").verdict, "grammatical");
    assert.equal(analyze(coord, "dog bark").verdict, "ungrammatical");
});

// -- backward compatibility ----------------------------------------------------

test("bare unique categories still resolve (no aliases needed)", () => {
    assert.doesNotThrow(() => parse_grammar(`
S -> NP VP
    <NP num> = <VP num>
NP -> Det N
    <NP num> = <N num>
`));
});

test("a same-category daughter with no equations still percolates the head", () => {
    const g = parse_grammar(`
S -> NP V
    <NP num> = <V num>
NP -> Det N
    <NP num> = <N num>
NP -> NP PP
PP -> P NP
the : Det
dog : N <num>=sg
on : P
barks : V <num>=sg
`);
    // NP -> NP PP carries no equations; the mother must still inherit the head
    // NP's num=sg so subject-verb agreement sees it.
    assert.equal(analyze(g, "the dog on the dog barks").verdict, "grammatical");
});

// -- load-time resolution errors -----------------------------------------------

test("a duplicated daughter category referenced without an alias is a load error", () => {
    // two NP daughters; bare <NP ...> can't pick one (the LHS here is VP)
    assert.throws(
        () => parse_grammar("VP -> V NP NP\n    <NP case> = acc"),
        /ambiguous constituent 'NP'/,
    );
});

test("the LHS category always denotes the mother, even when daughters share it", () => {
    // NP -> NP Conj NP: bare <NP ...> is the mother; no alias needed for it
    assert.doesNotThrow(() => parse_grammar("NP -> NP Conj NP\n    <NP num> = pl"));
});

test("an unknown constituent is a load error", () => {
    assert.throws(
        () => parse_grammar("S -> NP VP\n    <XP num> = sg"),
        /unknown constituent 'XP'/,
    );
});

test("a duplicate alias is a load error", () => {
    assert.throws(
        () => parse_grammar("NP -> x:NP Conj x:NP\n    <x num> = pl"),
        /duplicate alias 'x'/,
    );
});
