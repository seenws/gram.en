// Enforcement of the UD morphology audit: for each language whose treebank is
// present under tools/ud/, every in-coverage token must agree with gold. A
// language with no treebank downloaded is simply skipped (the data is gitignored
// and not required to run the rest of the suite) -- the same existsSync guard the
// regression-corpus test uses. The audit logic lives in src/ud_audit.ts.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { LANGUAGES, load_grammar, ud_path } from "../src/languages.ts";
import { run_audit } from "../src/ud_audit.ts";

const present = LANGUAGES.filter((spec) => {
    const p = ud_path(spec);

    return p !== undefined && existsSync(p);
});

if (present.length === 0) {
    test("UD audit (no treebanks present — skipped)", { skip: "no tools/ud/*.conllu downloaded" }, () => {});
}

for (const spec of present) {
    const g = load_grammar(spec.code);
    const r = run_audit(g, spec.code, readFileSync(ud_path(spec)!, "utf8"));

    test(`[${spec.code}] UD audit: every in-coverage token agrees with gold`, () => {
        const report = r.mismatches
            .map((m) => {
                const want = Object.entries(m.want.feats).map(([k, v]) => `${k}=${v}`).join(" ");

                return `  "${m.form}" gold=${m.upos}[${want}] engine=${m.got.join(" | ")}`;
            })
            .join("\n");

        assert.equal(
            r.mismatches.length,
            0,
            `${r.mismatches.length}/${r.audited} in-coverage tokens disagree with gold:\n${report}`,
        );
    });
}
