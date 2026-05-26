// Feature structures and unification.
//
// Values are atomic for this slice (no disjunction/sets). A feature structure is
// either an atom or a map from feature name to a sub-structure. Unification is
// immutable and recursive; an absent feature unifies with anything, which is how
// underspecification is encoded (notes section 5, section 11). True reentrancy
// (shared substructure across distinct paths) is not modelled here -- atomic
// single-level features do not need it; revisit with union-find later.

export type FS =
    | { kind: "atom"; val: string }
    | { kind: "fs"; feats: Map<string, FS> };

export function atom(val: string): FS {
    return { kind: "atom", val };
}

export function fs(entries?: Iterable<readonly [string, FS]>): FS {
    return { kind: "fs", feats: new Map(entries ?? []) };
}

// Unify a and b, returning the merged structure or null on conflict.
export function unify(a: FS, b: FS): FS | null {
    if (a.kind === "atom" && b.kind === "atom") {
        return a.val === b.val ? a : null;
    }
    if (a.kind === "fs" && b.kind === "fs") {
        const out = new Map<string, FS>(a.feats);
        for (const [k, vb] of b.feats) {
            const va = out.get(k);
            if (va === undefined) {
                out.set(k, vb);
            } else {
                const u = unify(va, vb);
                if (u === null) return null;
                out.set(k, u);
            }
        }
        return { kind: "fs", feats: out };
    }
    // atom vs fs: compatible only if the fs side is empty (fully unspecified).
    const structured = a.kind === "fs" ? a : (b as Extract<FS, { kind: "fs" }>);
    const scalar = a.kind === "atom" ? a : b;
    return structured.feats.size === 0 ? scalar : null;
}

// Navigate a path of feature names; undefined if any step is missing.
export function getPath(root: FS, feats: readonly string[]): FS | undefined {
    let cur: FS = root;
    for (const f of feats) {
        if (cur.kind !== "fs") return undefined;
        const next = cur.feats.get(f);
        if (next === undefined) return undefined;
        cur = next;
    }
    return cur;
}

// Return a copy of root with the given path set to val (immutable).
export function setPath(root: FS, feats: readonly string[], val: FS): FS {
    if (feats.length === 0) return val;
    const base = root.kind === "fs" ? root : fs();
    const m = new Map(base.feats);
    const head = feats[0];
    const child = m.get(head) ?? fs();
    m.set(head, setPath(child, feats.slice(1), val));
    return { kind: "fs", feats: m };
}

export function showFS(x: FS): string {
    if (x.kind === "atom") return x.val;
    const parts = [...x.feats.entries()].map(([k, v]) => `${k}=${showFS(v)}`);
    return `[${parts.join(", ")}]`;
}
