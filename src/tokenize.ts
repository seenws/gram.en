export type token = { text: string; start: number; end: number };

// A tokenizer turns a raw sentence into surface tokens with source spans. Each
// language picks one via the `%tokenizer` directive (see build_tokenizer); the
// default is whitespace splitting, configurable with the clitics it should peel off.
export type tokenizer = (sentence: string) => token[];

const ALNUM = /[\p{L}\p{N}]/u;

// Peel a trailing clitic off [start, end) if the span ends with one (clitics are
// pre-sorted longest-first so e.g. "n't" beats a hypothetical "'t"). For "n't" the
// split lands one char before the apostrophe (do|n't); for "'m" it lands on the
// apostrophe (I|'m). Recognition is case-insensitive; the head keeps its case.
function split_clitics(text: string, start: number, end: number, clitics: string[]): token[] {
    const lower = text.slice(start, end).toLowerCase();

    for (const suffix of clitics) {
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

function whitespace_spans(text: string, clitics: string[]): token[] {
    const out: token[] = [];
    const re = /\S+/g;
    let m: RegExpExecArray | null;

    while ((m = re.exec(text)) !== null) {
        let s = m.index;
        let e = m.index + m[0].length;

        while (s < e && !ALNUM.test(text[s])) s++;
        while (e > s && !ALNUM.test(text[e - 1])) e--;

        if (e > s) {
            for (const tok of split_clitics(text, s, e, clitics)) out.push(tok);
        }
    }

    return out;
}

// Whitespace tokenizer, optionally peeling off the given clitic suffixes. With no
// clitics it is a plain whitespace splitter (Swedish, Russian); English supplies its
// contraction suffixes via `%clitic`. The Unicode-aware ALNUM class already covers
// accented Latin (å/ä/ö) and Cyrillic, so no per-language alphabet is needed.
export function whitespace_tokenizer(clitics: string[] = []): tokenizer {
    const sorted = [...clitics].sort((a, b) => b.length - a.length); // longest-first
    return (sentence) => whitespace_spans(sentence, sorted);
}

// Registry mapping a `%tokenizer <name>` to its implementation. `longest-match`
// (greedy dictionary segmentation for space-less scripts like Japanese) is added
// later, alongside the Japanese grammar.
export function build_tokenizer(name: string, clitics: string[]): tokenizer {
    switch (name) {
        case "whitespace":
            return whitespace_tokenizer(clitics);
        default:
            throw new Error(`unknown %tokenizer '${name}' (known: whitespace)`);
    }
}
