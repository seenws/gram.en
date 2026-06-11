// Continuation-lexicon compiler (LEXC-style)

import { type arc, type fst, EPS, tokenize_symbols, epsilon_eliminate } from "./fst.ts";
import { type feature_struct, fs, atom, set_path, get_path, unify } from "./featstruct.ts";

export type root_entry = {
    surface: string;       // stem characters on the surface tape
    paradigm: string;      // name of continuation paradigm to follow
    feats: feature_struct; // root-level features (lemma, irregular tags, ...)
    // Per-stem overrides for paradigm entries: key is the lexical tag, value
    // replaces that entry's surface and merges its features (override wins).
    overrides: Map<string, paradigm_entry>;
};

export type morph_diag = { message: string; fix: string };

export type paradigm_entry = {
    tag: string;           // multi-symbol tag string emitted on the lexical tape (e.g. "+N+Pl")
    surface: string;       // surface suffix to consume on the surface tape (may be empty)
    feats: feature_struct; // form-level features (num, pers, ...)
    // Error-tagged entries describe wrong-but-anticipated surfaces. Multiple
    // entries in a paradigm may share a tag; the FST encodes each as its own
    // sub-path, decode_lexical returns both, and morph_analyze narrows by
    // the actual surface form.
    error?: morph_diag;
};

export type paradigm = {
    name: string;
    cat: string;           // every form built from this paradigm has this category
    entries: paradigm_entry[];
};

export type morph_data = {
    roots: root_entry[];
    paradigms: Map<string, paradigm>;
};

export type decoded = {
    lemma: string;
    cat: string;
    feats: feature_struct;
    form: string;          // the surface form (stem + surface suffix)
    error?: morph_diag;    // copied from the paradigm entry if it was error-tagged
};


// Walk overlay; for every atomic leaf, set that path in base. Override wins
// on conflicts; paths the overlay doesn't touch survive unchanged.
function merge_with_override(base: feature_struct, overlay: feature_struct): feature_struct {
    if (overlay.kind === "atom") return overlay;

    let out = base;
    const walk = (f: feature_struct, prefix: string[]): void => {
        if (f.kind === "atom") {
            out = set_path(out, prefix, f);
            return;
        }

        for (const [k, v] of f.feats.entries()) walk(v, [...prefix, k]);
    };
    walk(overlay, []);

    return out;
}

// The paradigm entries that actually apply for this stem: each base entry
// either survives unchanged or has its surface replaced and features merged
// from a matching override. Error-tagged entries are not overridable -- an
// override is a per-stem replacement for the canonical surface, not for a
// known malformation. The override must therefore name a tag with at least
// one clean entry in the paradigm.
export function effective_entries(r: root_entry, p: paradigm): paradigm_entry[] {
    if (r.overrides.size === 0) return p.entries;

    const clean_tags = new Set(p.entries.filter((e) => e.error === undefined).map((e) => e.tag));

    for (const ov_tag of r.overrides.keys()) {
        if (!clean_tags.has(ov_tag)) {
            throw new Error(`lex: stem '${r.surface}' overrides tag '${ov_tag}' which has no clean entry in paradigm '${r.paradigm}'`);
        }
    }

    return p.entries.map((e) => {
        if (e.error !== undefined) return e;

        const ov = r.overrides.get(e.tag);

        if (!ov) return e;

        return { tag: e.tag, surface: ov.surface, feats: merge_with_override(e.feats, ov.feats) };
    });
}


// Build the lexicon FST: surface form -> lexical string "stem-chars + tag-syms".
//
// The structure is a character trie of stems per paradigm, sharing prefixes,
// connected by ε-arcs to per-paradigm continuation sub-FSTs that emit the
// paradigm's tags and consume its surface suffixes. Roots without overrides
// all share their paradigm's single base continuation, so the state count is
// O(distinct stem prefixes) + O(paradigms × forms) -- an order of magnitude
// below the per-(root × form) sub-path layout this replaced.
//
// Roots with overrides get their own continuation built from
// effective_entries(r, p); ε-elimination at the end folds away the seam ε-arcs.
export function compile_morph_fst(data: morph_data): fst {
    const out_arcs: arc[][] = [];
    const new_state = (): number => {
        out_arcs.push([]);

        return out_arcs.length - 1;
    };

    const top_initial = new_state();
    const top_finals = new Set<number>();

    const by_paradigm = new Map<string, root_entry[]>();

    for (const r of data.roots) {
        if (!data.paradigms.has(r.paradigm)) {
            throw new Error(`lex: stem '${r.surface}' refers to unknown paradigm '${r.paradigm}'`);
        }

        const list = by_paradigm.get(r.paradigm) ?? [];
        list.push(r);
        by_paradigm.set(r.paradigm, list);
    }

    // Linear continuation: one initial state, one branch per entry, each branch
    // emits the entry's tag symbols on the output then consumes its surface
    // suffix on the input. Returns (initial, list-of-final-states).
    const build_continuation = (entries: paradigm_entry[]): [number, number[]] => {
        const cont_initial = new_state();
        const finals: number[] = [];

        for (const e of entries) {
            let cur = cont_initial;

            for (const t of tokenize_symbols(e.tag)) {
                const next = new_state();
                out_arcs[cur].push({ in: EPS, out: t, to: next });
                cur = next;
            }

            for (const c of e.surface) {
                const next = new_state();
                out_arcs[cur].push({ in: c, out: EPS, to: next });
                cur = next;
            }

            finals.push(cur);
        }

        return [cont_initial, finals];
    };

    type trie_node = { state: number; children: Map<string, trie_node>; roots: root_entry[] };

    for (const [pname, roots] of by_paradigm) {
        const p = data.paradigms.get(pname)!;

        const [base_cont_initial, base_cont_finals] = build_continuation(p.entries);
        for (const f of base_cont_finals) top_finals.add(f);

        const root_cont: Map<root_entry, number> = new Map();

        for (const r of roots) {
            if (r.overrides.size === 0) continue;

            const [init, finals] = build_continuation(effective_entries(r, p));
            root_cont.set(r, init);
            for (const f of finals) top_finals.add(f);
        }

        const trie_root: trie_node = { state: new_state(), children: new Map(), roots: [] };
        out_arcs[top_initial].push({ in: EPS, out: EPS, to: trie_root.state });

        for (const r of roots) {
            let cur = trie_root;

            for (const c of r.surface) {
                let child = cur.children.get(c);

                if (!child) {
                    const child_state = new_state();
                    out_arcs[cur.state].push({ in: c, out: c, to: child_state });
                    child = { state: child_state, children: new Map(), roots: [] };
                    cur.children.set(c, child);
                }

                cur = child;
            }

            cur.roots.push(r);
        }

        const stack: trie_node[] = [trie_root];

        while (stack.length > 0) {
            const node = stack.pop()!;

            for (const r of node.roots) {
                const cont_init = root_cont.get(r) ?? base_cont_initial;
                out_arcs[node.state].push({ in: EPS, out: EPS, to: cont_init });
            }

            for (const child of node.children.values()) stack.push(child);
        }
    }

    return epsilon_eliminate({
        n_states: out_arcs.length,
        initial: top_initial,
        finals: top_finals,
        out_arcs,
    });
}


// Roots grouped by their exact surface string, so decode_lexical can look up
// the stem by prefix instead of scanning every root. Memoised per morph_data
// (which is immutable after parsing) so the O(roots) build happens once, not
// once per analysed token -- the previous per-token scan made morph_analyze
// accidentally O(lexicon size).
const root_index_cache = new WeakMap<morph_data, Map<string, root_entry[]>>();

function root_index(data: morph_data): Map<string, root_entry[]> {
    let idx = root_index_cache.get(data);

    if (idx === undefined) {
        idx = new Map();

        for (const r of data.roots) {
            const bucket = idx.get(r.surface);

            if (bucket) bucket.push(r);
            else idx.set(r.surface, [r]);
        }

        root_index_cache.set(data, idx);
    }

    return idx;
}

// Given a lexical-side symbol sequence (the apply_down output), find every
// (root, paradigm-entry) that explains it and return a decoded analysis.
//
// The upper tape is the stem's characters (one symbol each) followed by the
// tag symbols, and a root is identified by its surface being a prefix of that
// sequence. We walk the prefixes of tag_seq and look each one up in the root
// index: the prefix is built by concatenating symbols (so multi-code-unit
// characters stay consistent with how the trie emitted them), and any root
// whose surface equals that prefix consumes exactly that many symbols, leaving
// the remainder as the tag to match. This is O(stem length) lookups rather
// than O(number of roots). Overlapping stems (e.g. "do" and "dog") are both
// found, at their respective prefix lengths.
export function decode_lexical(data: morph_data, tag_seq: readonly string[]): decoded[] {
    const out: decoded[] = [];
    const index = root_index(data);

    let prefix = "";

    for (let len = 1; len <= tag_seq.length; len++) {
        prefix += tag_seq[len - 1];

        const roots = index.get(prefix);

        if (roots === undefined) continue;

        const rest = tag_seq.slice(len).join("");

        for (const r of roots) {
            const p = data.paradigms.get(r.paradigm);

            if (!p) continue;

            for (const e of effective_entries(r, p)) {
                if (e.tag !== rest) continue;

                const merged = unify(r.feats, e.feats);

                if (merged === null) continue;

                const lemma = lemma_of(merged, r.surface);
                out.push({ lemma, cat: p.cat, feats: merged, form: r.surface + e.surface, error: e.error });
            }
        }
    }

    return out;
}

function lemma_of(feats: feature_struct, fallback: string): string {
    const l = get_path(feats, ["lemma"]);

    return l && l.kind === "atom" ? l.val : fallback;
}


//   %lex Root
//       <stem> : <paradigm> [<feature>...]
//       ...
//
//   %lex <paradigm> : <cat>
//       <tag> : [<surface>] [<feature>...]
//       ...
//
// Features use the same `<path>=value` syntax as lexicon entries. An entry
// line whose body starts with `:` has an empty surface suffix (singular,
// uninflected). `0` is accepted as the explicit empty literal too.
export class lexc_error extends Error {
    constructor(line: number, msg: string) {
        super(`%lex line ${line + 1}: ${msg}`);
        this.name = "lexc_error";
    }
}

// Input tokens are lowercased before morphology lookup (see morph_analyze), so
// a stem or suffix containing uppercase can never match anything. Catch the
// dead entry at load time instead of letting it silently never fire.
function check_lowercase(s: string, what: string, ln: number): void {
    if (s !== s.toLowerCase()) {
        throw new lexc_error(ln, `${what} '${s}' contains uppercase; input is lowercased before matching, write it in lowercase`);
    }
}

const FEATURE_RE = /<([^>]*)>\s*=\s*(\S+)/g;

function parse_features(text: string): feature_struct {
    let f = fs();
    let m: RegExpExecArray | null;
    FEATURE_RE.lastIndex = 0;

    while ((m = FEATURE_RE.exec(text)) !== null) {
        const segments = m[1].trim().split(/\s+/).filter(Boolean);
        f = set_path(f, segments, atom(m[2]));
    }

    return f;
}

// strip every <...>=val token from a line, leaving the non-feature part
function strip_features(text: string): string {
    return text.replace(/<[^>]*>\s*=\s*\S+/g, "").trim();
}

// *ERR "message" and *FIX <token> mark an anticipated-wrong paradigm entry.
// Both must appear together; one without the other is half a feature.
// Stripping happens before feature parsing so a `<...>=...` inside the
// quoted message can't be mis-read as a feature.
const ERR_RE = /\*ERR\s+"([^"]*)"/;
const FIX_RE = /\*FIX\s+(\S+)/;

function parse_error_markers(text: string, ln: number): { rest: string; error: morph_diag | undefined } {
    const err_m = text.match(ERR_RE);
    const fix_m = text.match(FIX_RE);

    if (!err_m && !fix_m) return { rest: text, error: undefined };

    if (!err_m) throw new lexc_error(ln, `*FIX without *ERR: ${text.trim()}`);
    if (!fix_m) throw new lexc_error(ln, `*ERR without *FIX: ${text.trim()}`);

    return {
        rest: text.replace(ERR_RE, "").replace(FIX_RE, ""),
        error: { message: err_m[1], fix: fix_m[1] },
    };
}

export function parse_morph_data(text: string): morph_data {
    const roots: root_entry[] = [];
    const paradigms = new Map<string, paradigm>();
    const lines = text.split(/\r?\n/);

    type cursor =
        | { kind: "root"; root_indent: number | null; last_root: root_entry | null }
        | { kind: "paradigm"; p: paradigm }
        | null;

    let cur: cursor = null;

    for (let ln = 0; ln < lines.length; ln++) {
        const raw = lines[ln];
        const body = strip_comment(raw);
        const trimmed = body.trim();

        if (trimmed.length === 0) continue;

        const indent = leading_ws(body);

        if (indent === 0) {
            if (!trimmed.startsWith("%lex")) throw new lexc_error(ln, `expected '%lex', got: ${trimmed}`);

            const head = trimmed.slice(4).trim();
            // header forms:  "Root"   OR   "<name> : <cat>"
            const ci = head.indexOf(":");

            if (head === "Root") {
                cur = { kind: "root", root_indent: null, last_root: null };
            } else if (ci > 0) {
                const name = head.slice(0, ci).trim();
                const cat = head.slice(ci + 1).trim();

                if (!name || !cat) throw new lexc_error(ln, `malformed paradigm header: ${head}`);

                const p: paradigm = { name, cat, entries: [] };
                paradigms.set(name, p);
                cur = { kind: "paradigm", p };
            } else {
                throw new lexc_error(ln, `paradigm header needs ': <cat>': ${head}`);
            }

            continue;
        }

        if (cur === null) throw new lexc_error(ln, `entry without a preceding %lex header: ${trimmed}`);

        // entry forms (split on first ':'):
        //   Root        :  <stem> : <paradigm> [<feature>...]
        //   Root entry override (deeper indent under a root):
        //                  <tag>  : [<surface>] [<feature>...]
        //   paradigm    :  <tag>  : [<surface>] [<feature>...]
        const ci = trimmed.indexOf(":");

        if (ci < 0) throw new lexc_error(ln, `entry missing ':': ${trimmed}`);

        const head_str = trimmed.slice(0, ci).trim();
        const rest_raw = trimmed.slice(ci + 1);
        // strip *ERR/*FIX first so a quoted message can't be mistaken for a feature
        const { rest: rest_no_err, error } = parse_error_markers(rest_raw, ln);
        const feats = parse_features(rest_no_err);
        const naked = strip_features(rest_no_err);

        if (cur.kind === "root") {
            const is_override = cur.root_indent !== null && indent > cur.root_indent;

            if (is_override) {
                if (cur.last_root === null) {
                    throw new lexc_error(ln, `override without a preceding root entry: ${trimmed}`);
                }

                if (error !== undefined) {
                    throw new lexc_error(ln, `overrides cannot carry *ERR/*FIX: ${trimmed}`);
                }

                const surface = naked === "0" ? "" : naked;

                check_lowercase(surface, "override surface", ln);
                cur.last_root.overrides.set(head_str, { tag: head_str, surface, feats });
            } else {
                if (error !== undefined) {
                    throw new lexc_error(ln, `root entries cannot carry *ERR/*FIX: ${trimmed}`);
                }

                // naked is the paradigm name
                const paradigm_name = naked.trim();

                if (!paradigm_name) throw new lexc_error(ln, `root entry missing paradigm name: ${trimmed}`);

                check_lowercase(head_str, "stem", ln);

                const r: root_entry = {
                    surface: head_str,
                    paradigm: paradigm_name,
                    feats,
                    overrides: new Map(),
                };
                roots.push(r);

                if (cur.root_indent === null) cur.root_indent = indent;

                cur.last_root = r;
            }
        } else {
            // naked is the surface suffix (possibly empty or '0')
            const surface = naked === "0" ? "" : naked;

            check_lowercase(surface, "surface suffix", ln);
            cur.p.entries.push({ tag: head_str, surface, feats, error });
        }
    }

    return { roots, paradigms };
}

function leading_ws(line: string): number {
    let i = 0;

    while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;

    return i;
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
