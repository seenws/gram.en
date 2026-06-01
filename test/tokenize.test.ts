import test from "node:test";
import assert from "node:assert/strict";
import { whitespace_tokenizer } from "../src/tokenize.ts";

// English clitics are now declarative (the grammar supplies them via %clitic); the
// tokenizer itself is language-neutral. These tests build an English-configured
// whitespace tokenizer and exercise the clitic splitting through it.
const EN_CLITICS = ["n't", "'re", "'ve", "'ll", "'m", "'d", "'s"];
const tok = whitespace_tokenizer(EN_CLITICS);
const text = (s: string): string[] => tok(s).map((t) => t.text);

// Basic tokenisation -----------------------------------------------------------

test("whitespace splits and trailing punctuation is trimmed", () => {
    assert.deepEqual(text("the dog barks."), ["the", "dog", "barks"]);
});

test("character spans match the source offsets", () => {
    assert.deepEqual(tok("the dog"), [
        { text: "the", start: 0, end: 3 },
        { text: "dog", start: 4, end: 7 },
    ]);
});

// Contraction splitting --------------------------------------------------------

test("don't -> do + n't (split before the 'n')", () => {
    assert.deepEqual(tok("don't"), [
        { text: "do", start: 0, end: 2 },
        { text: "n't", start: 2, end: 5 },
    ]);
});

test("can't, won't, isn't all split the n't off", () => {
    assert.deepEqual(text("can't"), ["ca", "n't"]);
    assert.deepEqual(text("won't"), ["wo", "n't"]);
    assert.deepEqual(text("isn't"), ["is", "n't"]);
});

test("I'm splits at the apostrophe, second token starts with '", () => {
    assert.deepEqual(tok("I'm"), [
        { text: "I", start: 0, end: 1 },
        { text: "'m", start: 1, end: 3 },
    ]);
});

test("'ll, 've, 're, 'd, 's all split at the apostrophe", () => {
    assert.deepEqual(text("we'll"), ["we", "'ll"]);
    assert.deepEqual(text("they've"), ["they", "'ve"]);
    assert.deepEqual(text("you're"), ["you", "'re"]);
    assert.deepEqual(text("I'd"), ["I", "'d"]);
    assert.deepEqual(text("she's"), ["she", "'s"]);
});

test("case is preserved in the head, suffix recognition is case-insensitive", () => {
    assert.deepEqual(text("Don't"), ["Do", "n't"]);
    assert.deepEqual(text("I'M"), ["I", "'M"]);
});

test("contractions inside a sentence keep correct spans", () => {
    assert.deepEqual(tok("I don't bark"), [
        { text: "I", start: 0, end: 1 },
        { text: "do", start: 2, end: 4 },
        { text: "n't", start: 4, end: 7 },
        { text: "bark", start: 8, end: 12 },
    ]);
});

test("a bare possessive like dog's still splits (lexicon decides what 's means)", () => {
    // The tokenizer doesn't try to disambiguate possessive 's from auxiliary 's;
    // it just splits, and downstream lexicon/parser decide.
    assert.deepEqual(text("dog's"), ["dog", "'s"]);
});

test("words ending in -s that aren't contractions are untouched", () => {
    assert.deepEqual(text("dogs"), ["dogs"]);
    assert.deepEqual(text("bark"), ["bark"]);
});

// Language-neutrality ----------------------------------------------------------

test("with no clitics, nothing is peeled off (Swedish/Russian default)", () => {
    const plain = whitespace_tokenizer();
    assert.deepEqual(plain("don't").map((t) => t.text), ["don't"]);
    assert.deepEqual(plain("huset på ön").map((t) => t.text), ["huset", "på", "ön"]);
});

test("Unicode letters (accented Latin, Cyrillic) are kept as word characters", () => {
    const plain = whitespace_tokenizer();
    assert.deepEqual(plain("собака").map((t) => t.text), ["собака"]);
    assert.deepEqual(plain("förälder").map((t) => t.text), ["förälder"]);
});
