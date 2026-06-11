// Feature struct

export type feature_struct =
    | { kind: "atom"; val: string }
    | { kind: "fs"; feats: Map<string, feature_struct> };

export function atom(val: string): feature_struct {
    return { kind: "atom", val };
}

export function fs(entries?: Iterable<readonly [string, feature_struct]>): feature_struct {
    return { kind: "fs", feats: new Map(entries ?? []) };
}

export function unify(a: feature_struct, b: feature_struct): feature_struct | null {
    if (a.kind === "atom" && b.kind === "atom") {
        return a.val === b.val ? a : null;
    }

    if (a.kind === "fs" && b.kind === "fs") {
        const out = new Map<string, feature_struct>(a.feats);

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

    // an empty fs is unspecified, so it unifies down to the atom
    const structured = a.kind === "fs" ? a : (b as Extract<feature_struct, { kind: "fs" }>);
    const scalar = a.kind === "atom" ? a : b;

    return structured.feats.size === 0 ? scalar : null;
}

export function get_path(root: feature_struct, feats: readonly string[]): feature_struct | undefined {
    let cur: feature_struct = root;

    for (const f of feats) {
        if (cur.kind !== "fs") return undefined;

        const next = cur.feats.get(f);

        if (next === undefined) return undefined;

        cur = next;
    }

    return cur;
}

export function set_path(root: feature_struct, feats: readonly string[], val: feature_struct): feature_struct {
    if (feats.length === 0) return val;

    const base = root.kind === "fs" ? root : fs();
    const m = new Map(base.feats);
    const head = feats[0];
    const child = m.get(head) ?? fs();
    m.set(head, set_path(child, feats.slice(1), val));

    return { kind: "fs", feats: m };
}

// Sorted, order-stable serialization of a feature structure: structurally equal
// structures built by different paths get the same signature (show_fs walks Map
// insertion order, which doesn't). Used for chart-item packing and analysis
// dedup. Structures are immutable after construction, so signatures are
// memoised per object.
const sig_cache = new WeakMap<feature_struct, string>();

export function fs_sig(x: feature_struct): string {
    const hit = sig_cache.get(x);

    if (hit !== undefined) return hit;

    let sig: string;

    if (x.kind === "atom") {
        sig = x.val;
    } else {
        const parts = [...x.feats.entries()]
            .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
            .map(([k, v]) => `${k}:${fs_sig(v)}`);

        sig = `[${parts.join(",")}]`;
    }

    sig_cache.set(x, sig);

    return sig;
}

export function show_fs(x: feature_struct): string {
    if (x.kind === "atom") return x.val;

    const parts = [...x.feats.entries()].map(([k, v]) => `${k}=${show_fs(v)}`);

    return `[${parts.join(", ")}]`;
}
