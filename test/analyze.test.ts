import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseGrammar } from "../src/grammar.ts";
import { analyze } from "../src/analyze.ts";

const here = dirname(fileURLToPath(import.meta.url));
const g = parseGrammar(readFileSync(join(here, "..", "languages", "en.gram"), "utf8"));

test("grammatical controls parse cleanly", () => {
    assert.equal(analyze(g, "the dog barks").verdict, "grammatical");
    assert.equal(analyze(g, "dogs bark").verdict, "grammatical");
    assert.equal(analyze(g, "the cat chased the dog").verdict, "grammatical");
});

test("unknown word is reported, not called ungrammatical", () => {
    const a = analyze(g, "glorp barks");
    assert.equal(a.verdict, "unknown-word");
    assert.deepEqual(a.unknownWords, ["glorp"]);
});

// Each row: sentence -> expected rule, a substring of the message, and one fix
// that must appear among the offered repairs.
const cases: [string, string, RegExp, string][] = [
    ["the dog bark", "S -> NP VP", /subject-verb agreement/i, "the dog barks"],
    ["the dog bark", "S -> NP VP", /subject-verb agreement/i, "the dogs bark"],
    ["the dogs barks", "S -> NP VP", /subject-verb agreement/i, "the dogs bark"],
    ["these dog barks", "NP -> Det N", /determiner-noun/i, "this dog barks"],
    ["an dog barks", "NP -> Det N", /article form/i, "a dog barks"],
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
    assert.deepEqual(a.violations[0].span, [2, 3]); // "bark"
});
