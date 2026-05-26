// Recursive-descent backtracking parser with feature unification, over the
// context-free backbone of a Grammar. The grammar is non-left-recursive and
// finite, and inputs are short, so backtracking terminates and stays cheap
// (notes section 3 names CKY/Earley as the polynomial drop-in for later).
//
// In relaxation mode, a *tagged* (`!`) equation that fails to unify records a
// Violation and is skipped instead of failing the parse; untagged (structural)
// equations always hard-fail. Each parse carries the violations it incurred.

import { type FS, fs, atom, unify, getPath, setPath } from "./featstruct.ts";
import type { Grammar, Rule, Equation, Term, Path } from "./grammar.ts";

export type Tree =
    | { kind: "leaf"; sym: string; form: string; fs: FS; pos: number }
    | { kind: "node"; sym: string; children: Tree[]; fs: FS; rule: string };

export type Violation = {
    rule: string;
    message: string;
    fixStrategies: string[];
    span: [number, number];
};

export type LexItem = { cat: string; feats: FS; form: string };
export type Edge = { start: number; end: number; tree: Tree; violations: Violation[] };
type Seq = { end: number; children: Edge[]; violations: Violation[] };

export type Ctx = {
    g: Grammar;
    lex: LexItem[][];
    relax: boolean;
    memo: Map<string, Edge[]>;
};

export function buildLexItems(g: Grammar, tokens: string[]): LexItem[][] {
    return tokens.map((t) => {
        const entries = g.lexicon.get(t.toLowerCase()) ?? [];
        return entries.map((e) => ({ cat: e.cat, feats: e.feats, form: e.form }));
    });
}

export function makeCtx(g: Grammar, lex: LexItem[][], relax: boolean): Ctx {
    return { g, lex, relax, memo: new Map() };
}

export function parseSym(ctx: Ctx, sym: string, i: number): Edge[] {
    const key = `${sym}|${i}`;
    const cached = ctx.memo.get(key);
    if (cached !== undefined) return cached;

    const result: Edge[] = [];
    if (!ctx.g.nonterminals.has(sym)) {
        if (i < ctx.lex.length) {
            for (const item of ctx.lex[i]) {
                if (item.cat === sym) {
                    result.push({
                        start: i,
                        end: i + 1,
                        tree: { kind: "leaf", sym, form: item.form, fs: item.feats, pos: i },
                        violations: [],
                    });
                }
            }
        }
    } else {
        for (const rule of ctx.g.rules) {
            if (rule.lhs !== sym) continue;
            for (const seq of parseSeq(ctx, rule.rhs, 0, i)) {
                const applied = applyEquations(ctx, rule, seq.children, i, seq.end);
                if (applied === null) continue;
                result.push({
                    start: i,
                    end: seq.end,
                    tree: { kind: "node", sym: rule.lhs, children: seq.children.map((c) => c.tree), fs: applied.lhsFS, rule: rule.name },
                    violations: [...seq.violations, ...applied.eqViolations],
                });
            }
        }
    }
    ctx.memo.set(key, result);
    return result;
}

function parseSeq(ctx: Ctx, syms: string[], k: number, pos: number): Seq[] {
    if (k === syms.length) return [{ end: pos, children: [], violations: [] }];
    const out: Seq[] = [];
    for (const e of parseSym(ctx, syms[k], pos)) {
        for (const rest of parseSeq(ctx, syms, k + 1, e.end)) {
            out.push({
                end: rest.end,
                children: [e, ...rest.children],
                violations: [...e.violations, ...rest.violations],
            });
        }
    }
    return out;
}

function resolveTerm(env: Map<string, FS>, term: Term): FS | undefined {
    if (term.kind === "value") return atom(term.value);
    const base = env.get(term.path.constituent);
    if (base === undefined) return undefined;
    return getPath(base, term.path.feats);
}

function writeBack(env: Map<string, FS>, path: Path, val: FS): void {
    const base = env.get(path.constituent);
    if (base === undefined) return;
    env.set(path.constituent, setPath(base, path.feats, val));
}

function applyEquations(
    ctx: Ctx,
    rule: Rule,
    children: Edge[],
    start: number,
    end: number,
): { lhsFS: FS; eqViolations: Violation[] } | null {
    const env = new Map<string, FS>();
    env.set(rule.lhs, fs());
    rule.rhs.forEach((sym, idx) => env.set(sym, children[idx].tree.fs));

    const eqViolations: Violation[] = [];
    for (const eq of rule.eqs) {
        const lv = resolveTerm(env, { kind: "path", path: eq.left }) ?? fs();
        const rv = resolveTerm(env, eq.right) ?? fs();
        const u = unify(lv, rv);
        if (u === null) {
            if (eq.diag !== null && ctx.relax) {
                eqViolations.push(makeViolation(rule, eq, children, start, end));
                continue;
            }
            return null;
        }
        writeBack(env, eq.left, u);
        if (eq.right.kind === "path") writeBack(env, eq.right.path, u);
    }
    return { lhsFS: env.get(rule.lhs) ?? fs(), eqViolations };
}

function makeViolation(rule: Rule, eq: Equation, children: Edge[], start: number, end: number): Violation {
    // Highlight the right-hand constituent when the constraint relates two
    // constituents (e.g. the verb in S -> NP VP), else the left (e.g. the subject
    // pronoun in <NP case> = nom).
    const c = eq.right.kind === "path" ? eq.right.path.constituent : eq.left.constituent;
    const idx = rule.rhs.indexOf(c);
    const span: [number, number] = idx >= 0 ? [children[idx].start, children[idx].end] : [start, end];
    const diag = eq.diag as { message: string; fixes: string[] };
    return { rule: rule.name, message: diag.message, fixStrategies: diag.fixes, span };
}

export function fullParses(ctx: Ctx, n: number): Edge[] {
    return parseSym(ctx, "S", 0).filter((e) => e.end === n);
}

// Full-span matches of a bare symbol sequence, used to fire mal-rules.
export function matchSequence(ctx: Ctx, syms: string[], n: number): Edge[][] {
    return parseSeq(ctx, syms, 0, 0)
        .filter((s) => s.end === n)
        .map((s) => s.children);
}
