import test from "node:test";
import assert from "node:assert/strict";
import { atom, fs, unify, get_path, set_path, show_fs } from "../src/featstruct.ts";

test("atoms unify when equal, fail when not", () => {
    assert.deepEqual(unify(atom("sg"), atom("sg")), atom("sg"));
    assert.equal(unify(atom("sg"), atom("pl")), null);
});

test("feature maps merge disjoint keys", () => {
    const a = fs([["num", atom("sg")]]);
    const b = fs([["pers", atom("3")]]);
    const u = unify(a, b);
    assert.ok(u);
    assert.equal(show_fs(u), "[num=sg, pers=3]");
});

test("shared keys must unify; conflict fails", () => {
    const a = fs([["num", atom("sg")]]);
    const b = fs([["num", atom("pl")]]);
    assert.equal(unify(a, b), null);
});

test("underspecification: an absent feature unifies with anything", () => {
    const unmarked = fs();
    const marked = fs([["num", atom("pl")]]);
    const u = unify(unmarked, marked);
    assert.ok(u);
    assert.equal(show_fs(u), "[num=pl]");
});

test("get_path / set_path round-trip", () => {
    const x = set_path(fs(), ["agr", "num"], atom("sg"));
    const got = get_path(x, ["agr", "num"]);
    assert.deepEqual(got, atom("sg"));
    assert.equal(get_path(x, ["agr", "pers"]), undefined);
});
