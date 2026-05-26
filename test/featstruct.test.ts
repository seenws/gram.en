import test from "node:test";
import assert from "node:assert/strict";
import { atom, fs, unify, getPath, setPath, showFS } from "../src/featstruct.ts";

test("atoms unify when equal, fail when not", () => {
    assert.deepEqual(unify(atom("sg"), atom("sg")), atom("sg"));
    assert.equal(unify(atom("sg"), atom("pl")), null);
});

test("feature maps merge disjoint keys", () => {
    const a = fs([["num", atom("sg")]]);
    const b = fs([["pers", atom("3")]]);
    const u = unify(a, b);
    assert.ok(u);
    assert.equal(showFS(u), "[num=sg, pers=3]");
});

test("shared keys must unify; conflict fails", () => {
    const a = fs([["num", atom("sg")]]);
    const b = fs([["num", atom("pl")]]);
    assert.equal(unify(a, b), null);
});

test("underspecification: an absent feature unifies with anything", () => {
    const unmarked = fs(); // e.g. "the" with no num
    const marked = fs([["num", atom("pl")]]);
    const u = unify(unmarked, marked);
    assert.ok(u);
    assert.equal(showFS(u), "[num=pl]");
});

test("getPath / setPath round-trip", () => {
    const x = setPath(fs(), ["agr", "num"], atom("sg"));
    const got = getPath(x, ["agr", "num"]);
    assert.deepEqual(got, atom("sg"));
    assert.equal(getPath(x, ["agr", "pers"]), undefined);
});
