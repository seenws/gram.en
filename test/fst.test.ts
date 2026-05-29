import test from "node:test";
import assert from "node:assert/strict";
import {
    type fst,
    EPS,
    eps,
    symbol,
    pair,
    concat,
    concat_many,
    union,
    union_many,
    kleene,
    optional,
    compose,
    invert,
    apply_down,
    apply_up,
    tokenize_symbols,
    show_symbols,
    epsilon_eliminate,
} from "../src/fst.ts";

// -- primitives --------------------------------------------------------------

test("eps accepts empty input only", () => {
    assert.deepEqual(apply_down(eps(), ""), [[]]);
    assert.deepEqual(apply_down(eps(), "x"), []);
});

test("symbol is the identity transducer for one symbol", () => {
    const f = symbol("a");

    assert.deepEqual(apply_down(f, "a"), [["a"]]);
    assert.deepEqual(apply_down(f, "b"), []);
    assert.deepEqual(apply_down(f, ""), []);
    assert.deepEqual(apply_down(f, "aa"), []);
});

test("pair maps a single input symbol to a single output symbol", () => {
    const f = pair("a", "b");

    assert.deepEqual(apply_down(f, "a"), [["b"]]);
    assert.deepEqual(apply_up(f, "b"), [["a"]]);
    assert.deepEqual(apply_down(f, "b"), []);
});

// -- combinators -------------------------------------------------------------

test("concat threads two transducers end to end", () => {
    const f = concat(symbol("a"), symbol("b"));

    assert.deepEqual(apply_down(f, "ab"), [["a", "b"]]);
    assert.deepEqual(apply_down(f, "a"), []);
    assert.deepEqual(apply_down(f, "ba"), []);
});

test("concat_many handles 0, 1, and many", () => {
    assert.deepEqual(apply_down(concat_many([]), ""), [[]]);
    assert.deepEqual(apply_down(concat_many([symbol("a")]), "a"), [["a"]]);
    const abc = concat_many(["a", "b", "c"].map(symbol));
    assert.deepEqual(apply_down(abc, "abc"), [["a", "b", "c"]]);
});

test("union accepts either branch", () => {
    const f = union(symbol("a"), symbol("b"));

    assert.deepEqual(apply_down(f, "a"), [["a"]]);
    assert.deepEqual(apply_down(f, "b"), [["b"]]);
    assert.deepEqual(apply_down(f, "c"), []);
});

test("union_many: empty -> empty language; single -> identity", () => {
    assert.deepEqual(apply_down(union_many([]), ""), []);
    assert.deepEqual(apply_down(union_many([]), "a"), []);
    assert.deepEqual(apply_down(union_many([symbol("a")]), "a"), [["a"]]);
});

test("union surfaces multiple analyses for the same input", () => {
    // Two ways to map "a": to "x" and to "y" -- ambiguity must propagate.
    const f = union(pair("a", "x"), pair("a", "y"));
    const results = apply_down(f, "a").map(show_symbols).sort();

    assert.deepEqual(results, ["x", "y"]);
});

test("kleene accepts zero or more iterations", () => {
    const f = kleene(symbol("a"));

    assert.deepEqual(apply_down(f, ""), [[]]);
    assert.deepEqual(apply_down(f, "a"), [["a"]]);
    assert.deepEqual(apply_down(f, "aaa"), [["a", "a", "a"]]);
    assert.deepEqual(apply_down(f, "b"), []);
});

test("optional accepts zero or one occurrence", () => {
    const f = optional(symbol("a"));

    assert.deepEqual(apply_down(f, ""), [[]]);
    assert.deepEqual(apply_down(f, "a"), [["a"]]);
    assert.deepEqual(apply_down(f, "aa"), []);
});

// -- inversion ---------------------------------------------------------------

test("invert swaps input and output sides", () => {
    const f = pair("a", "b");
    const g = invert(f);

    assert.deepEqual(apply_down(g, "b"), [["a"]]);
    assert.deepEqual(apply_up(g, "a"), [["b"]]);
});

// -- composition -------------------------------------------------------------

test("compose chains two relations: a:b composed with b:c gives a:c", () => {
    const f = compose(pair("a", "b"), pair("b", "c"));

    assert.deepEqual(apply_down(f, "a"), [["c"]]);
    assert.deepEqual(apply_up(f, "c"), [["a"]]);
});

test("compose preserves identity through identity transducers", () => {
    const f = compose(symbol("a"), symbol("a"));

    assert.deepEqual(apply_down(f, "a"), [["a"]]);
});

test("compose with epsilons on the seam (output of A is EPS, input of B is EPS)", () => {
    // A: "a" -> "" (deletes); B: "" stays put; composition: "a" -> ""
    // Build A as pair("a", EPS) and B as eps().
    const f = compose(pair("a", EPS), eps());

    assert.deepEqual(apply_down(f, "a"), [[]]);
});

test("compose: rule inserts a tag epsilon", () => {
    // A: identity for "a"; B: emit "+N" via pair(EPS, "+N") concat identity for "a"
    // So the composition reads "a" and emits "+N" then "a" -- order depends on
    // how we chain. Just verify a hand-built example end to end.
    const a = symbol("a");
    const insert_tag = concat(pair(EPS, "+N"), symbol("a"));
    const f = compose(a, insert_tag);

    const results = apply_down(f, "a").map(show_symbols);
    assert.deepEqual(results, ["+Na"]);
});

// -- end-to-end: a hand-built dog/dogs analyzer -----------------------------

test("hand-built dog/dogs analyzer: apply_down surface -> lexical", () => {
    // Surface "dog"  -> lexical "dog+N+Sg" (no +s on surface)
    // Surface "dogs" -> lexical "dog+N+Pl" (the +s is consumed on surface;
    //                                       +Pl appears on lexical only)
    //
    // States:
    //   0 -d:d-> 1 -o:o-> 2 -g:g-> 3
    //   3 -EPS:+N-> 4
    //   4 -EPS:+Sg-> F1                    (singular: stop, no +s on surface)
    //   4 -s:+Pl-> F2                      (plural: consume "s", emit +Pl)
    //
    // Both F1 (state 5) and F2 (state 6) are final.

    const f: fst = {
        n_states: 7,
        initial: 0,
        finals: new Set([5, 6]),
        out_arcs: [
            [{ in: "d", out: "d", to: 1 }],
            [{ in: "o", out: "o", to: 2 }],
            [{ in: "g", out: "g", to: 3 }],
            [{ in: EPS, out: "+N", to: 4 }],
            [
                { in: EPS, out: "+Sg", to: 5 },
                { in: "s", out: "+Pl", to: 6 },
            ],
            [],
            [],
        ],
    };

    assert.deepEqual(apply_down(f, "dog").map(show_symbols), ["dog+N+Sg"]);
    assert.deepEqual(apply_down(f, "dogs").map(show_symbols), ["dog+N+Pl"]);
    assert.deepEqual(apply_down(f, "do"), []);
    assert.deepEqual(apply_down(f, "dogss"), []);
});

test("hand-built dog/dogs analyzer: apply_up lexical -> surface (generation)", () => {
    // Same FST as above. Lexical inputs need to be tokenised so +N and +Pl
    // arrive as single symbols rather than three characters each.
    const f: fst = {
        n_states: 7,
        initial: 0,
        finals: new Set([5, 6]),
        out_arcs: [
            [{ in: "d", out: "d", to: 1 }],
            [{ in: "o", out: "o", to: 2 }],
            [{ in: "g", out: "g", to: 3 }],
            [{ in: EPS, out: "+N", to: 4 }],
            [
                { in: EPS, out: "+Sg", to: 5 },
                { in: "s", out: "+Pl", to: 6 },
            ],
            [],
            [],
        ],
    };

    assert.deepEqual(
        apply_up(f, tokenize_symbols("dog+N+Sg")).map(show_symbols),
        ["dog"],
    );
    assert.deepEqual(
        apply_up(f, tokenize_symbols("dog+N+Pl")).map(show_symbols),
        ["dogs"],
    );
});

// -- symbol-string helpers ---------------------------------------------------

test("tokenize_symbols treats +TAG as a single symbol, otherwise characters", () => {
    assert.deepEqual(tokenize_symbols("dog"), ["d", "o", "g"]);
    assert.deepEqual(tokenize_symbols("dog+N+Pl"), ["d", "o", "g", "+N", "+Pl"]);
    assert.deepEqual(tokenize_symbols("+A1b+B2"), ["+A1b", "+B2"]);
});

test("show_symbols joins on empty string", () => {
    assert.equal(show_symbols(["d", "o", "g", "+N", "+Pl"]), "dog+N+Pl");
    assert.equal(show_symbols([]), "");
});

// -- epsilon_eliminate -------------------------------------------------------

test("epsilon_eliminate: a constructed ε-input chain folds into preceding arcs", () => {
    // 0 -a:a-> 1 -ε:+N-> 2 -ε:+Sg-> 3 (final)
    const f: fst = {
        n_states: 4,
        initial: 0,
        finals: new Set([3]),
        out_arcs: [
            [{ in: "a", out: "a", to: 1 }],
            [{ in: EPS, out: "+N", to: 2 }],
            [{ in: EPS, out: "+Sg", to: 3 }],
            [],
        ],
    };
    const elim = epsilon_eliminate(f);

    // semantics preserved
    assert.deepEqual(apply_down(elim, "a").map(show_symbols), ["a+N+Sg"]);
    assert.deepEqual(apply_up(elim, tokenize_symbols("a+N+Sg")).map(show_symbols), ["a"]);

    // structure: no ε-input arcs remain anywhere
    for (const row of elim.out_arcs) {
        for (const a of row) assert.notEqual(a.in, EPS, `unexpected ε-input arc: ${JSON.stringify(a)}`);
    }
});

test("epsilon_eliminate: ε-input cycle terminates (no infinite loop)", () => {
    // A 2-state ε-input cycle around a path that accepts "a":
    // 0 -ε:ε-> 1 -ε:ε-> 0  (cycle)
    // 0 -a:a-> 2 (final)
    const f: fst = {
        n_states: 3,
        initial: 0,
        finals: new Set([2]),
        out_arcs: [
            [
                { in: EPS, out: EPS, to: 1 },
                { in: "a", out: "a", to: 2 },
            ],
            [{ in: EPS, out: EPS, to: 0 }],
            [],
        ],
    };
    const elim = epsilon_eliminate(f);

    assert.deepEqual(apply_down(elim, "a").map(show_symbols), ["a"]);
});

test("epsilon_eliminate: optional kleene rule applies and identifies cleanly", () => {
    // An "optional-replace" rule for a:b: kleene(union(id_a, pair(a, b))).
    // Without elimination this is ε-dense (kleene + union seams). After
    // elimination apply must still surface both "a stays a" and "a becomes b".
    const id_a = symbol("a");
    const rule = epsilon_eliminate(kleene(union(id_a, pair("a", "b"))));
    const out = apply_down(rule, "a").map(show_symbols).sort();

    assert.deepEqual(out, ["a", "b"]);
});

test("epsilon_eliminate: regression for the cascade-blowup probe", () => {
    // Pre-R1, applying a composed cascade of optional rules on length-1
    // input hung past 30s due to exponential ε-density in DFS. After
    // elimination, the same composition applies in milliseconds.
    const sigma = ["a", "b"];
    const rule_a: fst = epsilon_eliminate(
        kleene(union(union(symbol("a"), symbol("b")), pair("a", "b"))),
    );
    const rule_b: fst = epsilon_eliminate(
        kleene(union(union(symbol("a"), symbol("b")), pair("b", "a"))),
    );
    const composed = epsilon_eliminate(compose(rule_a, rule_b));
    const start = Date.now();
    const out = apply_down(composed, "a");
    const elapsed = Date.now() - start;

    assert.ok(out.length > 0, "expected at least one analysis");
    assert.ok(elapsed < 1000, `cascade apply took ${elapsed}ms`);
});

// -- regression: ambiguity in a kleene loop ---------------------------------

test("union under kleene yields the cross-product of paths", () => {
    // (a|b)* on input "ab" should produce a single result: [a, b] (the
    // identity output through the union arms).
    const f = kleene(union(symbol("a"), symbol("b")));

    const results = apply_down(f, "ab").map(show_symbols).sort();
    assert.deepEqual(results, ["ab"]);
});
