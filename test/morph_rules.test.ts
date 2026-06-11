import test from "node:test";
import assert from "node:assert/strict";
import { apply_down, apply_up, tokenize_symbols, show_symbols } from "../src/fst.ts";
import {
    type rule_spec,
    compile_rule,
    compile_cascade,
    apply_cascade_down,
    apply_cascade_up,
    parse_rule,
    identity_star,
} from "../src/morph_rules.ts";

const SIGMA = ["a", "b", "c", "d", "e", "g", "i", "k", "l", "n", "o", "r", "s", "t", "u", "y", "+s", "+ed", "+ing", "+Pl"];

function down(spec: rule_spec, input: string | string[]): string[] {
    const syms = typeof input === "string" ? tokenize_symbols(input) : input;

    return apply_down(compile_rule(SIGMA, spec), syms).map(show_symbols).sort();
}


// -- identity ----------------------------------------------------------------

test("identity_star: any string over sigma maps to itself", () => {
    const f = identity_star(SIGMA);

    assert.deepEqual(apply_down(f, "").map(show_symbols), [""]);
    assert.deepEqual(apply_down(f, "cat").map(show_symbols), ["cat"]);
    assert.deepEqual(apply_down(f, tokenize_symbols("dog+Pl")).map(show_symbols), ["dog+Pl"]);
});


// -- no-context substitution -------------------------------------------------

test("substitution without context: every match is a rewrite candidate (optional)", () => {
    const rule: rule_spec = { in: ["a"], out: ["b"] };

    assert.deepEqual(down(rule, "aa"), ["aa", "ab", "ba", "bb"]);
    assert.deepEqual(down(rule, "c"), ["c"]);
});

test("deletion: in -> [] removes a symbol (optionally)", () => {
    const rule: rule_spec = { in: ["e"], out: [] };

    assert.deepEqual(down(rule, "be"), ["b", "be"]);
});


// -- right context -----------------------------------------------------------

test("right context: rule fires only when the next symbols match", () => {
    const rule: rule_spec = { in: ["y"], out: ["i"], right: ["+s"] };

    assert.deepEqual(down(rule, tokenize_symbols("try+s")), ["tri+s", "try+s"]);
    // no right context => only identity
    assert.deepEqual(down(rule, "try"), ["try"]);
});

test("right context with deletion: e:0 => _ +ing", () => {
    const rule: rule_spec = { in: ["e"], out: [], right: ["+ing"] };

    assert.deepEqual(
        down(rule, tokenize_symbols("like+ing")),
        ["lik+ing", "like+ing"],
    );
});


// -- left context ------------------------------------------------------------

test("left context: rule fires only after the matching prefix", () => {
    const rule: rule_spec = { in: ["+s"], out: ["e", "s"], left: ["s"] };
    const results = down(rule, tokenize_symbols("buss+s"));

    assert.ok(results.includes("busses"));
    assert.ok(results.includes("buss+s"));
});


// -- text syntax parsing -----------------------------------------------------

test("parse_rule: bare rewrite", () => {
    assert.deepEqual(parse_rule("a:b"), { in: ["a"], out: ["b"], left: [], right: [] });
});

test("parse_rule: deletion via the 0 literal", () => {
    assert.deepEqual(parse_rule("e:0"), { in: ["e"], out: [], left: [], right: [] });
});

test("parse_rule: pure insertion (0:s) is rejected at parse time", () => {
    // ε-input loops through the optional-replace Kleene star are not supported
    // by epsilon_eliminate; the rule compiler refuses them up front.
    assert.throws(() => parse_rule("0:s"), /pure-insertion/);
});

test("parse_rule: right context", () => {
    assert.deepEqual(
        parse_rule("y:i => _ +s"),
        { in: ["y"], out: ["i"], left: [], right: ["+s"] },
    );
});

test("parse_rule: left context with a multi-char output sequence", () => {
    assert.deepEqual(
        parse_rule("+s:es => s _"),
        { in: ["+s"], out: ["e", "s"], left: ["s"], right: [] },
    );
});

test("parse_rule: both contexts", () => {
    assert.deepEqual(
        parse_rule("a:b => c _ d"),
        { in: ["a"], out: ["b"], left: ["c"], right: ["d"] },
    );
});

test("parse_rule: missing ':' is an error", () => {
    assert.throws(() => parse_rule("abc"));
});

test("parse_rule: context missing '_' is an error", () => {
    assert.throws(() => parse_rule("a:b => c"));
});


// -- character classes -------------------------------------------------------

test("parse_rule: a class name stays a single symbol (not split into chars)", () => {
    const classes = new Map([["Cons", ["b", "c", "d"]]]);

    assert.deepEqual(
        parse_rule("e:0 => Cons _", classes),
        { in: ["e"], out: [], left: ["Cons"], right: [] },
    );
    // without the class table, "Cons" would tokenize into c,o,n,s
    assert.deepEqual(parse_rule("e:0 => Cons _").left, ["C", "o", "n", "s"]);
});

test("compile_rule: a class context matches any one member", () => {
    const classes = new Map([["Cons", ["b", "c", "d"]]]);
    const rule = parse_rule("e:i => Cons _", classes);
    const f = compile_rule(SIGMA, rule, classes);
    const down = (s: string) => apply_down(f, tokenize_symbols(s)).map(show_symbols).sort();

    // 'be' / 'de': e follows a consonant -> optionally rewritten
    assert.deepEqual(down("be"), ["be", "bi"]);
    assert.deepEqual(down("de"), ["de", "di"]);
    // 'ae': e follows a vowel (not in Cons) -> only identity
    assert.deepEqual(down("ae"), ["ae"]);
});


// -- cascade -----------------------------------------------------------------

test("compile_cascade: empty cascade is identity (input passes through)", () => {
    const cs = compile_cascade(SIGMA, []);
    const r = apply_cascade_down(cs, "cat").map(show_symbols);

    assert.deepEqual(r, ["cat"]);
});

test("compile_cascade: rules apply in order, output of one feeds the next", () => {
    // R1: a -> b; R2: b -> c. Each is optional, so input "a" admits {a, b, c}.
    const cs = compile_cascade(SIGMA, [
        { in: ["a"], out: ["b"] },
        { in: ["b"], out: ["c"] },
    ]);
    const r = apply_cascade_down(cs, "a").map(show_symbols).sort();

    assert.deepEqual(r, ["a", "b", "c"]);
});

test("apply_cascade_up runs the cascade backwards for analysis", () => {
    // Same cascade as above. Going up from "c" should reach all of {a, b, c}.
    const cs = compile_cascade(SIGMA, [
        { in: ["a"], out: ["b"] },
        { in: ["b"], out: ["c"] },
    ]);
    const r = apply_cascade_up(cs, "c").map(show_symbols).sort();

    assert.deepEqual(r, ["a", "b", "c"]);
});


// -- end-to-end: parse a rule, compile, recover the underlying form ----------

test("apply_up against a y:i rule recovers the underlying form", () => {
    const rule = parse_rule("y:i => _ +s");
    const variants = apply_up(compile_rule(SIGMA, rule), tokenize_symbols("tri+s")).map(show_symbols);

    assert.ok(variants.includes("try+s"));
});
