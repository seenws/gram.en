// The treebanks live under tools/ud/ (gitignored, downloaded on demand); a missing
// file is a friendly skip, not an error.
//
// Run:  node --experimental-strip-types scripts/ud-check.ts [--lang en] [--verbose]

import { existsSync, readFileSync } from "node:fs";
import { load_grammar, lang_spec_of, ud_path } from "../src/languages.ts";
import { run_audit } from "../src/ud_audit.ts";

const args = process.argv.slice(2);
const lang_idx = args.indexOf("--lang");
const lang = lang_idx >= 0 ? args[lang_idx + 1] : "en";
const verbose = args.includes("--verbose");

const spec = lang_spec_of(lang);
const path = ud_path(spec);

if (!path || !existsSync(path)) {
    console.error(`no UD treebank for '${lang}' at ${path ?? "(none declared)"}.`);
    console.error(`download it into tools/ud/ first (see README), then re-run.`);
    process.exit(2);
}

const g = load_grammar(lang);
const r = run_audit(g, lang, readFileSync(path, "utf8"));
const pct = (k: number, n: number): string => (n === 0 ? "--" : `${((100 * k) / n).toFixed(1)}%`);

console.log(`UD audit [${lang}]: ${spec.ud}`);
console.log(`  ${r.tokens} tokens`);
console.log(`    ${r.skipped_scope} out of scope (unaudited POS / feature value the fragment doesn't model)`);
console.log(`    ${r.unknown_form} audited POS but surface not in lexicon`);
console.log(`    ${r.pos_gap} surface known but only under a different category (coverage gap, not error)`);
console.log(`  ${r.audited} in coverage (surface known + engine has UD's category)`);
console.log(`    ${r.agree} agree with gold   (${pct(r.agree, r.audited)})`);
console.log(`    ${r.mismatches.length} disagree`);

if (r.mismatches.length > 0) {
    console.log(`\ndisagreements (engine has the surface but no analysis matching gold):`);

    for (const m of r.mismatches) {
        const want = Object.entries(m.want.feats).map(([k, v]) => `${k}=${v}`).join(" ");
        console.log(`  "${m.form}" gold=${m.upos}[${want}]  engine=${m.got.join(" | ")}`);
    }
}

if (verbose) {
    console.log(`\nlegend: a token is "in coverage" only when the lexicon knows its surface and its`);
    console.log(`gold analysis uses only features/values the fragment models; those are the only`);
    console.log(`tokens the engine is held to. Everything else is honest abstention, not error.`);
}

process.exit(r.mismatches.length > 0 ? 1 : 0);
