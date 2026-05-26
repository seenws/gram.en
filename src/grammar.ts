// Loader for the .gram DSL (notes section 14). Line-based: comments (`#`),
// lexicon entries (`form : CAT <path>=value ...`), phrase-structure rules
// (a production line plus indented `<path> = <path|value>` equations, each
// optionally tagged `! "message" fix: a | b`), and mal-rules (`%mal` + `*ERR`/`*FIX`).

import { type FS, fs, atom, setPath } from "./featstruct.ts";

export type Path = { constituent: string; feats: string[] };
export type Term = { kind: "path"; path: Path } | { kind: "value"; value: string };
export type Diag = { message: string; fixes: string[] };
export type Equation = { left: Path; right: Term; diag: Diag | null };
export type Rule = { lhs: string; rhs: string[]; eqs: Equation[]; name: string };
export type MalRule = { lhs: string; rhs: string[]; err: string; fix: string | null; name: string };
export type LexEntry = { form: string; cat: string; feats: FS };

export type Grammar = {
    lexicon: Map<string, LexEntry[]>; // keyed by lowercased surface form
    rules: Rule[];
    malrules: MalRule[];
    nonterminals: Set<string>;
};

export class GrammarError extends Error {
    constructor(line: number, msg: string) {
        super(`en.gram line ${line + 1}: ${msg}`);
        this.name = "GrammarError";
    }
}

function stripComment(line: string): string {
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') inQuote = !inQuote;
        else if (c === "#" && !inQuote) return line.slice(0, i);
    }
    return line;
}

function prodName(lhs: string, rhs: string[]): string {
    return `${lhs} -> ${rhs.join(" ")}`;
}

function parseProduction(s: string, ln: number): { lhs: string; rhs: string[] } {
    const i = s.indexOf("->");
    if (i < 0) throw new GrammarError(ln, `production missing "->": ${s}`);
    const lhs = s.slice(0, i).trim();
    const rhs = s.slice(i + 2).trim().split(/\s+/).filter(Boolean);
    if (lhs.length === 0 || rhs.length === 0) throw new GrammarError(ln, `malformed production: ${s}`);
    return { lhs, rhs };
}

function parsePath(s: string, ln: number): Path {
    const m = s.match(/^<([^>]*)>$/);
    if (!m) throw new GrammarError(ln, `malformed path: ${s}`);
    const toks = m[1].trim().split(/\s+/).filter(Boolean);
    if (toks.length === 0) throw new GrammarError(ln, `empty path: ${s}`);
    return { constituent: toks[0], feats: toks.slice(1) };
}

function parseQuoted(s: string, ln: number): string {
    const m = s.match(/"([^"]*)"/);
    if (!m) throw new GrammarError(ln, `expected a quoted string: ${s}`);
    return m[1];
}

function parseLexEntry(line: string, ln: number): LexEntry {
    const ci = line.indexOf(":");
    const form = line.slice(0, ci).trim();
    const rest = line.slice(ci + 1).trim();
    const cm = rest.match(/^(\S+)/);
    if (!cm) throw new GrammarError(ln, `lexicon entry missing category: ${line}`);
    const cat = cm[1];
    let feats = fs();
    const re = /<([^>]*)>\s*=\s*(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rest)) !== null) {
        const path = m[1].trim().split(/\s+/).filter(Boolean);
        feats = setPath(feats, path, atom(m[2]));
    }
    return { form, cat, feats };
}

function parseEquation(line: string, ln: number): Equation {
    const bang = line.indexOf("!");
    const core = (bang >= 0 ? line.slice(0, bang) : line).trim();
    const diagStr = bang >= 0 ? line.slice(bang + 1).trim() : null;

    const eq = core.indexOf("=");
    if (eq < 0) throw new GrammarError(ln, `equation missing "=": ${line}`);
    const left = parsePath(core.slice(0, eq).trim(), ln);
    const rightStr = core.slice(eq + 1).trim();
    const right: Term = rightStr.startsWith("<")
        ? { kind: "path", path: parsePath(rightStr, ln) }
        : { kind: "value", value: rightStr };

    let diag: Diag | null = null;
    if (diagStr) {
        const message = parseQuoted(diagStr, ln);
        const fi = diagStr.indexOf("fix:");
        const fixes = fi >= 0 ? diagStr.slice(fi + 4).split("|").map((x) => x.trim()).filter(Boolean) : [];
        diag = { message, fixes };
    }
    return { left, right, diag };
}

export function parseGrammar(text: string): Grammar {
    const lexicon = new Map<string, LexEntry[]>();
    const rules: Rule[] = [];
    const malrules: MalRule[] = [];
    const nonterminals = new Set<string>();

    type Cur = { kind: "rule"; rule: Rule } | { kind: "mal"; mal: MalRule } | null;
    let cur: Cur = null;

    const lines = text.split(/\r?\n/);
    for (let ln = 0; ln < lines.length; ln++) {
        const raw = lines[ln];
        const body = stripComment(raw);
        const trimmed = body.trim();
        if (trimmed.length === 0) continue;
        const indented = /^\s/.test(body);

        if (!indented) {
            if (trimmed.startsWith("%mal")) {
                const { lhs, rhs } = parseProduction(trimmed.slice(4).trim(), ln);
                const mal: MalRule = { lhs, rhs, err: "", fix: null, name: prodName(lhs, rhs) };
                malrules.push(mal);
                nonterminals.add(lhs);
                cur = { kind: "mal", mal };
            } else if (trimmed.includes("->")) {
                const { lhs, rhs } = parseProduction(trimmed, ln);
                const rule: Rule = { lhs, rhs, eqs: [], name: prodName(lhs, rhs) };
                rules.push(rule);
                nonterminals.add(lhs);
                cur = { kind: "rule", rule };
            } else if (trimmed.includes(":")) {
                const entry = parseLexEntry(trimmed, ln);
                const key = entry.form.toLowerCase();
                const bucket = lexicon.get(key);
                if (bucket) bucket.push(entry);
                else lexicon.set(key, [entry]);
                cur = null;
            } else {
                throw new GrammarError(ln, `unrecognized line: ${trimmed}`);
            }
        } else {
            if (cur === null) throw new GrammarError(ln, `indented line without a preceding rule: ${trimmed}`);
            if (cur.kind === "rule") {
                cur.rule.eqs.push(parseEquation(trimmed, ln));
            } else if (trimmed.startsWith("*ERR")) {
                cur.mal.err = parseQuoted(trimmed.slice(4).trim(), ln);
            } else if (trimmed.startsWith("*FIX")) {
                cur.mal.fix = trimmed.slice(4).trim();
            } else {
                throw new GrammarError(ln, `unrecognized mal-rule line: ${trimmed}`);
            }
        }
    }
    return { lexicon, rules, malrules, nonterminals };
}
