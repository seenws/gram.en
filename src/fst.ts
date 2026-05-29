// Finite-state transducer kernel for morphology

export const EPS = "";

export type arc = { in: string; out: string; to: number };

export type fst = {
    n_states: number;
    initial: number;
    finals: Set<number>;
    // Exit outputs produced when accepting at a final state. Only populated
    // by epsilon_eliminate: each ε-input path to an original final becomes
    // an exit output on the upstream state. One state may carry several
    // distinct exit strings (different ε paths to different finals), so
    // this is keyed by state to an array.
    final_outs?: Map<number, string[]>;
    out_arcs: arc[][];
};


export function eps(): fst {
    return {
        n_states: 1,
        initial: 0,
        finals: new Set([0]),
        out_arcs: [[]],
    };
}

// Identity transducer for a single symbol: in === out.
export function symbol(s: string): fst {
    if (s === EPS) return eps();

    return {
        n_states: 2,
        initial: 0,
        finals: new Set([1]),
        out_arcs: [[{ in: s, out: s, to: 1 }], []],
    };
}

// One-arc transducer mapping a single input symbol to a single output symbol.
export function pair(i: string, o: string): fst {
    return {
        n_states: 2,
        initial: 0,
        finals: new Set([1]),
        out_arcs: [[{ in: i, out: o, to: 1 }], []],
    };
}

function shifted(arcs: arc[][], shift: number): arc[][] {
    return arcs.map((row) => row.map((a) => ({ in: a.in, out: a.out, to: a.to + shift })));
}

export function concat(a: fst, b: fst): fst {
    const shift = a.n_states;
    const out_arcs: arc[][] = [];

    for (const row of a.out_arcs) out_arcs.push(row.map((x) => ({ ...x })));
    for (const row of shifted(b.out_arcs, shift)) out_arcs.push(row);

    for (const fin of a.finals) {
        out_arcs[fin].push({ in: EPS, out: EPS, to: b.initial + shift });
    }

    const finals = new Set<number>();

    for (const f of b.finals) finals.add(f + shift);

    return {
        n_states: a.n_states + b.n_states,
        initial: a.initial,
        finals,
        out_arcs,
    };
}

export function union(a: fst, b: fst): fst {
    const shift_a = 1;
    const shift_b = 1 + a.n_states;
    const out_arcs: arc[][] = [[]];

    for (const row of shifted(a.out_arcs, shift_a)) out_arcs.push(row);
    for (const row of shifted(b.out_arcs, shift_b)) out_arcs.push(row);

    out_arcs[0].push({ in: EPS, out: EPS, to: a.initial + shift_a });
    out_arcs[0].push({ in: EPS, out: EPS, to: b.initial + shift_b });

    const finals = new Set<number>();

    for (const f of a.finals) finals.add(f + shift_a);
    for (const f of b.finals) finals.add(f + shift_b);

    return {
        n_states: 1 + a.n_states + b.n_states,
        initial: 0,
        finals,
        out_arcs,
    };
}

// Zero-or-more: a new initial state that is also final loops back from each
// of `a`'s finals.
export function kleene(a: fst): fst {
    const shift = 1;
    const out_arcs: arc[][] = [[]];

    for (const row of shifted(a.out_arcs, shift)) out_arcs.push(row);

    out_arcs[0].push({ in: EPS, out: EPS, to: a.initial + shift });

    for (const fin of a.finals) {
        out_arcs[fin + shift].push({ in: EPS, out: EPS, to: 0 });
    }

    return {
        n_states: 1 + a.n_states,
        initial: 0,
        finals: new Set([0]),
        out_arcs,
    };
}

export function optional(a: fst): fst {
    return union(a, eps());
}

export function concat_many(fsts: fst[]): fst {
    if (fsts.length === 0) return eps();

    let acc = fsts[0];

    for (let i = 1; i < fsts.length; i++) acc = concat(acc, fsts[i]);

    return acc;
}

export function union_many(fsts: fst[]): fst {
    if (fsts.length === 0) {
        // Empty language: a single non-final state with no arcs.
        return { n_states: 1, initial: 0, finals: new Set(), out_arcs: [[]] };
    }

    let acc = fsts[0];

    for (let i = 1; i < fsts.length; i++) {
        acc = union(acc, fsts[i]);
    }

    return acc;
}


// State space is the cartesian product (a.state, b.state). Epsilons on the
// composition seam (a's output / b's input) are handled by allowing each
// machine to step independently when the other side is epsilon. This can
// produce spurious paths that nonetheless give correct symbol-sequence sets
// (apply_* dedupes), so a 3-way epsilon filter is omitted as future work.
export function compose(a: fst, b: fst): fst {
    const state_id = new Map<string, number>();
    const out_arcs: arc[][] = [];
    const finals = new Set<number>();
    const work: [number, number, number][] = [];
    const seen = new Set<string>();

    function get(as: number, bs: number): number {
        const k = `${as},${bs}`;
        let id = state_id.get(k);

        if (id === undefined) {
            id = state_id.size;
            state_id.set(k, id);
            out_arcs.push([]);

            if (a.finals.has(as) && b.finals.has(bs)) finals.add(id);
        }

        return id;
    }

    function enqueue(as: number, bs: number, id: number): void {
        const k = `${as},${bs}`;

        if (!seen.has(k)) {
            seen.add(k);
            work.push([as, bs, id]);
        }
    }

    const initial = get(a.initial, b.initial);
    enqueue(a.initial, b.initial, initial);

    while (work.length > 0) {
        const [as, bs, ns] = work.pop()!;

        for (const aa of a.out_arcs[as]) {
            if (aa.out !== EPS) {
                // A emits a real symbol; B must consume that symbol on its input side.
                for (const bb of b.out_arcs[bs]) {
                    if (bb.in === aa.out) {
                        const ns2 = get(aa.to, bb.to);
                        out_arcs[ns].push({ in: aa.in, out: bb.out, to: ns2 });
                        enqueue(aa.to, bb.to, ns2);
                    }
                }
            } else {
                // A emits epsilon; B stays.
                const ns2 = get(aa.to, bs);
                out_arcs[ns].push({ in: aa.in, out: EPS, to: ns2 });
                enqueue(aa.to, bs, ns2);
            }
        }

        for (const bb of b.out_arcs[bs]) {
            if (bb.in === EPS) {
                // B reads epsilon; A stays.
                const ns2 = get(as, bb.to);
                out_arcs[ns].push({ in: EPS, out: bb.out, to: ns2 });
                enqueue(as, bb.to, ns2);
            }
        }
    }

    return {
        n_states: state_id.size,
        initial,
        finals,
        out_arcs,
    };
}


// Swap in/out on every arc. Two complications when the original was
// epsilon_eliminate'd:
//   - Arc `out` strings may carry multiple symbols. On inversion those land
//     on the input side, where apply_down consumes one symbol per arc, so a
//     multi-symbol input is expanded into a chain (the output is emitted on
//     the first arc; the rest of the chain emits ε).
//   - `final_outs` were exit outputs on the original output tape; they
//     become required input on the inverted side, so they're materialised
//     as a chain of input arcs from the state to a fresh final.
export function invert(f: fst): fst {
    const out_arcs: arc[][] = Array.from({ length: f.n_states }, () => []);
    const finals = new Set(f.finals);
    let n = f.n_states;

    const fresh = (): number => {
        out_arcs.push([]);
        return n++;
    };

    for (let s = 0; s < f.n_states; s++) {
        for (const a of f.out_arcs[s]) {
            const inv_in = a.out;
            const inv_out = a.in;

            if (inv_in === EPS) {
                out_arcs[s].push({ in: EPS, out: inv_out, to: a.to });
                continue;
            }

            const tokens = tokenize_symbols(inv_in);

            if (tokens.length <= 1) {
                out_arcs[s].push({ in: inv_in, out: inv_out, to: a.to });
                continue;
            }

            let cur = s;

            for (let i = 0; i < tokens.length; i++) {
                const is_last = i === tokens.length - 1;
                const next = is_last ? a.to : fresh();
                const out_str = i === 0 ? inv_out : EPS;
                out_arcs[cur].push({ in: tokens[i], out: out_str, to: next });
                cur = next;
            }
        }
    }

    if (f.final_outs && f.final_outs.size > 0) {
        for (const [s, exits] of f.final_outs) {
            for (const exit of exits) {
                const tokens = tokenize_symbols(exit);

                if (tokens.length === 0) {
                    finals.add(s);
                    continue;
                }

                let cur = s;

                for (const t of tokens) {
                    const next = fresh();
                    out_arcs[cur].push({ in: t, out: EPS, to: next });
                    cur = next;
                }

                finals.add(cur);
            }
        }
    }

    return { n_states: n, initial: f.initial, finals, out_arcs };
}


// Walks `f` consuming input symbols one per non-ε-input arc; ε-input arcs
// are still followed in-place for FSTs that haven't been epsilon_eliminate'd,
// but the in-path (state, position) memo prevents non-terminating cycles.
// Arc outputs are accumulated as strings (one arc may carry multiple output
// symbols after ε-elimination); the final list is re-tokenised so callers
// always see a symbol-per-element sequence regardless of how outputs were
// folded into arcs.
export function apply_down(f: fst, input: string | string[]): string[][] {
    const syms = typeof input === "string" ? [...input] : input;
    const results: string[][] = [];
    const path = new Set<string>();

    function visit(state: number, pos: number, acc: string[]): void {
        const key = `${state}:${pos}`;

        if (path.has(key)) return;

        path.add(key);

        if (pos === syms.length) {
            if (f.finals.has(state)) {
                results.push(tokenize_symbols(acc.join("")));
            }

            const exits = f.final_outs?.get(state);

            if (exits) {
                const prefix = acc.join("");

                for (const exit of exits) results.push(tokenize_symbols(prefix + exit));
            }
        }

        for (const arc of f.out_arcs[state]) {
            if (arc.in === EPS) {
                acc.push(arc.out);
                visit(arc.to, pos, acc);
                acc.pop();
            } else if (pos < syms.length && arc.in === syms[pos]) {
                acc.push(arc.out);
                visit(arc.to, pos + 1, acc);
                acc.pop();
            }
        }

        path.delete(key);
    }

    visit(f.initial, 0, []);

    return dedupe(results);
}


// Construct an equivalent FST with no ε-input arcs.
//
// For each state s, the ε-input closure is computed by BFS: a Map<t, prefix>
// listing every t reachable from s via ε-input arcs, with the concatenated
// output string along that path. (First-found path wins; ε-input cycles
// terminate because revisits are skipped.) Then for every non-ε-input arc
// `t --x:y--> u`, a new arc `s --x:(prefix · y)--> u` is added. The new arc's
// output may be a multi-symbol string -- that's fine, apply_down's final
// re-tokenisation puts it back into one-symbol-per-element form.
//
// A state s is final iff its ε-input closure contains an original final t;
// if the path to t carries non-empty output, that string lands in
// `final_outs[s]`. Output ε-arcs (x:ε for x ∈ Σ) are left untouched.
//
// After elimination apply_down's depth is bounded by |input|, since every
// arc consumes one input symbol. The path-visited heuristic in apply_down
// stays as a safety net for callers that pass non-eliminated FSTs.
export function epsilon_eliminate(f: fst): fst {
    const n = f.n_states;
    const closure: Map<number, string>[] = [];

    for (let s = 0; s < n; s++) {
        const reach = new Map<number, string>();
        reach.set(s, "");
        const queue: number[] = [s];

        while (queue.length > 0) {
            const cur = queue.shift()!;
            const cur_out = reach.get(cur)!;

            for (const a of f.out_arcs[cur]) {
                if (a.in !== EPS) continue;
                if (reach.has(a.to)) continue;

                reach.set(a.to, cur_out + a.out);
                queue.push(a.to);
            }
        }

        closure.push(reach);
    }

    const new_out_arcs: arc[][] = [];

    for (let s = 0; s < n; s++) new_out_arcs.push([]);

    const new_finals = new Set<number>();
    const new_final_outs = new Map<number, string[]>();

    for (let s = 0; s < n; s++) {
        const seen_exits = new Set<string>();

        for (const [t, prefix] of closure[s]) {
            for (const a of f.out_arcs[t]) {
                if (a.in === EPS) continue;

                new_out_arcs[s].push({ in: a.in, out: prefix + a.out, to: a.to });
            }

            if (f.finals.has(t)) {
                if (prefix === "") {
                    new_finals.add(s);
                } else if (!seen_exits.has(prefix)) {
                    seen_exits.add(prefix);
                    const list = new_final_outs.get(s) ?? [];
                    list.push(prefix);
                    new_final_outs.set(s, list);
                }
            }
        }
    }

    return {
        n_states: n,
        initial: f.initial,
        finals: new_finals,
        final_outs: new_final_outs.size > 0 ? new_final_outs : undefined,
        out_arcs: new_out_arcs,
    };
}

export function apply_up(f: fst, input: string | string[]): string[][] {
    return apply_down(invert(f), input);
}

function dedupe(rs: string[][]): string[][] {
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


// Surface forms tokenise as single characters. Lexical forms include
// multi-char tags written `+TAG` (e.g. +N, +Pl); the helper below splits
// such tags off as single symbols so apply_up("dog+N+Pl") sees the same
// symbol sequence the compiler emits.
export function tokenize_symbols(s: string): string[] {
    const out: string[] = [];
    const re = /\+[A-Za-z0-9_]+|./gsu;
    let m: RegExpExecArray | null;

    while ((m = re.exec(s)) !== null) out.push(m[0]);

    return out;
}

export function show_symbols(syms: string[]): string {
    return syms.join("");
}
