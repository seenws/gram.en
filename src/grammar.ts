import { type feature_struct, fs, atom, set_path } from "./featstruct.ts";
import { type fst } from "./fst.ts";
import { type morph_data, type morph_diag, compile_morph_fst, parse_morph_data } from "./morph_lexc.ts";
import { type feature_decls, validate_features } from "./validate.ts";
import { type resolver, expand_grammar } from "./loader.ts";
import { type char_classes, type cascade, type rule_spec, parse_rule, compile_cascade } from "./morph_rules.ts";
import { tokenize_symbols } from "./fst.ts";

export type path = { constituent: string; feats: string[] };
export type term = { kind: "path"; path: path } | { kind: "value"; value: string };
export type diag = { message: string; fixes: string[] };
export type equation = { left: path; right: term; diag: diag | null };
export type rule = { lhs: string; rhs: string[]; eqs: equation[]; name: string };
export type mal_rule = { lhs: string; rhs: string[]; err: string; fix: string | null; name: string };
export type lex_entry = { form: string; cat: string; feats: feature_struct; morph_err?: morph_diag };

export type grammar = {
    lexicon: Map<string, lex_entry[]>;
    rules: rule[];
    malrules: mal_rule[];
    nonterminals: Set<string>;
    features: feature_decls;
    classes: char_classes;
    morph: morph_data;
    morph_fst: fst | null;
    // Morphophonemic rewrite rules (from %rule), in generation order. Applied
    // upward (apply_cascade_up) to a surface to recover the underlying strings
    // the lexicon FST recognises. Empty when the grammar declares no %rule.
    morph_cascade: cascade;
};

export class grammar_error extends Error {
    constructor(loc: string, msg: string) {
        super(`${loc}: ${msg}`);
        this.name = "grammar_error";
    }
}

function strip_comment(line: string): string {
    let in_quote = false;

    for (let i = 0; i < line.length; i++) {
        const c = line[i];

        if (c === '"') {
            in_quote = !in_quote;
        } else if (c === "#" && !in_quote) {
            return line.slice(0, i);
        }
    }

    return line;
}

function prod_name(lhs: string, rhs: string[]): string {
    return `${lhs} -> ${rhs.join(" ")}`;
}

function parse_production(s: string, loc: string): { lhs: string; rhs: string[] } {
    const i = s.indexOf("->");

    if (i < 0) throw new grammar_error(loc, `production missing "->": ${s}`);

    const lhs = s.slice(0, i).trim();
    const rhs = s.slice(i + 2).trim().split(/\s+/).filter(Boolean);

    if (lhs.length === 0 || rhs.length === 0) throw new grammar_error(loc, `malformed production: ${s}`);

    return { lhs, rhs };
}

function parse_path(s: string, loc: string): path {
    const m = s.match(/^<([^>]*)>$/);

    if (!m) throw new grammar_error(loc, `malformed path: ${s}`);

    const toks = m[1].trim().split(/\s+/).filter(Boolean);

    if (toks.length === 0) throw new grammar_error(loc, `empty path: ${s}`);

    return { constituent: toks[0], feats: toks.slice(1) };
}

function parse_quoted(s: string, loc: string): string {
    const m = s.match(/"([^"]*)"/);

    if (!m) throw new grammar_error(loc, `expected a quoted string: ${s}`);

    return m[1];
}

function parse_lex_entry(line: string, loc: string): lex_entry {
    const ci = line.indexOf(":");
    const form = line.slice(0, ci).trim();
    const rest = line.slice(ci + 1).trim();
    const cm = rest.match(/^(\S+)/);

    if (!cm) throw new grammar_error(loc, `lexicon entry missing category: ${line}`);

    const cat = cm[1];
    let feats = fs();
    const re = /<([^>]*)>\s*=\s*(\S+)/g;
    let m: RegExpExecArray | null;

    while ((m = re.exec(rest)) !== null) {
        const segments = m[1].trim().split(/\s+/).filter(Boolean);
        feats = set_path(feats, segments, atom(m[2]));
    }

    return { form, cat, feats };
}

// `%feature num : sg | pl` declares a feature and its closed set of atomic
// values; `%feature lemma : *` declares an open feature whose values aren't
// enumerable. Declaring any feature turns on load-time validation (validate.ts).
function parse_feature_decl(s: string, loc: string, into: feature_decls): void {
    const ci = s.indexOf(":");

    if (ci < 0) throw new grammar_error(loc, `%feature needs '<name> : v1 | v2 | ...': ${s}`);

    const name = s.slice(0, ci).trim();
    const vals = s.slice(ci + 1).split("|").map((x) => x.trim()).filter(Boolean);

    if (!name || vals.length === 0) throw new grammar_error(loc, `malformed %feature declaration: ${s}`);

    into.set(name, vals.length === 1 && vals[0] === "*" ? null : new Set(vals));
}

// `%class Vowel : a | e | i | o | u` names a set of symbols that rewrite-rule
// contexts can reference (e.g. delete e after a Cons). Members are literal
// symbols; the class name is a single opaque symbol to the rule compiler.
function parse_class_decl(s: string, loc: string, into: Map<string, string[]>): void {
    const ci = s.indexOf(":");

    if (ci < 0) throw new grammar_error(loc, `%class needs '<Name> : m1 | m2 | ...': ${s}`);

    const name = s.slice(0, ci).trim();
    const members = s.slice(ci + 1).split("|").map((x) => x.trim()).filter(Boolean);

    if (!name || members.length === 0) throw new grammar_error(loc, `malformed %class declaration: ${s}`);

    into.set(name, members);
}

// The alphabet the rewrite cascade must pass through unchanged: every symbol
// that can appear in an underlying string (stem chars + paradigm suffix chars)
// plus every literal symbol a rule names. Class members are included so the
// cascade's identity covers the whole declared alphabet (a-z via Vowel/Cons),
// which lets unknown words flow through to the lexicon's reject.
function compute_sigma(morph: morph_data, classes: char_classes, specs: readonly rule_spec[]): string[] {
    const sigma = new Set<string>();
    const add_chars = (s: string): void => { for (const c of tokenize_symbols(s)) sigma.add(c); };

    for (const r of morph.roots) add_chars(r.surface);
    for (const [, p] of morph.paradigms) {
        for (const e of p.entries) add_chars(e.surface);
    }
    for (const members of classes.values()) {
        for (const m of members) sigma.add(m);
    }
    for (const spec of specs) {
        for (const sym of [...spec.in, ...spec.out, ...(spec.left ?? []), ...(spec.right ?? [])]) {
            const members = classes.get(sym);

            if (members) for (const m of members) sigma.add(m);
            else sigma.add(sym);
        }
    }

    return [...sigma];
}

function parse_equation(line: string, loc: string): equation {
    const bang = line.indexOf("!");
    const core = (bang >= 0 ? line.slice(0, bang) : line).trim();
    const diag_str = bang >= 0 ? line.slice(bang + 1).trim() : null;
    const eq = core.indexOf("=");

    if (eq < 0) throw new grammar_error(loc, `equation missing "=": ${line}`);

    const left = parse_path(core.slice(0, eq).trim(), loc);
    const right_str = core.slice(eq + 1).trim();
    const right: term = right_str.startsWith("<")
        ? { kind: "path", path: parse_path(right_str, loc) }
        : { kind: "value", value: right_str };

    let d: diag | null = null;

    if (diag_str) {
        const message = parse_quoted(diag_str, loc);
        const fi = diag_str.indexOf("fix:");
        const fixes = fi >= 0 ? diag_str.slice(fi + 4).split("|").map((x) => x.trim()).filter(Boolean) : [];
        d = { message, fixes };
    }

    return { left, right, diag: d };
}

export type parse_options = {
    // Reads a file referenced by %include / %import, relative to the grammar.
    // Omit it to forbid file directives (e.g. an already-flattened browser bundle).
    resolve?: resolver;
    // Source label for the root text's origins (shown in error messages).
    filename?: string;
};

export function parse_grammar(text: string, opts: parse_options = {}): grammar {
    const lexicon = new Map<string, lex_entry[]>();
    const rules: rule[] = [];
    const malrules: mal_rule[] = [];
    const nonterminals = new Set<string>();
    const features: feature_decls = new Map();
    const classes = new Map<string, string[]>();
    // %rule bodies are collected raw and parsed after the loop, so they can
    // reference any %class regardless of declaration order.
    const rule_texts: { text: string; loc: string }[] = [];
    const morph_lines: string[] = [];

    type cursor =
        | { kind: "rule"; rule: rule }
        | { kind: "mal"; mal: mal_rule }
        | { kind: "lex" }
        | null;
    let cur: cursor = null;

    const { lines, origins } = expand_grammar(text, opts.resolve, opts.filename ?? "en.gram");

    for (let ln = 0; ln < lines.length; ln++) {
        const raw = lines[ln];
        const loc = origins[ln];
        const body = strip_comment(raw);
        const trimmed = body.trim();

        if (trimmed.length === 0) {
            // blank lines are inert; they don't close the lex cursor because
            // a %lex block is allowed to have blanks between entries
            continue;
        }

        const indented = /^\s/.test(body);

        if (!indented) {
            if (trimmed.startsWith("%feature")) {
                parse_feature_decl(trimmed.slice("%feature".length).trim(), loc, features);
                cur = null;
            } else if (trimmed.startsWith("%class")) {
                parse_class_decl(trimmed.slice("%class".length).trim(), loc, classes);
                cur = null;
            } else if (trimmed.startsWith("%rule")) {
                rule_texts.push({ text: trimmed.slice("%rule".length).trim(), loc });
                cur = null;
            } else if (trimmed.startsWith("%lex")) {
                morph_lines.push(raw);
                cur = { kind: "lex" };
            } else if (trimmed.startsWith("%mal")) {
                const { lhs, rhs } = parse_production(trimmed.slice(4).trim(), loc);
                const mal: mal_rule = { lhs, rhs, err: "", fix: null, name: prod_name(lhs, rhs) };
                malrules.push(mal);
                nonterminals.add(lhs);
                cur = { kind: "mal", mal };
            } else if (trimmed.includes("->")) {
                const { lhs, rhs } = parse_production(trimmed, loc);
                const r: rule = { lhs, rhs, eqs: [], name: prod_name(lhs, rhs) };
                rules.push(r);
                nonterminals.add(lhs);
                cur = { kind: "rule", rule: r };
            } else if (trimmed.includes(":")) {
                const entry = parse_lex_entry(trimmed, loc);
                const key = entry.form.toLowerCase();
                const bucket = lexicon.get(key);

                if (bucket) {
                    bucket.push(entry);
                } else {
                    lexicon.set(key, [entry]);
                }

                cur = null;
            } else {
                throw new grammar_error(loc, `unrecognized line: ${trimmed}`);
            }
        } else {
            if (cur === null) throw new grammar_error(loc, `indented line without a preceding rule: ${trimmed}`);

            if (cur.kind === "rule") {
                cur.rule.eqs.push(parse_equation(trimmed, loc));
            } else if (cur.kind === "lex") {
                morph_lines.push(raw);
            } else if (trimmed.startsWith("*ERR")) {
                cur.mal.err = parse_quoted(trimmed.slice(4).trim(), loc);
            } else if (trimmed.startsWith("*FIX")) {
                cur.mal.fix = trimmed.slice(4).trim();
            } else {
                throw new grammar_error(loc, `unrecognized mal-rule line: ${trimmed}`);
            }
        }
    }

    const morph = morph_lines.length > 0
        ? parse_morph_data(morph_lines.join("\n"))
        : { roots: [], paradigms: new Map() };
    const morph_fst = morph.roots.length > 0 ? compile_morph_fst(morph) : null;

    const specs = rule_texts.map(({ text, loc }) => {
        try {
            return parse_rule(text, classes);
        } catch (e) {
            throw new grammar_error(loc, (e as Error).message);
        }
    });
    const morph_cascade = compile_cascade(compute_sigma(morph, classes, specs), specs, classes);

    validate_features(features, lexicon, rules, morph);

    return { lexicon, rules, malrules, nonterminals, features, classes, morph, morph_fst, morph_cascade };
}
