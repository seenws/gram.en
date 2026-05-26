// Command-line front end:
//   node --experimental-strip-types src/cli.ts "the dog bark"
// Loads languages/en.gram, analyzes the argument sentence, prints a report in
// the shape of notes section 13.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseGrammar } from "./grammar.ts";
import { analyze, type Analysis } from "./analyze.ts";

function formatReport(a: Analysis): string {
    const sentence = a.tokens.join(" ");
    const lines: string[] = [sentence, ""];

    switch (a.verdict) {
        case "grammatical":
            lines.push("Verdict:   grammatical");
            return lines.join("\n");
        case "unknown-word":
            lines.pop();
            lines.push(`Verdict:   not analyzed -- unknown word(s): ${a.unknownWords.join(", ")}`);
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
const gramPath = join(here, "..", "languages", "en.gram");
const grammar = parseGrammar(readFileSync(gramPath, "utf8"));

const sentence = process.argv.slice(2).join(" ").trim();
if (!sentence) {
    console.error('usage: node --experimental-strip-types src/cli.ts "the dog bark"');
    process.exit(1);
}

console.log(formatReport(analyze(grammar, sentence)));
