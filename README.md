![gram.en banner image](./assets/gramen.png)

# gram.en

**gram.en** is an explainable grammatical analysis engine for natural language.

It combines finite-state morphology, Earley parsing, feature-structure unification, and targeted error rules to diagnose grammatical mistakes with rule-level explanations. The goal is not only to decide whether a sentence is accepted by the grammar, but to explain **which grammatical constraint failed, where it failed, and what repair follows from that failure**.

gram.en treats natural-language analysis like a compiler front end:

```text
text → tokenizer → morphology → lexicon → parser (+ unification)
     → error detection → report
```

A grammatical sentence is a successful parse. An ungrammatical sentence is only reported as an error when the engine can localize the failure to a known constraint or mal-rule. In other words, the verdict and the explanation come from the same computation.

---

## Demo

```sh
$ npm run analyze "the dog bark"
```

```text
the dog bark
        ^^^^

Verdict:   ungrammatical
Violation: subject-verb agreement (number/person)
Rule:      S -> NP VP
Fix:       "the dog barks"  |  "the dog barked"  |  "the dogs bark"
```

```sh
$ npm run analyze "the cat chased I"
```

```text
the cat chased I
               ^

Verdict:   ungrammatical
Violation: the object must be an accusative pronoun
Rule:      VP -> V NP
Fix:       "the cat chased me"
```

```sh
$ npm run analyze "he doesn't bark"
```

```text
Verdict: grammatical
```

Trace mode exposes the internal analysis:

```sh
$ npm run analyze "the dog bark" -- --trace
```

`--trace` prints the morphology and Earley chart activity to stderr, including predictions, scans, completions, scan misses, and feature clashes.

---

## Why this exists

This project began as a language-learning question:

> Can a natural language be represented as executable rules?

Programming languages are intentionally formal. Their syntax is specified, their valid programs are sharply defined, and compilers can reject invalid input according to fixed rules. Natural languages are different: they are ambiguous, exception-heavy, historically layered, and only partially captured by explicit rules.

gram.en is a proof of concept for applying compiler-style architecture to that messier setting. It does not try to replace statistical or neural grammar correction systems, which are far better suited to broad coverage and idiomatic language use. Instead, it explores a different trade-off:

> limited coverage in exchange for explicit structure, predictable behavior, and explainable diagnostics.

---

## Architecture

Each stage lowers the input into a more structured representation.

| Stage | Responsibility |
|---|---|
| **Tokenizer** | Splits raw text into tokens, including contractions such as `don't → do + n't` and `I'm → I + 'm`. |
| **Morphology** | Uses finite-state machinery to map surface words to possible `(lemma, category, features)` analyses. |
| **Lexicon** | Attaches categories and feature structures to closed-class words, clitics, auxiliaries, and analyzed stems. |
| **Parser** | Uses an Earley chart parser over a context-free backbone. |
| **Unification** | Enforces agreement, case, verb-form, and selection constraints. |
| **Diagnostics** | Converts localized failures and mal-rule matches into human-readable reports. |

Ambiguity is preserved until structure resolves it. For example, `bark` may be a noun or a verb. The parser keeps both possibilities alive and lets the grammar decide which analysis fits.

---

## Finite-state morphology

Regular inflection is productive rather than hand-listed. Forms such as:

```text
dogs   → dog + N + Pl
liked  → like + V + Past
tried  → try + V + Past
```

are derived from stems, paradigms, and morphophonemic spelling rules.

Example grammar fragment:

```gram
%class Vowel : a | e | i | o | u
%class Cons  : b | c | d | f | g | h | j | k | l | m | n | p | r | s | t | v | w | x | y | z

%rule e:0 => Cons _ e d
%rule y:i => _ e d
```

The morphology compiler builds a trie-backed finite-state transducer with shared paradigm subgraphs, so large imported lexicons do not require one independent path per inflected form.

---

## Parsing and feature unification

The syntactic backbone is context-free, but grammar rules carry feature equations.

```gram
S -> NP VP
  <NP agr> = <VP agr> ! "subject-verb agreement" fix: agree-verb

NP -> Det N
  <NP agr> = <N agr>

VP -> V
  <VP agr> = <V agr>
```

The rule `S -> NP VP` says that a sentence can consist of a noun phrase followed by a verb phrase. The equation says that the two constituents must agree.

For `the dog bark`, the subject is third-person singular, while `bark` is the non-third-person-singular present form. The parse reaches the sentence rule, attempts to unify the agreement features, and fails. That failed unification becomes the diagnostic.

---

## Diagnostics

gram.en uses two diagnostic mechanisms.

### Constraint relaxation

If strict parsing fails, the parser can retry while relaxing one tagged equation. If relaxing exactly that equation allows a full parse, that equation becomes the explanation.

```gram
S -> NP VP
  <NP agr> = <VP agr> ! "subject-verb agreement" fix: agree-verb
```

This lets the engine report subject-verb agreement rather than a generic parse failure.

### Mal-rules

Some errors are easier to recognize directly. A mal-rule is an intentionally wrong pattern with an attached explanation and repair.

```gram
%mal S -> NP VP
  *ERR "subject-verb agreement: missing third-person singular -s"
  *FIX "inflect the verb or change the subject number"
```

Mal-rules are precise but must be anticipated. Constraint relaxation is more general but must be ranked carefully. The engine uses both.

---

## The `.gram` language

Grammars are written in a small declarative language. A `.gram` file is the engine’s source language: it defines lexical entries, phrase rules, feature constraints, morphology rules, diagnostics, and imports.

| Form | Meaning |
|---|---|
| `word : CAT <feat>=val` | Lexicon entry |
| `A -> B C` | Phrase-structure rule |
| `<B f> = <C f>` | Feature equation |
| `! "message" fix: ...` | Diagnostic attached to a constraint |
| `%mal ... *ERR ... *FIX ...` | Targeted error pattern |
| `%feature num : sg \| pl` | Declares legal values for a feature |
| `%class Vowel : a \| e \| i \| o \| u` | Symbol class for morphology rules |
| `%rule e:0 => Cons _ e d` | Morphophonemic rewrite rule |
| `%lex` | Morphology paradigm |
| `%include` | Include another grammar file |
| `%import` | Import a TSV lexicon |

Example:

```gram
%feature num : sg | pl
%feature pers : 1 | 2 | 3
%feature lemma : *

dog : N <num>=sg <pers>=3 <lemma>=dog
dogs : N <num>=pl <pers>=3 <lemma>=dog

S -> NP VP
  <NP agr> = <VP agr> ! "subject-verb agreement" fix: agree-verb
```

Feature declarations act like a load-time type discipline. A typo such as:

```gram
<num>=sgular
```

is rejected when the grammar loads instead of silently becoming a feature value that never unifies.

`languages/en.gram` is the English fragment. It is organized as a manifest over separate files for closed-class words, clitics, morphology, syntax, and imported lexicon data.

---

## Performance

The engine is designed so ordinary grammatical analysis stays cheap. A heavier benchmark with a 10k-word imported lexicon exposed an accidental scaling cliff in lexical decoding: diagnostic recovery repeatedly re-analyzed generated repair candidates, and each analysis scanned the full root list.

Indexing roots by surface prefix removed that `O(lexicon size)` lookup from the hot path.

| Input class | original p95 | + root index | + fix index |
|---|---:|---:|---:|
| grammatical | 4.64 ms | 1.29 ms | 1.43 ms |
| mal-rule | 8.94 ms | 2.63 ms | 2.59 ms |
| relaxed S–V agreement | 44.3 ms | 25.8 ms | 7.22 ms |
| relaxed missing determiner | 75.1 ms | 33.4 ms | 15.5 ms |
| overall p95 | 77 ms | 34 ms | 16.7 ms |

The lesson: the formal architecture can be sound while one local implementation choice introduces accidental complexity. Benchmarks made that visible.

---

## Usage

Requires **Node ≥ 22.6**.

The CLI and tests run through TypeScript’s native type-stripping, so no build step is required for local analysis.

```sh
npm run analyze "the dog barks"     # analyze a sentence
npm run analyze "the dog bark" -- --trace
npm test                            # run the test suite
npm run bench                       # run performance benchmarks
npm run build                       # bundle the browser engine to dist/engine.js
npm run serve                       # serve the browser demo on :8080
```

---

## Scope

gram.en is a small, hand-authored English fragment, not a wide-coverage grammar.

It is intentionally conservative:

- a successful parse means grammatical within the implemented fragment;
- a localized constraint failure or mal-rule match can be reported as an error;
- a failed parse without a known diagnostic means **out of coverage**, not automatically ungrammatical.

This avoids the main trap of rule-based grammar checking: treating every missing parse as proof that the user made a mistake.

---

## What this project demonstrates

- finite-state morphology
- trie-backed lexicon compilation
- morphophonemic rewrite rules
- Earley chart parsing
- feature-structure unification
- declarative grammar DSL design
- load-time validation
- clitic and auxiliary handling
- mal-rules and constraint-relaxation diagnostics
- traceable parser behavior
- benchmark-driven performance engineering

---

## Theory notes

The accompanying notes explain the formal background behind the engine: languages as sets of strings, the Chomsky hierarchy, membership complexity, pumping lemmas, mildly context-sensitive natural-language phenomena, finite-state morphology, feature structures, unification, and the coverage trap.

Source: [`notes/notes.tex`](notes/notes.tex)  
Typeset PDF: [`notes/notes.pdf`](notes/notes.pdf)

The notes are not required to use the engine; they document the theory and design decisions behind it.
