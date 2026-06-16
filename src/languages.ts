// Language registry: the wiring that maps a short code (en, sv) to its grammar
// directory, manifest, display name, and regression corpus. The engine itself is
// language-neutral -- everything is driven by the .gram files -- so this is the
// one place that knows which files belong to which language. Adding a language is
// a new entry here plus its languages/<dir>/ data and test/<corpus>.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse_grammar, type grammar } from "./grammar.ts";

export type lang_spec = {
    code: string; // short code used on the CLI / browser switch (en, sv)
    dir: string; // subdirectory under languages/
    manifest: string; // entry .gram inside that directory
    label: string; // display name for the browser switcher
    corpus: string; // regression corpus filename under test/
    ud?: string; // optional UD treebank filename under tools/ud/ (dev-time validation)
};

export const LANGUAGES: lang_spec[] = [
    { code: "en", dir: "english", manifest: "en.gram", label: "English", corpus: "corpus.txt", ud: "en_ewt-ud-test.conllu" },
    { code: "sv", dir: "swedish", manifest: "sv.gram", label: "Svenska", corpus: "corpus.sv.txt", ud: "sv_talbanken-ud-test.conllu" },
    { code: "ru", dir: "russian", manifest: "ru.gram", label: "Русский", corpus: "corpus.ru.txt", ud: "ru_gsd-ud-test.conllu" },
];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function lang_spec_of(code: string): lang_spec {
    const spec = LANGUAGES.find((l) => l.code === code);
    if (!spec) throw new Error(`unknown language '${code}' (known: ${LANGUAGES.map((l) => l.code).join(", ")})`);

    return spec;
}

export function lang_dir(spec: lang_spec): string {
    return join(root, "languages", spec.dir);
}

export function corpus_path(spec: lang_spec): string {
    return join(root, "test", spec.corpus);
}

// Path to a language's UD treebank under tools/ud/ (gitignored, dev-time only).
// Undefined when the language declares no treebank.
export function ud_path(spec: lang_spec): string | undefined {
    return spec.ud ? join(root, "tools", "ud", spec.ud) : undefined;
}

// A Node file resolver rooted at a language's directory, for %include / %import.
export function lang_resolver(spec: lang_spec): (rel: string) => string {
    const dir = lang_dir(spec);

    return (rel: string): string => readFileSync(join(dir, rel), "utf8");
}

// Load + parse a language's grammar from disk (Node only; the browser uses the
// prebuilt flattened grammar instead).
export function load_grammar(code: string): grammar {
    const spec = lang_spec_of(code);
    const resolve = lang_resolver(spec);

    return parse_grammar(readFileSync(join(lang_dir(spec), spec.manifest), "utf8"), { resolve, filename: spec.manifest });
}
