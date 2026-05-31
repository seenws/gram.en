import test from "node:test";
import assert from "node:assert/strict";
import { parse_grammar } from "../src/grammar.ts";
import { expand_grammar, flatten_grammar } from "../src/loader.ts";

// In-memory resolver so these tests don't touch the filesystem.
function mk(files: Record<string, string>): (rel: string) => string {
    return (rel) => {
        if (!(rel in files)) throw new Error(`no such file: ${rel}`);
        return files[rel];
    };
}

test("%include splices another grammar file's content", () => {
    const resolve = mk({ "sub.gram": "NP -> Det N" });
    const g = parse_grammar("S -> NP VP\n%include sub.gram", { resolve });

    assert.ok(g.rules.some((r) => r.name === "S -> NP VP"));
    assert.ok(g.rules.some((r) => r.name === "NP -> Det N"));
});

test("%include is recursive", () => {
    const resolve = mk({ "a.gram": "%include b.gram", "b.gram": "S -> NP" });
    const g = parse_grammar("%include a.gram", { resolve });

    assert.ok(g.rules.some((r) => r.name === "S -> NP"));
});

test("%import loads a TSV stem lexicon as a %lex Root block", () => {
    const resolve = mk({
        "lex.tsv": "dog\tN-reg\t<lemma>=dog\ncat\tN-reg\t<lemma>=cat",
    });
    const text = `%import lex.tsv
%lex N-reg : N
    +N+Sg :   <num>=sg
    +N+Pl : s <num>=pl`;
    const g = parse_grammar(text, { resolve });

    assert.equal(g.morph.roots.length, 2);
    assert.deepEqual(g.morph.roots.map((r) => r.surface).sort(), ["cat", "dog"]);
});

test("%import skips comment and blank rows", () => {
    const resolve = mk({ "lex.tsv": "# header\n\ndog\tN-reg\t<lemma>=dog\n" });
    const text = `%import lex.tsv
%lex N-reg : N
    +N+Sg : <num>=sg`;
    const g = parse_grammar(text, { resolve });

    assert.equal(g.morph.roots.length, 1);
    assert.equal(g.morph.roots[0].surface, "dog");
});

test("a malformed TSV row errors with file:line", () => {
    const resolve = mk({ "lex.tsv": "dog\tN-reg\nbroken_row_no_tab" });
    assert.throws(
        () => parse_grammar("%import lex.tsv", { resolve }),
        /lex\.tsv:2:.*needs at least/,
    );
});

test("circular %include is detected", () => {
    const resolve = mk({ "a.gram": "%include b.gram", "b.gram": "%include a.gram" });
    assert.throws(() => parse_grammar("%include a.gram", { resolve }), /circular %include: a\.gram/);
});

test("file directives without a resolver error clearly", () => {
    assert.throws(() => parse_grammar("%include sub.gram"), /requires a file resolver/);
});

test("a parse error in an included file points at that file", () => {
    const resolve = mk({ "sub.gram": "this line is nonsense" });
    assert.throws(() => parse_grammar("%include sub.gram", { resolve }), /sub\.gram:1:/);
});

test("flatten_grammar resolves everything into one directive-free string", () => {
    const resolve = mk({
        "sub.gram": "S -> NP",
        "lex.tsv": "dog\tN-reg\t<lemma>=dog",
    });
    const flat = flatten_grammar("%include sub.gram\n%import lex.tsv", resolve);

    assert.match(flat, /S -> NP/);
    assert.match(flat, /%lex Root/);
    assert.match(flat, /dog : N-reg/);
    assert.doesNotMatch(flat, /%include/);
    assert.doesNotMatch(flat, /%import/);
});

test("origins label the root file by its given filename", () => {
    const { origins } = expand_grammar("S -> NP", undefined, "root.gram");
    assert.equal(origins[0], "root.gram:1");
});
