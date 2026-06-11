import { type feature_struct, fs, atom, set_path } from "./featstruct.ts";
import { type fst } from "./fst.ts";
import { type morph_data, type morph_diag, compile_morph_fst, parse_morph_data } from "./morph_lexc.ts";
import { type feature_decls, validate_features } from "./validate.ts";
import { type resolver, expand_grammar } from "./loader.ts";
import { type char_classes, type cascade, type rule_spec, parse_rule, compile_cascade } from "./morph_rules.ts";
import { tokenize_symbols } from "./fst.ts";
import { type tokenizer, build_tokenizer } from "./tokenize.ts";

// A constraint path names a constituent of a production -- the mother (LHS) or a
// daughter by its RHS position -- then a feature path into its structure. The
// surface name written in the .gram file (an alias, or a category when unique)
// is resolved to one of these at load time (see make_resolver).
export type const_ref = { kind: "mother" } | { kind: "daughter"; index: number };
export type path = { ref: const_ref; feats: string[] };
export type term = { kind: "path"; path: path } | { kind: "value"; value: string };
export type diag = { message: string; fixes: string[] };
export type equation = { left: path; right: term; diag: diag | null };
// `head` is the daughter index the mother inherits its features from when the LHS
// category occurs exactly once among the daughters (head percolation), else null.
export type rule = { lhs: string; rhs: string[]; eqs: equation[]; name: string; head: number | null };
export type mal_rule = { lhs: string; rhs: string[]; err: string; name: string };
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
    // The start nonterminal (from `%start`, else the first rule's LHS) and the
    // per-language tokenizer (from `%tokenizer`/`%clitic`). Both let a non-English
    // grammar drop in without touching the engine.
    start: string;
    tokenize: tokenizer;
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

// A production constituent: a category symbol with an optional alias written as
// `alias:CAT`. The category drives parsing/scanning; the alias (and, when unique,
// the category itself) is how equations address the constituent.
type constituent = { cat: string; alias?: string };

function split_alias(tok: string, loc: string): constituent {
    const ci = tok.indexOf(":");

    if (ci < 0) return { cat: tok };

    const alias = tok.slice(0, ci).trim();
    const cat = tok.slice(ci + 1).trim();

    if (!alias || !cat) throw new grammar_error(loc, `malformed alias in '${tok}' (expected alias:CAT)`);

    return { cat, alias };
}

function parse_production(s: string, loc: string): { lhs: constituent; rhs: constituent[] } {
    const i = s.indexOf("->");

    if (i < 0) throw new grammar_error(loc, `production missing "->": ${s}`);

    const lhs_tok = s.slice(0, i).trim();
    const rhs_toks = s.slice(i + 2).trim().split(/\s+/).filter(Boolean);

    if (lhs_tok.length === 0 || rhs_toks.length === 0) throw new grammar_error(loc, `malformed production: ${s}`);

    return { lhs: split_alias(lhs_tok, loc), rhs: rhs_toks.map((t) => split_alias(t, loc)) };
}

// The daughter index the mother inherits from (LHS category occurs exactly once
// among the daughters), else null -- replicating the symbol-keyed head sharing
// the env used to do implicitly.
function compute_head(lhs_cat: string, rhs_cats: string[]): number | null {
    const idxs = rhs_cats.flatMap((c, i) => (c === lhs_cat ? [i] : []));

    return idxs.length === 1 ? idxs[0] : null;
}

type const_resolver = (name: string, loc: string) => const_ref;

// Resolves an equation's constituent name to a const_ref, in priority order:
// (1) a declared alias; (2) the LHS category, which always denotes the mother
// (what the rule defines); (3) a category borne by exactly one daughter (so
// existing rules keep working). A daughter category that occurs more than once
// must be aliased -- naming it bare is a load error -- as is an unknown name.
function make_resolver(lhs: constituent, rhs: constituent[], loc: string): const_resolver {
    const aliases = new Map<string, const_ref>();
    const add_alias = (a: string | undefined, ref: const_ref): void => {
        if (a === undefined) return;
        if (aliases.has(a)) throw new grammar_error(loc, `duplicate alias '${a}' in production`);
        aliases.set(a, ref);
    };
    const daughters_by_cat = new Map<string, number[]>();

    add_alias(lhs.alias, { kind: "mother" });
    rhs.forEach((c, i) => {
        add_alias(c.alias, { kind: "daughter", index: i });
        const bucket = daughters_by_cat.get(c.cat);
        if (bucket) bucket.push(i);
        else daughters_by_cat.set(c.cat, [i]);
    });

    return (name, eqloc) => {
        const a = aliases.get(name);

        if (a) return a;
        if (name === lhs.cat) return { kind: "mother" };

        const idxs = daughters_by_cat.get(name);

        if (idxs && idxs.length === 1) return { kind: "daughter", index: idxs[0] };
        if (idxs && idxs.length > 1) {
            throw new grammar_error(eqloc, `ambiguous constituent '${name}' (matches ${idxs.length} daughters); give it an alias`);
        }

        throw new grammar_error(eqloc, `unknown constituent '${name}'`);
    };
}

function parse_path(s: string, loc: string, resolve: const_resolver): path {
    const m = s.match(/^<([^>]*)>$/);

    if (!m) throw new grammar_error(loc, `malformed path: ${s}`);

    const toks = m[1].trim().split(/\s+/).filter(Boolean);

    if (toks.length === 0) throw new grammar_error(loc, `empty path: ${s}`);

    return { ref: resolve(toks[0], loc), feats: toks.slice(1) };
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

function parse_equation(line: string, loc: string, resolve: const_resolver): equation {
    const bang = line.indexOf("!");
    const core = (bang >= 0 ? line.slice(0, bang) : line).trim();
    const diag_str = bang >= 0 ? line.slice(bang + 1).trim() : null;
    const eq = core.indexOf("=");

    if (eq < 0) throw new grammar_error(loc, `equation missing "=": ${line}`);

    const left = parse_path(core.slice(0, eq).trim(), loc, resolve);
    const right_str = core.slice(eq + 1).trim();
    const right: term = right_str.startsWith("<")
        ? { kind: "path", path: parse_path(right_str, loc, resolve) }
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
    // Per-language engine settings, collected from directives and resolved after
    // the loop: `%start <Sym>`, `%tokenizer <name>`, `%clitic <suffix>...`.
    let start_sym: string | null = null;
    let tokenizer_name = "whitespace";
    const clitics: string[] = [];

    type cursor =
        | { kind: "rule"; rule: rule; resolve: const_resolver }
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
            } else if (trimmed.startsWith("%start")) {
                start_sym = trimmed.slice("%start".length).trim();
                if (!start_sym) throw new grammar_error(loc, "%start needs a nonterminal");
                cur = null;
            } else if (trimmed.startsWith("%tokenizer")) {
                tokenizer_name = trimmed.slice("%tokenizer".length).trim();
                if (!tokenizer_name) throw new grammar_error(loc, "%tokenizer needs a name");
                cur = null;
            } else if (trimmed.startsWith("%clitic")) {
                clitics.push(...trimmed.slice("%clitic".length).trim().split(/\s+/).filter(Boolean));
                cur = null;
            } else if (trimmed.startsWith("%lex")) {
                morph_lines.push(raw);
                cur = { kind: "lex" };
            } else if (trimmed.startsWith("%mal")) {
                // mal-rules carry no equations, so aliases are irrelevant here
                const { lhs, rhs } = parse_production(trimmed.slice(4).trim(), loc);
                const cats = rhs.map((c) => c.cat);
                const mal: mal_rule = { lhs: lhs.cat, rhs: cats, err: "", name: prod_name(lhs.cat, cats) };
                malrules.push(mal);
                nonterminals.add(lhs.cat);
                cur = { kind: "mal", mal };
            } else if (trimmed.includes("->")) {
                const { lhs, rhs } = parse_production(trimmed, loc);
                const cats = rhs.map((c) => c.cat);
                const r: rule = {
                    lhs: lhs.cat,
                    rhs: cats,
                    eqs: [],
                    name: prod_name(lhs.cat, cats),
                    head: compute_head(lhs.cat, cats),
                };
                rules.push(r);
                nonterminals.add(lhs.cat);
                cur = { kind: "rule", rule: r, resolve: make_resolver(lhs, rhs, loc) };
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
                cur.rule.eqs.push(parse_equation(trimmed, loc, cur.resolve));
            } else if (cur.kind === "lex") {
                morph_lines.push(raw);
            } else if (trimmed.startsWith("*ERR")) {
                cur.mal.err = parse_quoted(trimmed.slice(4).trim(), loc);
            } else if (trimmed.startsWith("*FIX")) {
                // fixes for a matched mal-rule are derived automatically (every
                // constituent reordering that parses clean), so a hand-written
                // *FIX would be dead data; reject it rather than ignore it.
                throw new grammar_error(loc, `*FIX is not supported in %mal blocks (reorder fixes are derived automatically)`);
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

    // Start defaults to the first rule's LHS unless declared; an explicit
    // %start must name a real nonterminal. The tokenizer comes from the registry.
    if (start_sym !== null && !nonterminals.has(start_sym)) {
        throw new grammar_error(opts.filename ?? "en.gram", `%start ${start_sym} is not a nonterminal`);
    }
    const start = start_sym ?? rules[0]?.lhs ?? "S";
    const tokenize = build_tokenizer(tokenizer_name, clitics);

    return {
        lexicon, rules, malrules, nonterminals, features, classes, morph, morph_fst, morph_cascade,
        start, tokenize,
    };
}
