// Token-level morphology audit against a Universal Dependencies treebank: the
// external, gold-sourced examiner.
//
// The audit is context-free (morph_analyze returns every reading of a surface),
// so it can only be held to what it claims. The bar, therefore, is conditional on
// category coverage: a token counts as "in coverage" only when the lexicon knows
// the surface AND the engine has at least one analysis in the SAME category UD
// assigns it; on those, one reading must agree with gold on every modeled feature.
// A surface the engine knows but only under a different category (UD's "that" =
// PRON vs the engine's Det; UD's "talks" = NOUN vs the engine's verb-only "talk")
// is a coverage gap, not a paradigm error -- counted as `pos_gap`, never failed.
// Out-of-scope POS, out-of-domain feature values, and unknown surfaces are likewise
// counted but never failed. Shared by scripts/ud-check.ts (report) and
// test/ud.test.ts (enforcement), the same split as corpus.ts.

import { type grammar, type lex_entry } from "./grammar.ts";
import { morph_analyze } from "./morph.ts";
import { get_path, show_fs } from "./featstruct.ts";
import { parse_conllu } from "./conllu.ts";
import { expect_of } from "./ud_map.ts";

export type mismatch = {
    form: string;
    upos: string;
    want: { cat: string; feats: Record<string, string> };
    got: string[]; // the engine analyses that were on offer, for triage
};

export type audit_result = {
    tokens: number; // real tokens seen (MWT ranges / empty nodes already excluded)
    skipped_scope: number; // unaudited POS, or a modeled feature with an out-of-domain value
    unknown_form: number; // audited POS but the surface is not in the lexicon
    pos_gap: number; // surface known, but the engine lacks an analysis in UD's category
    audited: number; // in coverage: surface known AND engine has UD's category
    agree: number;
    mismatches: mismatch[];
};

// A same-category analysis agrees with gold when every modeled feature is either
// unset (no claim -> compatible) or equal to the gold value.
function features_match(e: lex_entry, want: Record<string, string>): boolean {
    for (const [feat, val] of Object.entries(want)) {
        const got = get_path(e.feats, [feat]);

        if (got !== undefined && got.kind === "atom" && got.val !== val) return false;
    }

    return true;
}

export function run_audit(g: grammar, lang: string, treebank_text: string): audit_result {
    const r: audit_result = {
        tokens: 0, skipped_scope: 0, unknown_form: 0, pos_gap: 0, audited: 0, agree: 0, mismatches: [],
    };

    for (const sent of parse_conllu(treebank_text)) {
        for (const tok of sent.tokens) {
            r.tokens++;

            const exp = expect_of(lang, tok);

            if (exp === "skip") {
                r.skipped_scope++;
                continue;
            }

            const entries = morph_analyze(g, tok.form);

            if (entries.length === 0) {
                r.unknown_form++;
                continue;
            }

            // Hold the engine accountable only where it claims UD's category.
            const same_cat = entries.filter((e) => e.cat === exp.cat);

            if (same_cat.length === 0) {
                r.pos_gap++;
                continue;
            }

            r.audited++;

            if (same_cat.some((e) => features_match(e, exp.want))) {
                r.agree++;
            } else {
                r.mismatches.push({
                    form: tok.form,
                    upos: tok.upos,
                    want: { cat: exp.cat, feats: exp.want },
                    got: same_cat.map((e) => `${e.cat}${show_fs(e.feats)}`),
                });
            }
        }
    }

    return r;
}
