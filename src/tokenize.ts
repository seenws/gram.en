export type token = { text: string; start: number; end: number };

const ALNUM = /[\p{L}\p{N}]/u;

// Contraction clitics, longest first so "n't" beats a hypothetical "'t" suffix.
// For "n't" the split lands one character before the apostrophe (do|n't);
// for the others it lands on the apostrophe (I|'m).
const CONTRACTION_SUFFIXES = ["n't", "'re", "'ve", "'ll", "'m", "'d", "'s"];

function split_contractions(text: string, start: number, end: number): token[] {
    const lower = text.slice(start, end).toLowerCase();

    for (const suffix of CONTRACTION_SUFFIXES) {
        if (lower.length > suffix.length && lower.endsWith(suffix)) {
            const split = end - suffix.length;

            return [
                { text: text.slice(start, split), start, end: split },
                { text: text.slice(split, end), start: split, end },
            ];
        }
    }

    return [{ text: text.slice(start, end), start, end }];
}

export function tokenize_spans(text: string): token[] {
    const out: token[] = [];
    const re = /\S+/g;
    let m: RegExpExecArray | null;

    while ((m = re.exec(text)) !== null) {
        let s = m.index;
        let e = m.index + m[0].length;

        while (s < e && !ALNUM.test(text[s])) s++;
        while (e > s && !ALNUM.test(text[e - 1])) e--;

        if (e > s) {
            for (const tok of split_contractions(text, s, e)) out.push(tok);
        }
    }

    return out;
}

export function tokenize(text: string): string[] {
    return tokenize_spans(text).map((t) => t.text);
}
