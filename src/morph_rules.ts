// Morphological rewrite-rule compiler.
//
// Compiles rules of the form  A -> B || L _ R  to FSTs that can be composed
// over a continuation lexicon.

import {
    type fst,
    EPS,
    eps,
    symbol,
    pair,
    concat_many,
    union,
    union_many,
    kleene,
    apply_down,
    apply_up,
    tokenize_symbols,
    epsilon_eliminate,
} from "./fst.ts";

export type rule_spec = {
    name?: string;
    in: string[];     // length 0 -> pure insertion
    out: string[];    // length 0 -> pure deletion
    left?: string[];
    right?: string[];
};

// Named character classes (e.g. Vowel -> a | e | i | o | u). A class name that
// appears at a context slot matches any one of its members. Declared in the
// grammar with %class and threaded into parse_rule/compile_rule.
export type char_classes = ReadonlyMap<string, readonly string[]>;
const NO_CLASSES: char_classes = new Map();


export function identity_sym(sigma: readonly string[]): fst {
    return union_many(sigma.map(symbol));
}

// Identity over sigma* (any string from sigma).
export function identity_star(sigma: readonly string[]): fst {
    return kleene(identity_sym(sigma));
}

// Identity over a context symbol sequence. A symbol that names a character
// class expands to "any one member" (a union); everything else is itself.
function context(syms: readonly string[], classes: char_classes): fst {
    if (syms.length === 0) return eps();

    return concat_many(syms.map((s) => {
        const members = classes.get(s);

        return members ? union_many(members.map(symbol)) : symbol(s);
    }));
}

// The rewrite kernel: emit `out` for `inp`. The shorter side is EPS-padded
// so the resulting FST has length max(|inp|, |out|) and stays linear --
// good enough for the substitution-style rules English needs (e.g.
// `e:0`, `y:i`, `+s:es`, `+ing:ing`).
function rewrite(inp: readonly string[], out: readonly string[]): fst {
    const len = Math.max(inp.length, out.length);

    if (len === 0) return eps();

    const pairs: fst[] = [];

    for (let i = 0; i < len; i++) {
        const ai = i < inp.length ? inp[i] : EPS;
        const bi = i < out.length ? out[i] : EPS;

        pairs.push(pair(ai, bi));
    }

    return concat_many(pairs);
}


export function compile_rule(sigma: readonly string[], spec: rule_spec, classes: char_classes = NO_CLASSES): fst {
    const left = spec.left ?? [];
    const right = spec.right ?? [];
    const match = concat_many([context(left, classes), rewrite(spec.in, spec.out), context(right, classes)]);

    return epsilon_eliminate(kleene(union(identity_sym(sigma), match)));
}

// Cascade of compiled rules. We keep them as a list rather than collapsing
// to a single composed FST: optional-replace rules each contribute a fan-out
// of paths, and pre-composing them produces an FST whose apply_* runs in
// exponential time. Sequential application caps the fan-out at each layer
// (and the lexicon, applied last, filters out the overgenerated candidates).
export type cascade = fst[];

export function compile_cascade(sigma: readonly string[], specs: readonly rule_spec[], classes: char_classes = NO_CLASSES): cascade {
    return specs.map((s) => compile_rule(sigma, s, classes));
}

function dedupe_seqs(rs: string[][]): string[][] {
    const seen = new Set<string>();
    const out: string[][] = [];

    for (const r of rs) {
        const k = JSON.stringify(r);

        if (!seen.has(k)) {
            seen.add(k);
            out.push(r);
        }
    }

    return out;
}

export function apply_cascade_down(cs: cascade, input: string|string[]): string[][] {
    let layer: string[][] = [typeof input === "string" ? tokenize_symbols(input) : [...input]];

    for (const rule of cs) {
        const next: string[][] = [];

        for (const inp of layer) {
            for (const out of apply_down(rule, inp)) next.push(out);
        }

        if (next.length === 0) return [];

        layer = dedupe_seqs(next);
    }

    return layer;
}

export function apply_cascade_up(cs: cascade, input: string | string[]): string[][] {
    let layer: string[][] = [typeof input === "string" ? tokenize_symbols(input) : [...input]];

    for (let i = cs.length - 1; i >= 0; i--) {
        const next: string[][] = [];

        for (const inp of layer) {
            for (const out of apply_up(cs[i], inp)) next.push(out);
        }

        if (next.length === 0) return [];

        layer = dedupe_seqs(next);
    }

    return layer;
}


// Grammar of a rule body:
//
//     body    ::= rewrite [ "=>" context ]
//     rewrite ::= pattern ":" pattern
//     context ::= [ pattern { pattern } ] "_" [ pattern { pattern } ]
//
// Each pattern is tokenised with tokenize_symbols, so `+s` is one symbol
// and `es` is two. The literal "0" (zero) is a conventional name for EPS
// on either side of the rewrite, so `e:0` reads as "delete e".
function parse_pattern(s: string, classes: char_classes): string[] {
    if (s === "0" || s === "") return [];
    // A class name is a single opaque symbol; don't split it into characters.
    if (classes.has(s)) return [s];

    return tokenize_symbols(s);
}

function parse_context(s: string, classes: char_classes): string[] {
    if (!s) return [];

    return s.split(/\s+/).flatMap((t) => parse_pattern(t, classes));
}

export function parse_rule(text: string, classes: char_classes = NO_CLASSES): rule_spec {
    const body = text.trim();
    const ci = body.indexOf("=>");
    const rewrite_str = (ci >= 0 ? body.slice(0, ci) : body).trim();
    const context_str = ci >= 0 ? body.slice(ci + 2).trim() : "";
    const ri = rewrite_str.indexOf(":");

    if (ri < 0) throw new Error(`rule: missing ":" in rewrite: ${rewrite_str}`);

    const inp = parse_pattern(rewrite_str.slice(0, ri).trim(), classes);
    const out = parse_pattern(rewrite_str.slice(ri + 1).trim(), classes);

    // Pure insertion (0:x) compiles to an ε-input arc inside the optional-replace
    // Kleene loop, an ε-cycle that emits output. epsilon_eliminate keeps only the
    // first-found ε-path per state pair, so those insertion paths are silently
    // dropped (and apply_down's cycle guard would truncate them anyway). Reject
    // the rule here, where the author can see it, instead of mis-analysing later.
    if (inp.length === 0) {
        throw new Error(`rule: pure-insertion rewrites (0:x) are not supported: ${rewrite_str}`);
    }

    let left: string[] = [];
    let right: string[] = [];

    if (context_str) {
        const ui = context_str.indexOf("_");

        if (ui < 0) throw new Error(`rule: context missing "_": ${context_str}`);

        left = parse_context(context_str.slice(0, ui).trim(), classes);
        right = parse_context(context_str.slice(ui + 1).trim(), classes);
    }

    return { in: inp, out, left, right };
}
