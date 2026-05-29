import test from "node:test";
import assert from "node:assert/strict";
import { tokenize, tokenize_spans } from "../src/tokenize.ts";

// Basic tokenisation -----------------------------------------------------------

test("whitespace splits and trailing punctuation is trimmed", () => {
    assert.deepEqual(tokenize("the dog barks."), ["the", "dog", "barks"]);
});

test("character spans match the source offsets", () => {
    const toks = tokenize_spans("the dog");

    assert.deepEqual(toks, [
        { text: "the", start: 0, end: 3 },
        { text: "dog", start: 4, end: 7 },
    ]);
});

// Contraction splitting --------------------------------------------------------

test("don't -> do + n't (split before the 'n')", () => {
    const toks = tokenize_spans("don't");

    assert.deepEqual(toks, [
        { text: "do", start: 0, end: 2 },
        { text: "n't", start: 2, end: 5 },
    ]);
});

test("can't, won't, isn't all split the n't off", () => {
    assert.deepEqual(tokenize("can't"), ["ca", "n't"]);
    assert.deepEqual(tokenize("won't"), ["wo", "n't"]);
    assert.deepEqual(tokenize("isn't"), ["is", "n't"]);
});

test("I'm splits at the apostrophe, second token starts with '", () => {
    const toks = tokenize_spans("I'm");

    assert.deepEqual(toks, [
        { text: "I", start: 0, end: 1 },
        { text: "'m", start: 1, end: 3 },
    ]);
});

test("'ll, 've, 're, 'd, 's all split at the apostrophe", () => {
    assert.deepEqual(tokenize("we'll"), ["we", "'ll"]);
    assert.deepEqual(tokenize("they've"), ["they", "'ve"]);
    assert.deepEqual(tokenize("you're"), ["you", "'re"]);
    assert.deepEqual(tokenize("I'd"), ["I", "'d"]);
    assert.deepEqual(tokenize("she's"), ["she", "'s"]);
});

test("case is preserved in the head, suffix recognition is case-insensitive", () => {
    assert.deepEqual(tokenize("Don't"), ["Do", "n't"]);
    assert.deepEqual(tokenize("I'M"), ["I", "'M"]);
});

test("contractions inside a sentence keep correct spans", () => {
    const toks = tokenize_spans("I don't bark");

    assert.deepEqual(toks, [
        { text: "I", start: 0, end: 1 },
        { text: "do", start: 2, end: 4 },
        { text: "n't", start: 4, end: 7 },
        { text: "bark", start: 8, end: 12 },
    ]);
});

test("a bare possessive like dog's still splits (lexicon decides what 's means)", () => {
    // The tokenizer doesn't try to disambiguate possessive 's from auxiliary 's;
    // it just splits, and downstream lexicon/parser decide.
    assert.deepEqual(tokenize("dog's"), ["dog", "'s"]);
});

test("words ending in -s that aren't contractions are untouched", () => {
    assert.deepEqual(tokenize("dogs"), ["dogs"]);
    assert.deepEqual(tokenize("bark"), ["bark"]);
});
