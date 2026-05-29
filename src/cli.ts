import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse_grammar } from "./grammar.ts";
import { analyze, type analysis } from "./analyze.ts";

function format_report(a: analysis): string {
    const sentence = a.tokens.join(" ");
    const lines: string[] = [sentence, ""];

    switch (a.verdict) {
        case "grammatical":
            lines.push("Verdict:   grammatical");

            return lines.join("\n");
        case "unknown-word":
            lines.pop();
            lines.push(`Verdict:   not analyzed -- unknown word(s): ${a.unknown_words.join(", ")}`);

            return lines.join("\n");
        case "no-analysis":
            lines.pop();
            lines.push("Verdict:   no analysis (out of coverage; not necessarily ungrammatical)");

            return lines.join("\n");
        case "ungrammatical": {
            const v = a.violations[0];

            if (v) {
                const pre = a.tokens.slice(0, v.span[0]).join(" ");
                const pad = pre.length + (v.span[0] > 0 ? 1 : 0);
                const span = a.tokens.slice(v.span[0], v.span[1]).join(" ");
                lines.splice(1, 0, " ".repeat(pad) + "^".repeat(Math.max(span.length, 1)));
            }

            lines.push("Verdict:   ungrammatical");

            for (const vv of a.violations) {
                lines.push("", `Violation: ${vv.message}`, `Rule:      ${vv.rule}`);

                if (vv.fixes.length > 0) {
                    lines.push(`Fix:       ${vv.fixes.map((f) => `"${f}"`).join("  |  ")}`);
                }
            }

            return lines.join("\n");
        }
    }
}

const here = dirname(fileURLToPath(import.meta.url));
const gram_path = join(here, "..", "languages", "en.gram");
const grammar = parse_grammar(readFileSync(gram_path, "utf8"));
const sentence = process.argv.slice(2).join(" ").trim();

if (!sentence) {
    console.error('usage: node --experimental-strip-types src/cli.ts "the dog bark"');
    process.exit(1);
}

console.log(format_report(analyze(grammar, sentence)));
