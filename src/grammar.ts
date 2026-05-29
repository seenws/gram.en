import { type feature_struct, fs, atom, set_path } from "./featstruct.ts";
import { type fst } from "./fst.ts";
import { type morph_data, type morph_diag, compile_morph_fst, parse_morph_data } from "./morph_lexc.ts";

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
    morph: morph_data;
    morph_fst: fst | null;
};

export class grammar_error extends Error {
    constructor(line: number, msg: string) {
        super(`en.gram line ${line + 1}: ${msg}`);
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

function parse_production(s: string, ln: number): { lhs: string; rhs: string[] } {
    const i = s.indexOf("->");

    if (i < 0) throw new grammar_error(ln, `production missing "->": ${s}`);

    const lhs = s.slice(0, i).trim();
    const rhs = s.slice(i + 2).trim().split(/\s+/).filter(Boolean);

    if (lhs.length === 0 || rhs.length === 0) throw new grammar_error(ln, `malformed production: ${s}`);

    return { lhs, rhs };
}

function parse_path(s: string, ln: number): path {
    const m = s.match(/^<([^>]*)>$/);

    if (!m) throw new grammar_error(ln, `malformed path: ${s}`);

    const toks = m[1].trim().split(/\s+/).filter(Boolean);

    if (toks.length === 0) throw new grammar_error(ln, `empty path: ${s}`);

    return { constituent: toks[0], feats: toks.slice(1) };
}

function parse_quoted(s: string, ln: number): string {
    const m = s.match(/"([^"]*)"/);

    if (!m) throw new grammar_error(ln, `expected a quoted string: ${s}`);

    return m[1];
}

function parse_lex_entry(line: string, ln: number): lex_entry {
    const ci = line.indexOf(":");
    const form = line.slice(0, ci).trim();
    const rest = line.slice(ci + 1).trim();
    const cm = rest.match(/^(\S+)/);

    if (!cm) throw new grammar_error(ln, `lexicon entry missing category: ${line}`);

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

function parse_equation(line: string, ln: number): equation {
    const bang = line.indexOf("!");
    const core = (bang >= 0 ? line.slice(0, bang) : line).trim();
    const diag_str = bang >= 0 ? line.slice(bang + 1).trim() : null;
    const eq = core.indexOf("=");

    if (eq < 0) throw new grammar_error(ln, `equation missing "=": ${line}`);

    const left = parse_path(core.slice(0, eq).trim(), ln);
    const right_str = core.slice(eq + 1).trim();
    const right: term = right_str.startsWith("<")
        ? { kind: "path", path: parse_path(right_str, ln) }
        : { kind: "value", value: right_str };

    let d: diag | null = null;

    if (diag_str) {
        const message = parse_quoted(diag_str, ln);
        const fi = diag_str.indexOf("fix:");
        const fixes = fi >= 0 ? diag_str.slice(fi + 4).split("|").map((x) => x.trim()).filter(Boolean) : [];
        d = { message, fixes };
    }

    return { left, right, diag: d };
}

export function parse_grammar(text: string): grammar {
    const lexicon = new Map<string, lex_entry[]>();
    const rules: rule[] = [];
    const malrules: mal_rule[] = [];
    const nonterminals = new Set<string>();
    const morph_lines: string[] = [];

    type cursor =
        | { kind: "rule"; rule: rule }
        | { kind: "mal"; mal: mal_rule }
        | { kind: "lex" }
        | null;
    let cur: cursor = null;

    const lines = text.split(/\r?\n/);

    for (let ln = 0; ln < lines.length; ln++) {
        const raw = lines[ln];
        const body = strip_comment(raw);
        const trimmed = body.trim();

        if (trimmed.length === 0) {
            // blank lines are inert; they don't close the lex cursor because
            // a %lex block is allowed to have blanks between entries
            continue;
        }

        const indented = /^\s/.test(body);

        if (!indented) {
            if (trimmed.startsWith("%lex")) {
                morph_lines.push(raw);
                cur = { kind: "lex" };
            } else if (trimmed.startsWith("%mal")) {
                const { lhs, rhs } = parse_production(trimmed.slice(4).trim(), ln);
                const mal: mal_rule = { lhs, rhs, err: "", fix: null, name: prod_name(lhs, rhs) };
                malrules.push(mal);
                nonterminals.add(lhs);
                cur = { kind: "mal", mal };
            } else if (trimmed.includes("->")) {
                const { lhs, rhs } = parse_production(trimmed, ln);
                const r: rule = { lhs, rhs, eqs: [], name: prod_name(lhs, rhs) };
                rules.push(r);
                nonterminals.add(lhs);
                cur = { kind: "rule", rule: r };
            } else if (trimmed.includes(":")) {
                const entry = parse_lex_entry(trimmed, ln);
                const key = entry.form.toLowerCase();
                const bucket = lexicon.get(key);

                if (bucket) {
                    bucket.push(entry);
                } else {
                    lexicon.set(key, [entry]);
                }

                cur = null;
            } else {
                throw new grammar_error(ln, `unrecognized line: ${trimmed}`);
            }
        } else {
            if (cur === null) throw new grammar_error(ln, `indented line without a preceding rule: ${trimmed}`);

            if (cur.kind === "rule") {
                cur.rule.eqs.push(parse_equation(trimmed, ln));
            } else if (cur.kind === "lex") {
                morph_lines.push(raw);
            } else if (trimmed.startsWith("*ERR")) {
                cur.mal.err = parse_quoted(trimmed.slice(4).trim(), ln);
            } else if (trimmed.startsWith("*FIX")) {
                cur.mal.fix = trimmed.slice(4).trim();
            } else {
                throw new grammar_error(ln, `unrecognized mal-rule line: ${trimmed}`);
            }
        }
    }

    const morph = morph_lines.length > 0
        ? parse_morph_data(morph_lines.join("\n"))
        : { roots: [], paradigms: new Map() };
    const morph_fst = morph.roots.length > 0 ? compile_morph_fst(morph) : null;

    return { lexicon, rules, malrules, nonterminals, morph, morph_fst };
}
