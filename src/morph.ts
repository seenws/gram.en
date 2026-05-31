// Morphology facade used by the parser and the analyzer

import { type grammar, type lex_entry } from "./grammar.ts";
import { apply_down, show_symbols } from "./fst.ts";
import { apply_cascade_up } from "./morph_rules.ts";
import { decode_lexical } from "./morph_lexc.ts";

export function morph_analyze(g: grammar, surface: string): lex_entry[] {
    const key = surface.toLowerCase();
    const explicit = g.lexicon.get(key);

    if (explicit && explicit.length > 0) return explicit;

    if (g.morph_fst) {
        const out: lex_entry[] = [];
        const seen = new Set<string>();

        // Run the rewrite cascade upward to recover the underlying strings the
        // lexicon recognises (e.g. "chased" -> "chaseed"). With no %rule the
        // cascade is empty, so the only candidate is the surface itself and this
        // reduces to the plain apply_down(fst, surface) lookup.
        //
        // The cascade always includes identity, so the raw underlying form
        // ("chaseed") also resolves -- a residual under-rejection. It is a
        // consequence of optional (vs. obligatory) replace, not of the lexicon's
        // surface-literal tape: a morpheme-boundary symbol does not close it
        // (measured), and inserting one would make analysis ~5x slower, so the
        // tape stays boundary-free. The wart only ever fails to flag a non-word,
        // never mis-flags a real one.
        for (const cand of apply_cascade_up(g.morph_cascade, key)) {
            const cand_str = show_symbols(cand);

            for (const tag_seq of apply_down(g.morph_fst, cand)) {
                for (const d of decode_lexical(g.morph, tag_seq)) {
                    // tag-shared paradigm entries (clean and *ERR/*FIX) decode to
                    // both analyses; narrow by the underlying candidate that the
                    // lexicon actually matched so the error stays on its surface.
                    if (d.form !== cand_str) continue;

                    const k = `${d.cat}|${tag_seq.join(" ")}|${d.error?.message ?? ""}`;

                    if (seen.has(k)) continue;

                    seen.add(k);
                    // The reported form is the true input surface, not the
                    // underlying candidate the lexicon matched.
                    out.push({ form: key, cat: d.cat, feats: d.feats, morph_err: d.error });
                }
            }
        }

        return out;
    }

    return [];
}
