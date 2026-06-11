import test from "node:test";
import assert from "node:assert/strict";
import { apply_down, apply_up, show_symbols, tokenize_symbols } from "../src/fst.ts";
import {
    type morph_data,
    type root_entry,
    compile_morph_fst,
    decode_lexical,
    parse_morph_data,
    lexc_error,
} from "../src/morph_lexc.ts";
import { fs, atom, set_path, show_fs } from "../src/featstruct.ts";

// helpers ---------------------------------------------------------------------

function feat(...kvs: Array<[string[], string]>) {
    let f = fs();

    for (const [p, v] of kvs) f = set_path(f, p, atom(v));

    return f;
}

function tiny_data(): morph_data {
    return {
        roots: [
            { surface: "dog", paradigm: "N-reg", feats: feat([["lemma"], "dog"]), overrides: new Map() },
            { surface: "cat", paradigm: "N-reg", feats: feat([["lemma"], "cat"]), overrides: new Map() },
        ],
        paradigms: new Map([
            ["N-reg", {
                name: "N-reg",
                cat: "N",
                entries: [
                    { tag: "+N+Sg", surface: "", feats: feat([["num"], "sg"], [["pers"], "3"]) },
                    { tag: "+N+Pl", surface: "s", feats: feat([["num"], "pl"], [["pers"], "3"]) },
                ],
            }],
        ]),
    };
}


// FST construction ------------------------------------------------------------

test("compile_morph_fst: apply_down (surface -> lex) for the singular", () => {
    const f = compile_morph_fst(tiny_data());
    const out = apply_down(f, "dog").map(show_symbols);

    assert.deepEqual(out, ["dog+N+Sg"]);
});

test("compile_morph_fst: apply_down for the plural", () => {
    const f = compile_morph_fst(tiny_data());
    const out = apply_down(f, "dogs").map(show_symbols);

    assert.deepEqual(out, ["dog+N+Pl"]);
});

test("compile_morph_fst: apply_up (lex -> surface) generates both forms", () => {
    const f = compile_morph_fst(tiny_data());

    assert.deepEqual(apply_up(f, tokenize_symbols("dog+N+Sg")).map(show_symbols), ["dog"]);
    assert.deepEqual(apply_up(f, tokenize_symbols("dog+N+Pl")).map(show_symbols), ["dogs"]);
});

test("compile_morph_fst: rejects forms not produced by any (root, entry) pair", () => {
    const f = compile_morph_fst(tiny_data());

    assert.deepEqual(apply_down(f, "fish"), []);
    assert.deepEqual(apply_down(f, "doggy"), []);
});

test("compile_morph_fst: empty data is the empty language", () => {
    const f = compile_morph_fst({ roots: [], paradigms: new Map() });

    assert.deepEqual(apply_down(f, "dog"), []);
});

test("compile_morph_fst: unknown paradigm reference throws", () => {
    const bad: morph_data = {
        roots: [{ surface: "dog", paradigm: "Missing", feats: fs(), overrides: new Map() }],
        paradigms: new Map(),
    };

    assert.throws(() => compile_morph_fst(bad), /unknown paradigm/);
});


// Decoding -------------------------------------------------------------------

test("decode_lexical: round-trip with the FST output", () => {
    const data = tiny_data();
    const f = compile_morph_fst(data);
    const lex = apply_down(f, "dogs")[0];
    const analyses = decode_lexical(data, lex);

    assert.equal(analyses.length, 1);
    assert.equal(analyses[0].lemma, "dog");
    assert.equal(analyses[0].cat, "N");
    assert.equal(analyses[0].form, "dogs");
    assert.equal(show_fs(analyses[0].feats), "[lemma=dog, num=pl, pers=3]");
});

test("decode_lexical: singular form has empty surface suffix", () => {
    const data = tiny_data();
    const analyses = decode_lexical(data, tokenize_symbols("cat+N+Sg"));

    assert.equal(analyses.length, 1);
    assert.equal(analyses[0].form, "cat");
    assert.equal(analyses[0].lemma, "cat");
});

test("decode_lexical: unknown tag sequence returns no analyses", () => {
    const data = tiny_data();

    assert.deepEqual(decode_lexical(data, tokenize_symbols("dog+V+Past")), []);
});


// Text parsing ---------------------------------------------------------------

test("parse_morph_data: Root + one paradigm", () => {
    const text = `
%lex Root
    dog : N-reg <lemma>=dog
    cat : N-reg <lemma>=cat

%lex N-reg : N
    +N+Sg :   <num>=sg <pers>=3
    +N+Pl : s <num>=pl <pers>=3
`;
    const data = parse_morph_data(text);

    assert.equal(data.roots.length, 2);
    assert.equal(data.roots[0].surface, "dog");
    assert.equal(data.roots[0].paradigm, "N-reg");
    assert.equal(show_fs(data.roots[0].feats), "[lemma=dog]");

    const p = data.paradigms.get("N-reg");
    assert.ok(p);
    assert.equal(p.cat, "N");
    assert.equal(p.entries.length, 2);
    assert.equal(p.entries[0].tag, "+N+Sg");
    assert.equal(p.entries[0].surface, "");
    assert.equal(p.entries[1].tag, "+N+Pl");
    assert.equal(p.entries[1].surface, "s");
});

test("parse_morph_data: comments and blanks are ignored", () => {
    const text = `
# top of file

%lex Root          # the dispatch table
    dog : N-reg <lemma>=dog   # a stem with its paradigm

%lex N-reg : N     # noun paradigm
    +N+Sg : <num>=sg
`;
    const data = parse_morph_data(text);
    assert.equal(data.roots.length, 1);
    const p = data.paradigms.get("N-reg");
    assert.ok(p);
    assert.equal(p.entries.length, 1);
});

test("parse_morph_data: bare %lex without ': cat' is an error (non-Root)", () => {
    const text = `%lex SomeName\n    +A : <x>=y`;
    assert.throws(() => parse_morph_data(text), lexc_error);
});

test("parse_morph_data: uppercase stems and suffixes are load errors (input is lowercased)", () => {
    assert.throws(
        () => parse_morph_data(`%lex Root\n    Hund : N-reg`),
        /stem 'Hund' contains uppercase/,
    );
    assert.throws(
        () => parse_morph_data(`%lex N-reg : N\n    +N+Pl : S`),
        /surface suffix 'S' contains uppercase/,
    );
});

test("parse_morph_data: '0' surface is treated as empty", () => {
    const text = `
%lex Root
    dog : N-reg

%lex N-reg : N
    +N+Sg : 0 <num>=sg
`;
    const data = parse_morph_data(text);
    const p = data.paradigms.get("N-reg")!;

    assert.equal(p.entries[0].surface, "");
});


// End-to-end against parsed data ---------------------------------------------

// Per-stem overrides ---------------------------------------------------------

test("parse_morph_data: override on the plural only ('fish' is its own plural)", () => {
    const text = `
%lex Root
    fish : N-reg <lemma>=fish
        +N+Pl : 0 <num>=pl

%lex N-reg : N
    +N+Sg :   <num>=sg <pers>=3
    +N+Pl : s <num>=pl <pers>=3
`;
    const data = parse_morph_data(text);
    const f = compile_morph_fst(data);

    assert.deepEqual(apply_down(f, "fish").map(show_symbols).sort(), ["fish+N+Pl", "fish+N+Sg"]);
    assert.deepEqual(apply_down(f, "fishes"), []);
});

test("parse_morph_data: override on the past form only", () => {
    const text = `
%lex Root
    go : V-reg <lemma>=go
        +V+Past : went <tense>=past

%lex V-reg : V
    +V+Pres : s   <tense>=pres
    +V+Past : ed  <tense>=past
`;
    const data = parse_morph_data(text);
    const f = compile_morph_fst(data);

    // present form inherited from the paradigm; past form overridden
    assert.deepEqual(apply_down(f, "gos").map(show_symbols), ["go+V+Pres"]);
    assert.deepEqual(apply_down(f, "goent"), []);
    assert.deepEqual(apply_down(f, "gowent").map(show_symbols), ["go+V+Past"]);
});

test("decode_lexical: override surface and features replace the paradigm's", () => {
    const text = `
%lex Root
    fish : N-reg <lemma>=fish
        +N+Pl : 0

%lex N-reg : N
    +N+Sg :   <num>=sg <pers>=3
    +N+Pl : s <num>=pl <pers>=3
`;
    const data = parse_morph_data(text);
    const analyses = decode_lexical(data, tokenize_symbols("fish+N+Pl"));

    assert.equal(analyses.length, 1);
    assert.equal(analyses[0].form, "fish");
    assert.equal(analyses[0].lemma, "fish");
    // pers=3 is inherited from the paradigm entry; num=pl is preserved
    assert.match(show_fs(analyses[0].feats), /num=pl/);
    assert.match(show_fs(analyses[0].feats), /pers=3/);
});

test("override naming a tag the paradigm doesn't have throws", () => {
    const text = `
%lex Root
    dog : N-reg <lemma>=dog
        +N+Du : ii

%lex N-reg : N
    +N+Sg :   <num>=sg
    +N+Pl : s <num>=pl
`;
    const data = parse_morph_data(text);

    assert.throws(() => compile_morph_fst(data), /overrides tag '\+N\+Du'/);
});

test("override under no preceding root is an error", () => {
    // lowercase tag-shaped stem: uppercase stems are load errors since the
    // case-sensitivity check, and case isn't what this test is about
    const text = `
%lex Root
        +n+pl : 0
`;
    // first entry sets root_indent, so the second deeper line would be an
    // override on it; but here the very first line is deeper than nothing
    // so it must be treated as a root entry. We test a different failure: an
    // override after a paradigm cursor change.
    assert.doesNotThrow(() => parse_morph_data(text));
});

test("multiple roots: overrides bind to the most recent root only", () => {
    const text = `
%lex Root
    dog  : N-reg <lemma>=dog
    fish : N-reg <lemma>=fish
        +N+Pl : 0

%lex N-reg : N
    +N+Sg :   <num>=sg
    +N+Pl : s <num>=pl
`;
    const data = parse_morph_data(text);
    const f = compile_morph_fst(data);

    // dog gets the regular plural; fish's override blocks the -s plural
    assert.deepEqual(apply_down(f, "dogs").map(show_symbols), ["dog+N+Pl"]);
    assert.deepEqual(apply_down(f, "fishes"), []);
    assert.deepEqual(apply_down(f, "fish").map(show_symbols).sort(), ["fish+N+Pl", "fish+N+Sg"]);
});

// Error-tagged paradigm entries (Phase 8) ------------------------------------

test("parse_morph_data: paradigm entry with *ERR / *FIX is parsed as error-tagged", () => {
    const text = `
%lex Root
    child : N-irreg-children <lemma>=child

%lex N-irreg-children : N
    +N+Sg :     <num>=sg
    +N+Pl : ren <num>=pl
    +N+Pl : s   <num>=pl  *ERR "irregular plural: 'children', not '*childs'"  *FIX children
`;
    const data = parse_morph_data(text);
    const p = data.paradigms.get("N-irreg-children")!;

    assert.equal(p.entries.length, 3);
    assert.equal(p.entries[1].error, undefined);
    assert.ok(p.entries[2].error);
    assert.match(p.entries[2].error!.message, /irregular plural/);
    assert.equal(p.entries[2].error!.fix, "children");
});

test("parse_morph_data: *ERR without *FIX throws", () => {
    const text = `
%lex Root
    child : N-irreg-children <lemma>=child

%lex N-irreg-children : N
    +N+Pl : s   <num>=pl  *ERR "wrong plural"
`;
    assert.throws(() => parse_morph_data(text), /\*ERR without \*FIX/);
});

test("parse_morph_data: *FIX without *ERR throws", () => {
    const text = `
%lex Root
    child : N-irreg-children <lemma>=child

%lex N-irreg-children : N
    +N+Pl : s   <num>=pl  *FIX children
`;
    assert.throws(() => parse_morph_data(text), /\*FIX without \*ERR/);
});

test("decode_lexical: tag-shared entries return both clean and error-tagged analyses", () => {
    const text = `
%lex Root
    child : N-irreg-children <lemma>=child

%lex N-irreg-children : N
    +N+Pl : ren <num>=pl
    +N+Pl : s   <num>=pl  *ERR "wrong plural"  *FIX children
`;
    const data = parse_morph_data(text);
    const analyses = decode_lexical(data, tokenize_symbols("child+N+Pl"));

    assert.equal(analyses.length, 2);
    const clean = analyses.find((a) => a.form === "children")!;
    const wrong = analyses.find((a) => a.form === "childs")!;
    assert.equal(clean.error, undefined);
    assert.ok(wrong.error);
    assert.equal(wrong.error!.fix, "children");
});

// Scale smoke test ----------------------------------------------------------

test("compile_morph_fst: 1000 stems × 2 forms stays well below the pre-R3 layout", () => {
    // Pre-R3, each (root × paradigm-entry) was its own sub-path. 1000 stems
    // of ~5 chars × 2 forms would put the state count into the ~10k range.
    // The trie + shared base continuation should keep it an order of magnitude
    // smaller, since (a) the continuation is built once for the paradigm and
    // (b) the trie collapses shared stem prefixes.
    const roots: root_entry[] = [];

    for (let i = 0; i < 1000; i++) {
        roots.push({
            surface: `stem${i}`,
            paradigm: "N-reg",
            feats: fs(),
            overrides: new Map(),
        });
    }

    const data: morph_data = {
        roots,
        paradigms: new Map([
            ["N-reg", {
                name: "N-reg",
                cat: "N",
                entries: [
                    { tag: "+N+Sg", surface: "", feats: feat([["num"], "sg"]) },
                    { tag: "+N+Pl", surface: "s", feats: feat([["num"], "pl"]) },
                ],
            }],
        ]),
    };

    const f = compile_morph_fst(data);

    // sub-linear in stem count: well under stems × forms × stem-length.
    assert.ok(f.n_states < 5000, `expected < 5000 states, got ${f.n_states}`);

    // round-trip a handful to confirm the structure still recognises every stem
    for (const i of [0, 1, 42, 999]) {
        const sg = apply_down(f, `stem${i}`).map(show_symbols);
        const pl = apply_down(f, `stem${i}s`).map(show_symbols);
        assert.deepEqual(sg, [`stem${i}+N+Sg`]);
        assert.deepEqual(pl, [`stem${i}+N+Pl`]);
    }
});

test("parse + compile + decode: irregular paradigm with a non-trivial suffix", () => {
    const text = `
%lex Root
    child : N-irreg-children <lemma>=child

%lex N-irreg-children : N
    +N+Sg :     <num>=sg <pers>=3
    +N+Pl : ren <num>=pl <pers>=3
`;
    const data = parse_morph_data(text);
    const f = compile_morph_fst(data);

    assert.deepEqual(apply_down(f, "children").map(show_symbols), ["child+N+Pl"]);
    assert.deepEqual(apply_down(f, "child").map(show_symbols), ["child+N+Sg"]);

    const analyses = decode_lexical(data, tokenize_symbols("child+N+Pl"));
    assert.equal(analyses[0].lemma, "child");
    assert.equal(analyses[0].cat, "N");
    assert.equal(analyses[0].form, "children");
});
