import { type grammar, type lex_entry } from "./grammar.ts";
import { get_path, unify, show_fs } from "./featstruct.ts";
import {
    type tree,
    type tracer,
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

export type analyze_options = { trace?: tracer };

export function analyze(g: grammar, sentence: string, opts: analyze_options = {}): analysis {
    const spanned = tokenize_spans(sentence);
    const tokens = spanned.map((t) => t.text);
    const char_span = (span: [number, number]): [number, number] =>
        span[1] > span[0] && span[1] <= spanned.length
            ? [spanned[span[0]].start, spanned[span[1] - 1].end]
            : [0, sentence.length];

    const trace = opts.trace;

    if (trace) {
        trace(`tokens: ${tokens.map((t, i) => `${i}:"${t}"`).join("  ") || "(none)"}`);
        trace("=== morphology ===");
        tokens.forEach((t, i) => {
            const a = morph_analyze(g, t).map((e) => `${e.cat}${show_fs(e.feats)}${e.morph_err ? " *ERR" : ""}`);
            trace(`  [${i}] "${t}" → ${a.join("  ") || "∅ (unknown word)"}`);
        });
        trace("=== earley parse (strict) ===");
    }

    const unknown = tokens.filter((t) => morph_analyze(g, t).length === 0);

    if (unknown.length > 0) {
        return { verdict: "unknown-word", tokens, tree: null, violations: [], unknown_words: unknown };
    }

    const n = tokens.length;
    const lex = build_lex_items(g, tokens);
    const strict = full_parses(make_ctx(g, lex, false, trace), n);

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

// Every surface form the grammar can produce -- explicit lexicon entries plus
// each (root, paradigm-entry) expansion -- as the candidate pool for fixes.
function build_entries(g: grammar): lex_entry[] {
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

// Fix generation looks up replacement forms by category, and sometimes by
// (category, lemma). Building and scanning the whole entry list per lookup made
// fix generation O(lexicon size); we instead build these indexes once per
// grammar (immutable after parsing) and reuse them across every fix and every
// re-parsed candidate. See the benchmark's "relaxed" rows.
type fix_index = {
    by_cat: Map<string, lex_entry[]>;
    by_cat_lemma: Map<string, lex_entry[]>; // key: `${cat}\t${lemma ?? ""}`
};

const fix_index_cache = new WeakMap<grammar, fix_index>();

function fix_index_of(g: grammar): fix_index {
    let idx = fix_index_cache.get(g);

    if (idx === undefined) {
        const by_cat = new Map<string, lex_entry[]>();
        const by_cat_lemma = new Map<string, lex_entry[]>();
        const push = (m: Map<string, lex_entry[]>, k: string, e: lex_entry): void => {
            const bucket = m.get(k);

            if (bucket) bucket.push(e);
            else m.set(k, [e]);
        };

        for (const e of build_entries(g)) {
            push(by_cat, e.cat, e);
            push(by_cat_lemma, `${e.cat}\t${feat_of(e, "lemma") ?? ""}`, e);
        }

        idx = { by_cat, by_cat_lemma };
        fix_index_cache.set(g, idx);
    }

    return idx;
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

// Bound the relaxed-parse work per violation so it stays flat as the lexicon grows.
// The worst case today emits <= 3 fixes, all early in candidate order, so these
// generous caps never drop a real suggestion.
// Future: a smarter ranking could let us tighten these once strategies are ordered
// by likelihood rather than declaration order.
const MAX_FIXES = 4;
const MAX_TRIES = 16;

function generate_fixes(g: grammar, tokens: string[], t: tree, v: violation, base_count: number): string[] {
    const out = new Set<string>();
    const tried = new Set<string>();

    outer: for (const strat of v.fix_strategies) {
        for (const cand of candidates_for(g, strat, tokens, t, v)) {
            if (out.size >= MAX_FIXES || tried.size >= MAX_TRIES) break outer;

            const key = cand.join(" ");

            // a repair reachable from two strategies is parsed once, not twice
            if (tried.has(key)) continue;
            tried.add(key);

            // only keep a repair that lowers the violation count: a clean parse for a
            // single-error sentence, an incremental fix for a multi-error one
            if (beats_base(g, cand, base_count)) out.add(key);
        }
    }

    return [...out];
}

function candidates_for(g: grammar, strat: string, tokens: string[], t: tree, v: violation): string[][] {
    const idx = fix_index_of(g);
    const of_cat = (cat: string): lex_entry[] => idx.by_cat.get(cat) ?? [];
    const of_cat_lemma = (cat: string, lemma: string | null): lex_entry[] =>
        idx.by_cat_lemma.get(`${cat}\t${lemma ?? ""}`) ?? [];
    const sub = (pos: number, form: string): string[] => tokens.map((tok, i) => (i === pos ? form : tok));
    const same_lemma = (cat: string, leaf: { pos: number; lemma: string | null }): string[][] =>
        of_cat_lemma(cat, leaf.lemma)
            .filter((e) => e.form.toLowerCase() !== tokens[leaf.pos].toLowerCase())
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

            return of_cat("Det")
                .filter((e) => e.form.toLowerCase() !== tokens[leaf.pos].toLowerCase())
                .map((e) => sub(leaf.pos, e.form));
        }
        case "add-determiner": {
            const leaf = find_leaf(t, "N");

            if (!leaf) return [];

            return of_cat("Det")
                .map((e) => [...tokens.slice(0, leaf.pos), e.form, ...tokens.slice(leaf.pos)]);
        }
        case "nominative-pronoun":
        case "accusative-pronoun": {
            const want = strat === "nominative-pronoun" ? "nom" : "acc";
            const leaf = find_leaf(t, "Pron");

            if (!leaf) return [];

            return of_cat_lemma("Pron", leaf.lemma)
                .filter((e) => feat_of(e, "case") === want)
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

// True iff re-parsing `tokens` yields strictly fewer violations than `base_count`.
// For the dominant base_count === 1 case a clean strict parse is the only way to
// win, so we skip the relaxed parse entirely; the relaxed count is consulted only
// to detect a *partial* improvement (base_count > 1).
function beats_base(g: grammar, tokens: string[], base_count: number): boolean {
    if (tokens.some((t) => morph_analyze(g, t).length === 0)) return false;

    if (parses_clean(g, tokens)) return true; // 0 violations < base_count

    if (base_count <= 1) return false; // only a clean parse beats a single error

    const relaxed = full_parses(make_ctx(g, build_lex_items(g, tokens), true), tokens.length);

    return relaxed.length > 0 && Math.min(...relaxed.map((e) => e.violations.length)) < base_count;
}
