// Pre-build step: resolve %include / %import in each language's manifest and
// write a single self-contained <code>.flat.gram per language. The browser bundle
// imports the flattened files (esbuild's .gram text loader inlines them) so the
// runtime never needs a file resolver -- all file access happens here, at build
// time, on Node. Pass `--lang <code>` to flatten just one; default flattens all.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flatten_grammar } from "../src/loader.ts";
import { LANGUAGES, lang_dir, lang_resolver, lang_spec_of } from "../src/languages.ts";

const lang_idx = process.argv.indexOf("--lang");
const specs = lang_idx >= 0 ? [lang_spec_of(process.argv[lang_idx + 1])] : LANGUAGES;

for (const spec of specs) {
    const dir = lang_dir(spec);
    const flat = flatten_grammar(readFileSync(join(dir, spec.manifest), "utf8"), lang_resolver(spec));
    const out = join(dir, spec.manifest.replace(/\.gram$/, ".flat.gram"));

    writeFileSync(out, flat + "\n");
    console.log(`wrote ${out} (${flat.split("\n").length} lines)`);
}
