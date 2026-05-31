// Pre-build step: resolve %include / %import in en.gram and write a single
// self-contained en.flat.gram. The browser bundle imports the flattened file
// (esbuild's .gram text loader inlines it) so the runtime never needs a file
// resolver -- all file access happens here, at build time, on Node.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { flatten_grammar } from "../src/loader.ts";

const here = dirname(fileURLToPath(import.meta.url));
const gram_dir = join(here, "..", "languages");
const resolve = (rel: string): string => readFileSync(join(gram_dir, rel), "utf8");

const flat = flatten_grammar(readFileSync(join(gram_dir, "en.gram"), "utf8"), resolve);
const out = join(gram_dir, "en.flat.gram");

writeFileSync(out, flat + "\n");
console.log(`wrote ${out} (${flat.split("\n").length} lines)`);
