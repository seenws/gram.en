import { load_grammar } from "./languages.ts";
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

const args = process.argv.slice(2);
const trace_on = args.includes("--trace");

// --lang <code> selects the language (default en); everything else is the sentence.
const lang_idx = args.indexOf("--lang");
const lang = lang_idx >= 0 ? args[lang_idx + 1] : "en";
const skip = new Set<number>();
if (lang_idx >= 0) skip.add(lang_idx).add(lang_idx + 1);
const sentence = args.filter((a, i) => a !== "--trace" && !skip.has(i)).join(" ").trim();

if (!sentence) {
    console.error('usage: node --experimental-strip-types src/cli.ts [--lang en|sv] [--trace] "the dog bark"');
    process.exit(1);
}

const grammar = load_grammar(lang);

// In --trace mode, narrate the morphology and the Earley chart to stderr so the
// verdict on stdout stays clean and pipeable.
const trace = trace_on ? (line: string) => console.error(line) : undefined;

console.log(format_report(analyze(grammar, sentence, { trace })));
