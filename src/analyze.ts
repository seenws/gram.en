import { type grammar, type lex_entry } from "./grammar.ts";
import { get_path, unify } from "./featstruct.ts";
import {
    type tree,
    type violation,
    build_lex_items,
    make_ctx,
    full_parses,
    match_sequence,
} from "./parser.ts";
import { tokenize_spans } from "./tokenize.ts";
import { morph_analyze } from "./morph.ts";
import { effective_entries } from "./morph_lexc.ts";

// span is a token range [i, j); char_span is the matching character range in the source sentence
export type reported_violation = {
    message: string;
    rule: string;
    span: [number, number];
    char_span: [number, number];
    fixes: string[];
};

export type verdict = "grammatical" | "ungrammatical" | "no-analysis" | "unknown-word";

export type analysis = {
    verdict: verdict;
    tokens: string[];
    tree: tree | null;
    violations: reported_violation[];
    unknown_words: string[];
};

export function analyze(g: grammar, sentence: string): analysis {
    const spanned = tokenize_spans(sentence);
    const tokens = spanned.map((t) => t.text);
    const char_span = (span: [number, number]): [number, number] =>
        span[1] > span[0] && span[1] <= spanned.length
            ? [spanned[span[0]].start, spanned[span[1] - 1].end]
            : [0, sentence.length];

    const unknown = tokens.filter((t) => morph_analyze(g, t).length === 0);

    if (unknown.length > 0) {
        return { verdict: "unknown-word", tokens, tree: null, violations: [], unknown_words: unknown };
    }

    const n = tokens.length;
    const lex = build_lex_items(g, tokens);
    const strict = full_parses(make_ctx(g, lex, false), n);

    // strict parses can now carry leaf-level violations from error-tagged
    // morphology (e.g. *childs). zero-violation strict → grammatical; strict
    // with morph violations → ungrammatical; no strict parse at all → relax
    if (strict.length > 0) {
        let best = strict[0];

        for (const e of strict) {
            if (e.violations.length < best.violations.length) best = e;
        }

        if (best.violations.length === 0) {
            return { verdict: "grammatical", tokens, tree: best.tree, violations: [], unknown_words: [] };
        }

        const reported = dedupe(best.violations).map((v) => ({
            message: v.message,
            rule: v.rule,
            span: v.span,
            char_span: char_span(v.span),
            fixes: generate_fixes(g, tokens, best.tree, v, best.violations.length),
        }));

        return { verdict: "ungrammatical", tokens, tree: best.tree, violations: reported, unknown_words: [] };
    }

    const relaxed = full_parses(make_ctx(g, lex, true), n);

    if (relaxed.length > 0) {
        let best = relaxed[0];

        for (const e of relaxed) {
            if (e.violations.length < best.violations.length) best = e;
        }

        const reported = dedupe(best.violations).map((v) => ({
            message: v.message,
            rule: v.rule,
            span: v.span,
            char_span: char_span(v.span),
            fixes: generate_fixes(g, tokens, best.tree, v, best.violations.length),
        }));

        return { verdict: "ungrammatical", tokens, tree: best.tree, violations: reported, unknown_words: [] };
    }

    for (const mal of g.malrules) {
        const matches = match_sequence(make_ctx(g, lex, false), mal.rhs, n);

        if (matches.length > 0) {
            const blocks = matches[0].map((c) => [c.start, c.end] as [number, number]);

            return {
                verdict: "ungrammatical",
                tokens,
                tree: null,
                violations: [{
                    message: mal.err,
                    rule: mal.name,
                    span: [0, n],
                    char_span: char_span([0, n]),
                    fixes: reorder_fixes(g, tokens, blocks),
                }],
                unknown_words: [],
            };
        }
    }

    // no parse and no known error pattern: report as uncovered, not ungrammatical
    return { verdict: "no-analysis", tokens, tree: null, violations: [], unknown_words: [] };
}

function dedupe(vs: violation[]): violation[] {
    const seen = new Set<string>();
    const out: violation[] = [];

    for (const v of vs) {
        const key = `${v.rule}|${v.message}|${v.span[0]},${v.span[1]}`;

        if (!seen.has(key)) {
            seen.add(key);
            out.push(v);
        }
    }

    return out;
}

function entries(g: grammar): lex_entry[] {
    const out: lex_entry[] = [...g.lexicon.values()].flat();

    for (const r of g.morph.roots) {
        const p = g.morph.paradigms.get(r.paradigm);

        if (!p) continue;

        for (const e of effective_entries(r, p)) {
            // error-tagged entries describe known-wrong surfaces; a fix
            // suggestion should never propose one
            if (e.error !== undefined) continue;

            const merged = unify(r.feats, e.feats);

            if (merged === null) continue;

            out.push({ form: r.surface + e.surface, cat: p.cat, feats: merged });
        }
    }

    return out;
}

function feat_of(e: lex_entry, feat: string): string | null {
    const v = get_path(e.feats, [feat]);

    return v && v.kind === "atom" ? v.val : null;
}

function find_leaf(t: tree, cat: string): { pos: number; lemma: string | null; form: string } | null {
    if (t.kind === "leaf") {
        if (t.sym !== cat) return null;

        const lm = get_path(t.fs, ["lemma"]);

        return { pos: t.pos, lemma: lm && lm.kind === "atom" ? lm.val : null, form: t.form };
    }

    for (const child of t.children) {
        const found = find_leaf(child, cat);

        if (found) return found;
    }

    return null;
}

function generate_fixes(g: grammar, tokens: string[], t: tree, v: violation, base_count: number): string[] {
    const out = new Set<string>();

    for (const strat of v.fix_strategies) {
        for (const cand of candidates_for(g, strat, tokens, t, v)) {
            // only keep a repair that lowers the violation count: a clean parse for a
            // single-error sentence, an incremental fix for a multi-error one
            if (violation_count(g, cand) < base_count) out.add(cand.join(" "));
        }
    }

    return [...out];
}

function candidates_for(g: grammar, strat: string, tokens: string[], t: tree, v: violation): string[][] {
    const sub = (pos: number, form: string): string[] => tokens.map((tok, i) => (i === pos ? form : tok));
    const same_lemma = (cat: string, leaf: { pos: number; lemma: string | null }): string[][] =>
        entries(g)
            .filter((e) => e.cat === cat && feat_of(e, "lemma") === leaf.lemma && e.form.toLowerCase() !== tokens[leaf.pos].toLowerCase())
            .map((e) => sub(leaf.pos, e.form));

    // morph mal-rules carry the correct surface in the strategy itself; the
    // token position is the start of the violation's span
    if (strat.startsWith("literal:")) {
        const form = strat.slice("literal:".length);
        return [sub(v.span[0], form)];
    }

    switch (strat) {
        case "agree-verb": {
            const leaf = find_leaf(t, "V");

            return leaf ? same_lemma("V", leaf) : [];
        }
        case "agree-subject":
        case "agree-noun": {
            const leaf = find_leaf(t, "N");

            return leaf ? same_lemma("N", leaf) : [];
        }
        case "agree-det":
        case "agree-article": {
            const leaf = find_leaf(t, "Det");

            if (!leaf) return [];

            return entries(g)
                .filter((e) => e.cat === "Det" && e.form.toLowerCase() !== tokens[leaf.pos].toLowerCase())
                .map((e) => sub(leaf.pos, e.form));
        }
        case "add-determiner": {
            const leaf = find_leaf(t, "N");

            if (!leaf) return [];

            return entries(g)
                .filter((e) => e.cat === "Det")
                .map((e) => [...tokens.slice(0, leaf.pos), e.form, ...tokens.slice(leaf.pos)]);
        }
        case "nominative-pronoun":
        case "accusative-pronoun": {
            const want = strat === "nominative-pronoun" ? "nom" : "acc";
            const leaf = find_leaf(t, "Pron");

            if (!leaf) return [];

            return entries(g)
                .filter((e) => e.cat === "Pron" && feat_of(e, "lemma") === leaf.lemma && feat_of(e, "case") === want)
                .map((e) => sub(leaf.pos, e.form));
        }
        default:
            return [];
    }
}

function reorder_fixes(g: grammar, tokens: string[], blocks: [number, number][]): string[] {
    const out = new Set<string>();

    for (const perm of permutations(blocks.map((_, i) => i))) {
        const cand: string[] = [];

        for (const bi of perm) {
            const [s, e] = blocks[bi];

            for (let k = s; k < e; k++) cand.push(tokens[k]);
        }

        if (cand.join(" ") !== tokens.join(" ") && parses_clean(g, cand)) out.add(cand.join(" "));
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

export function parses_clean(g: grammar, tokens: string[]): boolean {
    if (tokens.some((t) => morph_analyze(g, t).length === 0)) return false;

    const c = make_ctx(g, build_lex_items(g, tokens), false);

    return full_parses(c, tokens.length).some((e) => e.violations.length === 0);
}

function violation_count(g: grammar, tokens: string[]): number {
    if (tokens.some((t) => morph_analyze(g, t).length === 0)) return Infinity;

    if (parses_clean(g, tokens)) return 0;

    const lex = build_lex_items(g, tokens);
    const relaxed = full_parses(make_ctx(g, lex, true), tokens.length);

    if (relaxed.length === 0) return Infinity;

    return Math.min(...relaxed.map((e) => e.violations.length));
}
