import { parse_grammar } from "./grammar.ts";
import { analyze, type analysis } from "./analyze.ts";
import gram_text from "../languages/en.gram";

const grammar = parse_grammar(gram_text);

export function check(sentence: string): analysis {
    return analyze(grammar, sentence);
}
