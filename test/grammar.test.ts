import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseGrammar } from "../src/grammar.ts";
import { getPath } from "../src/featstruct.ts";

const here = dirname(fileURLToPath(import.meta.url));
const g = parseGrammar(readFileSync(join(here, "..", "languages", "en.gram"), "utf8"));

test("lexicon loads expected forms", () => {
    for (const w of ["the", "a", "these", "dog", "dogs", "i", "me", "bark", "barks", "chased"]) {
        assert.ok(g.lexicon.has(w), `missing lexicon entry: ${w}`);
    }
});

test("a lexeme carries its features", () => {
    const dog = g.lexicon.get("dog")![0];
    assert.equal(dog.cat, "N");
    assert.deepEqual(getPath(dog.feats, ["num"]), { kind: "atom", val: "sg" });
    assert.deepEqual(getPath(dog.feats, ["lemma"]), { kind: "atom", val: "dog" });
});

test("ambiguous form has multiple entries", () => {
    const cats = g.lexicon.get("bark")!.map((e) => e.cat).sort();
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
