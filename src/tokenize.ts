// Whitespace tokenizer for space-delimited input. Splits on whitespace and
// strips surrounding punctuation (notes section 9). Token character offsets into
// the original string are tracked so the UI can underline the exact span.

export type Token = { text: string; start: number; end: number };

const ALNUM = /[\p{L}\p{N}]/u;

export function tokenizeSpans(text: string): Token[] {
    const out: Token[] = [];
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        let s = m.index;
        let e = m.index + m[0].length;
        while (s < e && !ALNUM.test(text[s])) s++;
        while (e > s && !ALNUM.test(text[e - 1])) e--;
        if (e > s) out.push({ text: text.slice(s, e), start: s, end: e });
    }
    return out;
}

export function tokenize(text: string): string[] {
    return tokenizeSpans(text).map((t) => t.text);
}
