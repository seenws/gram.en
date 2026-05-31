# gram.en

**gram.en** is an explainable grammatical analysis engine. It combines
finite-state morphology, Earley parsing, feature-structure unification, and
targeted error rules to diagnose grammatical mistakes with rule-level
explanations.

It treats natural-language analysis like a **compiler front end**: raw text is
tokenized, morphologically analyzed, parsed against a grammar, checked through
feature constraints, and reported as either a successful parse or a localized
grammatical violation.

It came about as an attempt to answer whether natural language can be described
as a set of grammatical rules. Programming languages are formal and total;
natural language is messy, partial, ambiguous, and full of exceptions — yet the
architecture here is deliberately compiler-like. The goal is not to replace
statistical or neural grammar correction, but to build an explainable rule
engine that can say *which* grammatical constraint was violated, *where*, and
*how to fix it*.

```
$ analyze "the dog bark"

the dog bark
        ^^^^

Verdict:   ungrammatical
Violation: subject-verb agreement (number/person)
Rule:      S -> NP VP
Fix:       "the dog barks"  |  "the dog barked"  |  "the dogs bark"
```

```
$ analyze "the cat chased I"

the cat chased I
               ^

Verdict:   ungrammatical
Violation: the object must be an accusative pronoun
Rule:      VP -> V NP
Fix:       "the cat chased me"
```

## The pipeline

Each stage is a function from one representation to the next — the same staged
lowering a compiler performs from source text to a checked intermediate form:

```
text → tokenizer → morphology → lexicon → parser (+ unification)
     → error detection → report
```

1. **Tokenizer** — splits text into tokens, including contractions
   (`don't` → `do` + `n't`, `I'm` → `I` + `'m`).
2. **Morphology** — a finite-state transducer maps each surface word to one or
   more `(lemma, category, features)` analyses. Regular inflection is
   productive: `chased`, `liked`, `tried` are derived from a `+V+Past` paradigm
   plus spelling rules (e-deletion, `y→i`), not listed by hand.
3. **Lexicon** — closed-class words (determiners, pronouns, auxiliaries,
   clitics) are explicit; open-class words come from the morphology. Ambiguity
   is kept as a list and resolved later by the parser.
4. **Parser** — an Earley chart parser builds constituent structure over a
   context-free backbone, **unifying feature structures** as it goes. Agreement,
   case, and article constraints are unification equations on the rules.
5. **Error detection** — a unification failure is a candidate diagnosis: the
   parser retries with one constraint relaxed, and if that rescues the parse,
   *that* constraint is the explanation. Hand-authored **mal-rules** catch
   specific anticipated mistakes (wrong word order, `*childs`) that no relaxation
   would otherwise localize.
6. **Report** — a verdict, the offending span, the named rule, and a concrete
   repair.

A key consequence of the design: the verdict and its explanation are the *same*
computation seen two ways. A grammatical sentence is a successful parse; an
ungrammatical one is a parse that failed on a specific, named, located
constraint.

## The grammar as a small declarative language

Grammars live in plain-text `.gram` files — a concrete syntax for a unification
grammar (PATR-II in spirit) with directives that configure the pipeline, much
like a compiler's preprocessing and declaration layer:

| directive | role |
|---|---|
| `word : CAT <feat>=val` | a lexicon entry |
| `LHS -> RHS ...` + `<A f> = <B f>` | a phrase-structure rule with feature constraints |
| `! "message" fix: ...` | a diagnostic attached to a constraint |
| `%mal LHS -> RHS ... *ERR ... *FIX ...` | a targeted error pattern |
| `%feature num : sg \| pl` | declares a feature's value type (checked at load) |
| `%class Vowel : a \| e \| i \| o \| u` | a named symbol set for morphology rules |
| `%rule e:0 => Cons _ e d` | a morphophonemic spelling rule |
| `%lex` / `%include` / `%import` | morphology paradigms, file inclusion, bulk TSV lexicons |

`languages/en.gram` is the English fragment, split across `closed.gram`,
`clitics.gram`, `morph.gram`, `syntax.gram`, and `lexicon.tsv`.

## Usage

Requires Node ≥ 22.6 (the engine is TypeScript run via native type-stripping; no
build step for the CLI or tests).

```sh
npm run analyze "the dog barks"     # analyze a sentence (add --trace to narrate)
npm test                            # run the test suite
npm run bench                       # FST-size / parse-time / load-time benchmarks
npm run build                       # bundle the browser engine to dist/engine.js
npm run serve                       # serve the browser demo (index.html) on :8080
```

`--trace` narrates the morphology and the Earley chart to stderr — including
where prediction or scanning dead-ends — which is the same explainability the
engine offers its user, turned toward its author.

## Scope and honesty

This is a small, hand-authored English fragment, not a wide-coverage grammar.
Every error type it recognizes is written by hand; an absent parse means "out of
coverage," **not** "ungrammatical" (see the coverage discussion in the notes).
The point is the architecture and the explanations, not the breadth.

## Theory

The design notes — what a language is, the Chomsky hierarchy, where natural
language sits, why membership is decided over a context-free backbone,
finite-state morphology and replace rules, unification, and the engineering
pitfalls met along the way — are in [`notes/notes.tex`](notes/notes.tex)
(typeset PDF: `notes/notes.pdf`).
