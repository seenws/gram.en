// File-directive expansion: %include and %import.
//
// parse_grammar works on a flat line stream. This module produces that stream
// from a root grammar text by resolving file directives recursively:
//
//   %include syntax.gram   -- splice another grammar file's lines in place
//   %import  lexicon.tsv   -- load a TSV stem lexicon as a %lex Root block
//
// File access is injected as a `resolver` callback so the same code runs under
// Node (filesystem) and at browser bundle time (esbuild plugin). Each emitted
// line carries an origin label ("file:line") so parse errors point at the
// right source even across includes.

export type resolver = (relpath: string) => string;

export type expanded = { lines: string[]; origins: string[] };

export class load_error extends Error {
    constructor(origin: string, msg: string) {
        super(`${origin}: ${msg}`);
        this.name = "load_error";
    }
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

export function expand_grammar(text: string, resolve: resolver | undefined, label: string): expanded {
    const lines: string[] = [];
    const origins: string[] = [];
    // The visited set is a recursion stack (added on entry, removed on exit) so
    // it catches true cycles without forbidding the same file being included
    // from two unrelated places.
    const stack = new Set<string>();

    const push = (line: string, origin: string): void => {
        lines.push(line);
        origins.push(origin);
    };

    const read = (rel: string, origin: string, kind: string): string => {
        if (!resolve) throw new load_error(origin, `${kind} requires a file resolver (none available in this context)`);

        try {
            return resolve(rel);
        } catch (e) {
            throw new load_error(origin, `cannot read '${rel}': ${(e as Error).message}`);
        }
    };

    // A TSV stem lexicon becomes a single %lex Root block. Row columns are
    // tab-separated:  <stem>  <paradigm>  [<feature>=value ...]  (the feature
    // column uses the same `<path>=value` syntax as the rest of the grammar).
    const import_tsv = (rel: string, origin: string): void => {
        const rows = read(rel, origin, "%import").split(/\r?\n/);
        push("%lex Root", `${rel}:0`);

        for (let i = 0; i < rows.length; i++) {
            const clean = strip_comment(rows[i]);

            if (clean.trim().length === 0) continue;

            const cols = clean.split("\t").map((c) => c.trim());
            const stem = cols[0];
            const paradigm = cols[1];

            if (!stem || !paradigm) {
                throw new load_error(`${rel}:${i + 1}`, `TSV row needs at least <stem> TAB <paradigm>: ${clean.trim()}`);
            }

            const feats = cols.slice(2).join(" ").trim();
            push(`    ${stem} : ${paradigm}${feats ? " " + feats : ""}`, `${rel}:${i + 1}`);
        }
    };

    const walk = (src: string, lbl: string): void => {
        const src_lines = src.split(/\r?\n/);

        for (let i = 0; i < src_lines.length; i++) {
            const raw = src_lines[i];
            const trimmed = strip_comment(raw).trim();
            const origin = `${lbl}:${i + 1}`;

            if (trimmed.startsWith("%include")) {
                const rel = trimmed.slice("%include".length).trim();

                if (!rel) throw new load_error(origin, "%include needs a filename");
                if (stack.has(rel)) throw new load_error(origin, `circular %include: ${rel}`);

                stack.add(rel);
                walk(read(rel, origin, "%include"), rel);
                stack.delete(rel);
            } else if (trimmed.startsWith("%import")) {
                const rel = trimmed.slice("%import".length).trim();

                if (!rel) throw new load_error(origin, "%import needs a filename");

                import_tsv(rel, origin);
            } else {
                push(raw, origin);
            }
        }
    };

    walk(text, label);

    return { lines, origins };
}

// Flatten a root grammar to a single self-contained string with all file
// directives resolved. Used by the browser build so the runtime never touches
// the filesystem.
export function flatten_grammar(text: string, resolve: resolver): string {
    return expand_grammar(text, resolve, "<flatten>").lines.join("\n");
}
