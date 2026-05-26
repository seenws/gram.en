// Browser entry point. esbuild bundles this into dist/engine.js as a global
// `GrammarEngine`, inlining en.gram as text at build time. The page then calls
// GrammarEngine.check(sentence) -> Analysis (no server, no runtime fetch).

import { parseGrammar } from "./grammar.ts";
import { analyze, type Analysis } from "./analyze.ts";
import gramText from "../languages/en.gram";

const grammar = parseGrammar(gramText);

export function check(sentence: string): Analysis {
    return analyze(grammar, sentence);
}
