// Morphology facade used by the parser and the analyzer

import { type grammar, type lex_entry } from "./grammar.ts";
import { apply_down } from "./fst.ts";
import { decode_lexical } from "./morph_lexc.ts";

export function morph_analyze(g: grammar, surface: string): lex_entry[] {
    const key = surface.toLowerCase();
    const explicit = g.lexicon.get(key);

    if (explicit && explicit.length > 0) return explicit;

    if (g.morph_fst) {
        const out: lex_entry[] = [];
        const seen = new Set<string>();

        for (const tag_seq of apply_down(g.morph_fst, key)) {
            for (const d of decode_lexical(g.morph, tag_seq)) {
                // tag-shared paradigm entries (clean and *ERR/*FIX) decode to
                // both analyses for any matching tag sequence; narrow by the
                // actual surface so the error stays attached to its surface
                if (d.form !== key) continue;

                const k = `${d.cat}|${d.form}|${tag_seq.join(" ")}|${d.error?.message ?? ""}`;

                if (seen.has(k)) continue;

                seen.add(k);
                out.push({ form: d.form, cat: d.cat, feats: d.feats, morph_err: d.error });
            }
        }

        return out;
    }

    return [];
}
