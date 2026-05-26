// Pipeline + verdict logic (notes section 6 ordering, section 13 report shape):
//   tokenize -> lexicon lookup (unknown words) -> strict parse -> relaxed parse
//   (locate the minimal violated constraint) -> mal-rules -> no analysis.
// Fixes are generated per strategy and re-validated by re-parsing, so only
// repairs that fully parse are offered (this handles interacting errors).

import { type Grammar, type LexEntry } from "./grammar.ts";
import { getPath } from "./featstruct.ts";
import {
    type Tree,
    type Violation,
    buildLexItems,
    makeCtx,
    parseSym,
    fullParses,
    matchSequence,
} from "./parser.ts";
import { tokenizeSpans, type Token } from "./tokenize.ts";

// span is a token range [i, j); charSpan is the corresponding character range in
// the original sentence, for the UI to underline.
export type ReportedViolation = {
    message: string;
    rule: string;
    span: [number, number];
    charSpan: [number, number];
    fixes: string[];
};
export type Verdict = "grammatical" | "ungrammatical" | "no-analysis" | "unknown-word";
export type Analysis = {
    verdict: Verdict;
    tokens: string[];
    tree: Tree | null;
    violations: ReportedViolation[];
    unknownWords: string[];
};

export function analyze(g: Grammar, sentence: string): Analysis {
    const spanned = tokenizeSpans(sentence);
    const tokens = spanned.map((t) => t.text);
    const charSpan = (span: [number, number]): [number, number] =>
        span[1] > span[0] && span[1] <= spanned.length
            ? [spanned[span[0]].start, spanned[span[1] - 1].end]
            : [0, sentence.length];

    const unknown = tokens.filter((t) => !g.lexicon.has(t.toLowerCase()));
    if (unknown.length > 0) {
        return { verdict: "unknown-word", tokens, tree: null, violations: [], unknownWords: unknown };
    }

    const n = tokens.length;
    const lex = buildLexItems(g, tokens);

    // 1. Strict parse: any clean full-span S means grammatical.
    const strict = fullParses(makeCtx(g, lex, false), n).filter((e) => e.violations.length === 0);
    if (strict.length > 0) {
        return { verdict: "grammatical", tokens, tree: strict[0].tree, violations: [], unknownWords: [] };
    }

    // 2. Relaxed parse: pick the full-span parse with the fewest violated tags.
    const relaxed = fullParses(makeCtx(g, lex, true), n);
    if (relaxed.length > 0) {
        let best = relaxed[0];
        for (const e of relaxed) if (e.violations.length < best.violations.length) best = e;
        const reported = dedupe(best.violations).map((v) => ({
            message: v.message,
            rule: v.rule,
            span: v.span,
            charSpan: charSpan(v.span),
            fixes: generateFixes(g, tokens, best.tree, v),
        }));
        return { verdict: "ungrammatical", tokens, tree: best.tree, violations: reported, unknownWords: [] };
    }

    // 3. Mal-rules: a known wrong pattern that spans the whole input.
    for (const mal of g.malrules) {
        const matches = matchSequence(makeCtx(g, lex, false), mal.rhs, n);
        if (matches.length > 0) {
            const blocks = matches[0].map((c) => [c.start, c.end] as [number, number]);
            return {
                verdict: "ungrammatical",
                tokens,
                tree: null,
                violations: [
                    { message: mal.err, rule: mal.name, span: [0, n], charSpan: charSpan([0, n]), fixes: reorderFixes(g, tokens, blocks) },
                ],
                unknownWords: [],
            };
        }
    }

    // 4. Coverage trap: no parse and no known error pattern -> not "ungrammatical".
    return { verdict: "no-analysis", tokens, tree: null, violations: [], unknownWords: [] };
}

function dedupe(vs: Violation[]): Violation[] {
    const seen = new Set<string>();
    const out: Violation[] = [];
    for (const v of vs) {
        const key = `${v.rule}|${v.message}|${v.span[0]},${v.span[1]}`;
        if (!seen.has(key)) {
            seen.add(key);
            out.push(v);
        }
    }
    return out;
}

// --- fix generation -------------------------------------------------------

function entries(g: Grammar): LexEntry[] {
    return [...g.lexicon.values()].flat();
}

function featOf(e: LexEntry, feat: string): string | null {
    const v = getPath(e.feats, [feat]);
    return v && v.kind === "atom" ? v.val : null;
}

function findLeaf(tree: Tree, cat: string): { pos: number; lemma: string | null; form: string } | null {
    if (tree.kind === "leaf") {
        if (tree.sym !== cat) return null;
        const lm = getPath(tree.fs, ["lemma"]);
        return { pos: tree.pos, lemma: lm && lm.kind === "atom" ? lm.val : null, form: tree.form };
    }
    for (const c of tree.children) {
        const r = findLeaf(c, cat);
        if (r) return r;
    }
    return null;
}

function generateFixes(g: Grammar, tokens: string[], tree: Tree, v: Violation): string[] {
    const out = new Set<string>();
    for (const strat of v.fixStrategies) {
        for (const cand of candidatesFor(g, strat, tokens, tree)) {
            if (parsesClean(g, cand)) out.add(cand.join(" "));
        }
    }
    return [...out];
}

function candidatesFor(g: Grammar, strat: string, tokens: string[], tree: Tree): string[][] {
    const sub = (pos: number, form: string): string[] => tokens.map((t, i) => (i === pos ? form : t));
    const sameLemma = (cat: string, leaf: { pos: number; lemma: string | null }): string[][] =>
        entries(g)
            .filter((e) => e.cat === cat && featOf(e, "lemma") === leaf.lemma && e.form.toLowerCase() !== tokens[leaf.pos].toLowerCase())
            .map((e) => sub(leaf.pos, e.form));

    switch (strat) {
        case "agree-verb": {
            const leaf = findLeaf(tree, "V");
            return leaf ? sameLemma("V", leaf) : [];
        }
        case "agree-subject":
        case "agree-noun": {
            const leaf = findLeaf(tree, "N");
            return leaf ? sameLemma("N", leaf) : [];
        }
        case "agree-det":
        case "agree-article": {
            const leaf = findLeaf(tree, "Det");
            if (!leaf) return [];
            return entries(g)
                .filter((e) => e.cat === "Det" && e.form.toLowerCase() !== tokens[leaf.pos].toLowerCase())
                .map((e) => sub(leaf.pos, e.form));
        }
        case "nominative-pronoun":
        case "accusative-pronoun": {
            const want = strat === "nominative-pronoun" ? "nom" : "acc";
            const leaf = findLeaf(tree, "Pron");
            if (!leaf) return [];
            return entries(g)
                .filter((e) => e.cat === "Pron" && featOf(e, "lemma") === leaf.lemma && featOf(e, "case") === want)
                .map((e) => sub(leaf.pos, e.form));
        }
        default:
            return [];
    }
}

function reorderFixes(g: Grammar, tokens: string[], blocks: [number, number][]): string[] {
    const out = new Set<string>();
    for (const perm of permutations(blocks.map((_, i) => i))) {
        const cand: string[] = [];
        for (const bi of perm) {
            const [s, e] = blocks[bi];
            for (let k = s; k < e; k++) cand.push(tokens[k]);
        }
        if (cand.join(" ") !== tokens.join(" ") && parsesClean(g, cand)) out.add(cand.join(" "));
    }
    return [...out];
}

function permutations<T>(xs: T[]): T[][] {
    if (xs.length <= 1) return [xs];
    const out: T[][] = [];
    for (let i = 0; i < xs.length; i++) {
        const rest = [...xs.slice(0, i), ...xs.slice(i + 1)];
        for (const p of permutations(rest)) out.push([xs[i], ...p]);
    }
    return out;
}

export function parsesClean(g: Grammar, tokens: string[]): boolean {
    if (tokens.some((t) => !g.lexicon.has(t.toLowerCase()))) return false;
    const ctx = makeCtx(g, buildLexItems(g, tokens), false);
    return fullParses(ctx, tokens.length).some((e) => e.violations.length === 0);
}
