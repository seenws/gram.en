import { type feature_struct, fs, atom, unify, get_path, set_path, fs_sig } from "./featstruct.ts";
import type { grammar, rule, equation, term, path, diag, const_ref } from "./grammar.ts";
import { morph_analyze } from "./morph.ts";

export type tree =
    | { kind: "leaf"; sym: string; form: string; fs: feature_struct; pos: number }
    | { kind: "node"; sym: string; children: tree[]; fs: feature_struct; rule: string };

export type violation = {
    rule: string;
    message: string;
    fix_strategies: string[];
    span: [number, number];
};

export type lex_item = { cat: string; feats: feature_struct; form: string; morph_err?: { message: string; fix: string } };
export type edge = { start: number; end: number; tree: tree; violations: violation[] };

// Optional trace sink. When present, chart_parse narrates predict/scan/complete
// steps (flagging where prediction or scanning dead-ends) and dumps the final
// chart. Off by default; threaded in only by the CLI's --trace mode.
export type tracer = (line: string) => void;

export type ctx = {
    g: grammar;
    lex: lex_item[][];
    relax: boolean;
    trace?: tracer;
};

export function build_lex_items(g: grammar, tokens: string[]): lex_item[][] {
    return tokens.map((t) => {
        const found = morph_analyze(g, t);

        return found.map((e) => ({ cat: e.cat, feats: e.feats, form: e.form, morph_err: e.morph_err }));
    });
}

export function make_ctx(g: grammar, lex: lex_item[][], relax: boolean, trace?: tracer): ctx {
    for (const r of g.rules) {
        if (r.rhs.length === 0) throw new Error(`epsilon rule not supported: ${r.name}`);
    }

    return { g, lex, relax, trace };
}

// Earley chart parser.

type item = {
    rule: rule;
    dot: number;
    origin: number;
    kids: edge[];            // completed child edges left of the dot (length === dot)
    violations: violation[]; // violations accumulated from those children
    edge: edge | null;       // mother edge, filled when the item is complete
    key: string;             // packing key, fixed at creation (rule, dot, origin, kid signatures)
};

function make_item(rule: rule, dot: number, origin: number, kids: edge[], violations: violation[]): item {
    const kid_sigs = kids.map((k) => fs_sig(k.tree.fs)).join(",");

    return { rule, dot, origin, kids, violations, edge: null, key: `${rule.name}|${dot}|${origin}|${kid_sigs}` };
}


type column = { items: Map<string, item>; queue: item[] };

// Dotted-rule rendering for trace dumps, e.g. "S → NP · VP @0 !1".
function show_item(it: item): string {
    const rhs = it.rule.rhs.slice();
    rhs.splice(it.dot, 0, "·");

    return `${it.rule.lhs} → ${rhs.join(" ")} @${it.origin}${it.violations.length ? ` !${it.violations.length}` : ""}`;
}

function rules_by_lhs(rules: rule[]): Map<string, rule[]> {
    const m = new Map<string, rule[]>();

    for (const r of rules) {
        const bucket = m.get(r.lhs);

        if (bucket) bucket.push(r);
        else m.set(r.lhs, [r]);
    }

    return m;
}

// Run the chart over [0, n) and return every completed `start` edge spanning the
// whole input. `by_lhs` lets the caller inject a synthetic start rule.
function chart_parse(c: ctx, by_lhs: Map<string, rule[]>, start: string, n: number): edge[] {
    const cols: column[] = Array.from({ length: n + 1 }, () => ({ items: new Map(), queue: [] }));

    const add = (col: number, it: item): void => {
        const existing = cols[col].items.get(it.key);

        // first time we see this key, or a strictly cheaper derivation of it: (re)enqueue.
        // violations only grow in relaxed mode, so this fixpoint terminates (counts are
        // bounded below by 0 and each replacement strictly decreases them).
        if (existing === undefined || it.violations.length < existing.violations.length) {
            cols[col].items.set(it.key, it);
            cols[col].queue.push(it);
        }
    };

    const seed = (sym: string, col: number): void => {
        for (const r of by_lhs.get(sym) ?? []) {
            add(col, make_item(r, 0, col, [], []));
        }
    };

    seed(start, 0);

    for (let i = 0; i <= n; i++) {
        const col = cols[i];

        // index-pointer queue: shift() is O(queue length) per pop, and completions
        // append to the queue while it drains
        for (let qh = 0; qh < col.queue.length; qh++) {
            const it = col.queue[qh];

            if (col.items.get(it.key) !== it) continue;

            if (it.dot < it.rule.rhs.length) {
                const sym = it.rule.rhs[it.dot];

                if (c.g.nonterminals.has(sym)) {
                    // PREDICT: dot-0 items have no children, so the prediction dedups to
                    // one per (rule, column) and left recursion cannot loop.
                    if (c.trace) {
                        const k = (by_lhs.get(sym) ?? []).length;
                        c.trace(k > 0
                            ? `col ${i}: predict <${sym}> (${k} rule${k > 1 ? "s" : ""})  for ${show_item(it)}`
                            : `col ${i}: predict <${sym}> — PREDICTION DEAD-ENDS (no rules)  for ${show_item(it)}`);
                    }

                    seed(sym, i);
                } else if (i < c.lex.length) {
                    // SCAN
                    let scanned = 0;

                    for (const li of c.lex[i]) {
                        if (li.cat !== sym) continue;

                        // A leaf carrying a morph_err contributes one violation
                        // to the edge; the chart's min-violations packing will
                        // prefer a clean leaf at the same position if one exists
                        const violations: violation[] = li.morph_err
                            ? [{
                                rule: "morph",
                                message: li.morph_err.message,
                                fix_strategies: [`literal:${li.morph_err.fix}`],
                                span: [i, i + 1],
                            }]
                            : [];

                        const leaf: edge = {
                            start: i,
                            end: i + 1,
                            tree: { kind: "leaf", sym, form: li.form, fs: li.feats, pos: i },
                            violations,
                        };

                        add(i + 1, advance(it, leaf));
                        scanned++;
                    }

                    if (c.trace) {
                        c.trace(scanned > 0
                            ? `col ${i}: scan <${sym}> ✓ (${scanned})`
                            : `col ${i}: scan <${sym}> ✗ — tokens here analyse as [${(c.lex[i] ?? []).map((l) => l.cat).join(", ") || "—"}]`);
                    }
                }
            } else {
                // COMPLETE: run the rule's feature equations and propagate to waiters.
                const me = mother_edge(c, it);

                if (me === null) {
                    c.trace?.(`col ${i}: complete <${it.rule.lhs}> [${it.rule.name}] BLOCKED by feature clash`);
                    continue; // strict hard-fail
                }

                c.trace?.(`col ${i}: complete <${it.rule.lhs}> [${it.rule.name}] spanning ${it.origin}–${i}`);

                it.edge = me;

                const origin = cols[it.origin];

                for (const w of origin.items.values()) {
                    if (w.dot < w.rule.rhs.length && w.rule.rhs[w.dot] === it.rule.lhs) {
                        add(i, advance(w, me));
                    }
                }
            }
        }
    }

    if (c.trace) {
        c.trace(`=== final chart (start <${start}>, ${n} token${n === 1 ? "" : "s"}) ===`);

        for (let col = 0; col <= n; col++) {
            c.trace(`column ${col}:`);
            for (const it of cols[col].items.values()) c.trace(`    ${show_item(it)}`);
        }
    }

    const out: edge[] = [];

    for (const it of cols[n].items.values()) {
        if (it.dot === it.rule.rhs.length && it.rule.lhs === start && it.origin === 0) {
            const me = it.edge ?? mother_edge(c, it);

            if (me !== null) out.push(me);
        }
    }

    return out;
}

function advance(it: item, child: edge): item {
    return make_item(it.rule, it.dot + 1, it.origin, [...it.kids, child], [...it.violations, ...child.violations]);
}

// Build the mother edge for a completed item: run the rule's equations (the only
// place the `relax` flag matters) and wrap the result as a node edge.
function mother_edge(c: ctx, it: item): edge | null {
    const applied = apply_equations(c, it.rule, it.kids, it.origin, it.kids.length ? it.kids[it.kids.length - 1].end : it.origin);

    if (applied === null) return null;

    return {
        start: it.origin,
        end: it.kids.length ? it.kids[it.kids.length - 1].end : it.origin,
        tree: {
            kind: "node",
            sym: it.rule.lhs,
            children: it.kids.map((k) => k.tree),
            fs: applied.lhs_fs,
            rule: it.rule.name,
        },
        violations: [...it.violations, ...applied.eq_violations],
    };
}

// The equation environment: the mother's feature structure plus one per daughter,
// addressed positionally by const_ref (so two same-category daughters stay
// distinct, unlike the old symbol-keyed map).
type eqenv = { mother: feature_struct; daughters: feature_struct[] };

function env_get(env: eqenv, ref: const_ref): feature_struct {
    return ref.kind === "mother" ? env.mother : env.daughters[ref.index];
}

function env_set(env: eqenv, ref: const_ref, val: feature_struct): void {
    if (ref.kind === "mother") env.mother = val;
    else env.daughters[ref.index] = val;
}

function resolve_term(env: eqenv, t: term): feature_struct | undefined {
    if (t.kind === "value") return atom(t.value);

    return get_path(env_get(env, t.path.ref), t.path.feats);
}

function write_back(env: eqenv, p: path, val: feature_struct): void {
    env_set(env, p.ref, set_path(env_get(env, p.ref), p.feats, val));
}

function apply_equations(
    c: ctx,
    r: rule,
    children: edge[],
    start: number,
    end: number,
): { lhs_fs: feature_struct; eq_violations: violation[] } | null {
    // The mother inherits the head daughter's structure when the rule has a head
    // (head percolation), else starts empty and is built from the equations.
    const env: eqenv = {
        mother: r.head !== null ? children[r.head].tree.fs : fs(),
        daughters: children.map((k) => k.tree.fs),
    };

    const eq_violations: violation[] = [];

    for (const eq of r.eqs) {
        const lv = resolve_term(env, { kind: "path", path: eq.left }) ?? fs();
        const rv = resolve_term(env, eq.right) ?? fs();
        const u = unify(lv, rv);

        if (u === null) {
            // tagged constraints relax (record a violation, keep going); untagged ones hard-fail
            if (eq.diag !== null && c.relax) {
                eq_violations.push(make_violation(r, eq, eq.diag, children, start, end));
                continue;
            }

            return null;
        }

        write_back(env, eq.left, u);

        if (eq.right.kind === "path") write_back(env, eq.right.path, u);
    }

    return { lhs_fs: env.mother, eq_violations };
}

function make_violation(r: rule, eq: equation, d: diag, children: edge[], start: number, end: number): violation {
    // highlight the right-hand constituent for a two-constituent constraint, else the left
    const ref = eq.right.kind === "path" ? eq.right.path.ref : eq.left.ref;
    const span: [number, number] = ref.kind === "daughter"
        ? [children[ref.index].start, children[ref.index].end]
        : [start, end];

    return { rule: r.name, message: d.message, fix_strategies: d.fixes, span };
}

export function full_parses(c: ctx, n: number): edge[] {
    return chart_parse(c, rules_by_lhs(c.g.rules), c.g.start, n);
}

export function match_sequence(c: ctx, syms: string[], n: number): edge[][] {
    const seq_rule: rule = { lhs: "__SEQ__", rhs: syms, eqs: [], name: `__SEQ__ -> ${syms.join(" ")}`, head: null };
    const by_lhs = rules_by_lhs([...c.g.rules, seq_rule]);

    // the completed __SEQ__ edge's children are exactly the matched constituents
    return chart_parse(c, by_lhs, "__SEQ__", n)
        .map((e) => (e.tree.kind === "node" ? collect_children(e) : []));
}

function collect_children(e: edge): edge[] {
    // reconstruct the child edges of a synthetic __SEQ__ node from its tree; the
    // spans are what analyze.ts reads, and each child tree already carries them
    if (e.tree.kind !== "node") return [];

    return e.tree.children.map((t) => child_edge(t));
}

function child_edge(t: tree): edge {
    const span = tree_span(t);

    return { start: span[0], end: span[1], tree: t, violations: [] };
}

function tree_span(t: tree): [number, number] {
    if (t.kind === "leaf") return [t.pos, t.pos + 1];

    const first = tree_span(t.children[0]);
    const last = tree_span(t.children[t.children.length - 1]);

    return [first[0], last[1]];
}
