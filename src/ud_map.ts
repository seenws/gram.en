// The translation layer between Universal Dependencies' universal tagset and each
// language fragment's own feature names. This table IS the audit's scope
// definition: a UD feature listed here is one the engine claims to model, so a
// value outside its mapping (e.g. Russian Case=Gen when the fragment models only
// nom/acc) marks the token as OUT OF COVERAGE -- skipped, not failed. A UD feature
// not listed at all is simply ignored (the engine never claimed to model it, so
// UD saying Aspect=Imp is no business of ours).
//
// Only the open-class content categories are audited (NOUN/VERB/ADJ/PRON): that is
// where the FST paradigms live and where agreement with gold actually validates a
// paradigm. Function words (DET/ADP/AUX/PART/CCONJ/...) are hand-listed closed
// classes whose UD<->engine label conventions diverge without testing any rule, so
// they are deliberately left out of the `upos` maps below and skipped.

import { type ud_token } from "./conllu.ts";

// For one UD feature: which engine feature it becomes, and the value translation.
// A UD value absent from `values` is out of the modeled domain (-> skip token).
type feat_spec = { feat: string; values: Record<string, string> };

type lang_ud = {
    upos: Record<string, string>; // UPOS -> engine category (audited POS only)
    feats: Record<string, feat_spec>; // UD feature -> engine feature + value map
};

const NUMBER: feat_spec = { feat: "num", values: { Sing: "sg", Plur: "pl" } };
const PERSON: feat_spec = { feat: "pers", values: { "1": "1", "2": "2", "3": "3" } };
const NOM_ACC: feat_spec = { feat: "case", values: { Nom: "nom", Acc: "acc" } };
const TENSE: feat_spec = { feat: "tense", values: { Pres: "pres", Past: "past" } };
const DEGREE: feat_spec = { feat: "degree", values: { Pos: "pos", Cmp: "comp", Sup: "sup" } };
const OPEN_POS = { NOUN: "N", VERB: "V", ADJ: "Adj", PRON: "Pron" };

export const UD_MAP: Record<string, lang_ud> = {
    en: {
        upos: OPEN_POS,
        feats: {
            Number: NUMBER,
            Person: PERSON,
            Case: NOM_ACC,
            Tense: TENSE,
            Degree: DEGREE,
            // only finite/infinitive are modeled; participles/gerunds -> skip
            VerbForm: { feat: "vform", values: { Fin: "fin", Inf: "bare" } },
        },
    },
    sv: {
        upos: OPEN_POS,
        feats: {
            Number: NUMBER,
            Case: NOM_ACC,
            Tense: TENSE,
            Degree: DEGREE,
            Gender: { feat: "gender", values: { Com: "utr", Neut: "neu" } },
            Definite: { feat: "def", values: { Def: "def", Ind: "indef" } },
            VerbForm: { feat: "vform", values: { Fin: "fin", Inf: "bare", Sup: "sup" } },
        },
    },
    ru: {
        upos: OPEN_POS,
        feats: {
            Number: NUMBER,
            Person: PERSON,
            Case: NOM_ACC, // genitive/dative/instrumental/locative -> out of coverage
            Tense: TENSE,
            Gender: { feat: "gender", values: { Masc: "masc", Fem: "fem", Neut: "neu" } },
            Animacy: { feat: "anim", values: { Anim: "anim", Inan: "inan" } },
            VerbForm: { feat: "vform", values: { Fin: "fin", Inf: "bare" } },
        },
    },
};

// What the engine should be able to produce for this token, or "skip" when the
// token falls outside the modeled fragment (unaudited POS, or a feature value the
// engine does not model).
export type expectation = { cat: string; want: Record<string, string> } | "skip";

export function expect_of(lang: string, tok: ud_token): expectation {
    const map = UD_MAP[lang];

    if (!map) return "skip";

    const cat = map.upos[tok.upos];

    if (cat === undefined) return "skip"; // not an audited category

    // Possessive pronouns/determiners: UD's Person/Number on a Poss=Yes form
    // describes the POSSESSOR ("mine" = Person=1), whereas the engine carries the
    // agreement features of the noun phrase the form heads ("mine is red" -> 3sg).
    // Those are different notions, so the token is outside the comparable fragment.
    if (tok.feats.Poss === "Yes") return "skip";

    const want: Record<string, string> = {};

    for (const [ud_feat, ud_val] of Object.entries(tok.feats)) {
        const spec = map.feats[ud_feat];

        if (spec === undefined) continue; // feature the engine doesn't model -> ignore

        const eng_val = spec.values[ud_val];

        if (eng_val === undefined) return "skip"; // modeled feature, value out of domain

        want[spec.feat] = eng_val;
    }

    return { cat, want };
}
