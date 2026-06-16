// This file is read at dev time only -- it never ships in the engine bundle, and
// the treebanks it parses live under the gitignored tools/ud/ (see scripts/ud-check.ts).

export type ud_token = {
    form: string;
    lemma: string;
    upos: string;
    feats: Record<string, string>; // FEATS column, "Key=Val|Key=Val" -> { Key: Val }
};

export type ud_sentence = { text: string; tokens: ud_token[] };

// The ten CoNLL-U columns, by position.
const ID = 0, FORM = 1, LEMMA = 2, UPOS = 3, FEATS = 5;

function parse_feats(col: string): Record<string, string> {
    if (col === "_") return {};

    const out: Record<string, string> = {};

    for (const pair of col.split("|")) {
        const eq = pair.indexOf("=");

        if (eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1);
    }

    return out;
}

export function parse_conllu(text: string): ud_sentence[] {
    const out: ud_sentence[] = [];
    let tokens: ud_token[] = [];
    let sent_text = "";

    const flush = () => {
        if (tokens.length > 0) out.push({ text: sent_text, tokens });

        tokens = [];
        sent_text = "";
    };

    for (const line of text.split(/\r?\n/)) {
        if (line === "") {
            flush();
            continue;
        }

        if (line.startsWith("#")) {
            const m = /^#\s*text\s*=\s*(.*)$/.exec(line);

            if (m) sent_text = m[1];

            continue;
        }

        const c = line.split("\t");
        const id = c[ID];

        // Skip multiword-token ranges (1-2) and empty nodes (1.1); only real tokens.
        if (id.includes("-") || id.includes(".")) continue;

        tokens.push({ form: c[FORM], lemma: c[LEMMA], upos: c[UPOS], feats: parse_feats(c[FEATS]) });
    }

    flush();

    return out;
}
