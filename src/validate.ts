// Load-time feature validation.
//
// When a grammar declares its features with %feature, every atomic feature
// value that appears anywhere -- lexicon entries, rule equations, and
// morphological paradigms -- is checked against the declaration. A value the
// declaration doesn't allow (a typo like <num>=sgular) or an entirely
// undeclared feature name becomes a load error instead of a silently
// never-unifying entry. A grammar that declares no features opts out.

import { type feature_struct } from "./featstruct.ts";
import { type lex_entry, type rule } from "./grammar.ts";
import { type morph_data } from "./morph_lexc.ts";

// A declared feature maps to its set of allowed atomic values, or null for an
// open feature (e.g. lemma) declared with `*`, whose values aren't enumerable.
export type feature_decls = Map<string, Set<string> | null>;

export class feature_error extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "feature_error";
    }
}

// Check one (feature, value) pair against the declarations, appending a
// human-readable problem to `out` if it's unknown or out of range.
function check_pair(name: string, val: string, decls: feature_decls, where: string, out: string[]): void {
    const allowed = decls.get(name);

    if (allowed === undefined) {
        out.push(`unknown feature '${name}' (not declared with %feature) in ${where}`);
    } else if (allowed !== null && !allowed.has(val)) {
        out.push(`feature '${name}' has undeclared value '${val}' (allowed: ${[...allowed].join(" | ")}) in ${where}`);
    }
}

// Walk a feature struct; every atomic leaf is checked under the immediate
// feature name that holds it (structural intermediate nodes aren't declared).
function check_fs(f: feature_struct, decls: feature_decls, where: string, out: string[]): void {
    if (f.kind === "atom") return;

    for (const [name, v] of f.feats) {
        if (v.kind === "atom") {
            check_pair(name, v.val, decls, where, out);
        } else {
            check_fs(v, decls, where, out);
        }
    }
}

export function validate_features(
    decls: feature_decls,
    lexicon: Map<string, lex_entry[]>,
    rules: rule[],
    morph: morph_data,
): void {
    if (decls.size === 0) return;

    const out: string[] = [];

    for (const [form, entries] of lexicon) {
        for (const e of entries) check_fs(e.feats, decls, `lexicon entry '${form}'`, out);
    }

    // Rule equations constrain a feature to an atomic value only when the
    // right-hand side is a literal value; path = path equations carry no atom.
    for (const r of rules) {
        for (const eq of r.eqs) {
            if (eq.right.kind !== "value") continue;

            const name = eq.left.feats[eq.left.feats.length - 1];

            if (name !== undefined) check_pair(name, eq.right.value, decls, `rule '${r.name}'`, out);
        }
    }

    for (const r of morph.roots) {
        check_fs(r.feats, decls, `morph root '${r.surface}'`, out);

        for (const [, ov] of r.overrides) check_fs(ov.feats, decls, `override on root '${r.surface}'`, out);
    }

    for (const [, p] of morph.paradigms) {
        for (const e of p.entries) check_fs(e.feats, decls, `paradigm '${p.name}' entry '${e.tag}'`, out);
    }

    if (out.length > 0) {
        throw new feature_error(`feature validation failed:\n  ${out.join("\n  ")}`);
    }
}
