---
name: ubiquitous-language
description: Extract a DDD-style ubiquitous language glossary from the current conversation, flagging ambiguities and proposing canonical terms. Saves to UBIQUITOUS_LANGUAGE.md. Use when user wants to define domain terms, build a glossary, harden terminology, create a ubiquitous language, or mentions "domain model" or "DDD".
disable-model-invocation: true

metadata:
  version: "1.0.0"
  last-audited: "2026-09-16"
---

# Ubiquitous Language

Extract and formalize domain terminology from the current conversation into a consistent glossary, saved to a local file.

## Process

1. **Scan the conversation** for domain-relevant nouns, verbs, and concepts
2. **Identify problems**:
   - Same word used for different concepts (ambiguity)
   - Different words used for the same concept (synonyms)
   - Vague or overloaded terms
3. **Propose a canonical glossary** with opinionated term choices
4. **Write to `UBIQUITOUS_LANGUAGE.md`** in the working directory using the format below
5. **Output a summary** inline in the conversation

## Output Format

Write a `UBIQUITOUS_LANGUAGE.md` file with this structure:

```md
# Ubiquitous Language

## <Domain area>

| Term        | Definition                              | Aliases to avoid      |
| ----------- | --------------------------------------- | --------------------- |
| **Term**    | A concise definition                    | alias1, alias2        |

## Relationships

- A **TermA** belongs to exactly one **TermB**

## Example dialogue

> **Dev:** "When a **TermA** is created, does **TermB** happen?"
> **Domain expert:** "No — **TermB** only occurs after..."

## Flagged ambiguities

- "account" was used to mean both **Customer** and **User** — these are distinct concepts.
```

## Rules

- **Be opinionated.** When multiple words exist for the same concept, pick the best one and list the others as aliases to avoid.
- **Flag conflicts explicitly.** If a term is used ambiguously, call it out.
- **Only include terms relevant for domain experts.** Skip module/class names unless they have domain meaning.
- **Keep definitions tight.** One sentence max. Define what it IS, not what it does.
- **Show relationships.** Use bold term names and express cardinality where obvious.
- **Only include domain terms.** Skip generic programming concepts unless they have domain-specific meaning.
- **Group terms into multiple tables** when natural clusters emerge.
- **Write an example dialogue.** A short conversation (3-5 exchanges) demonstrating how terms interact naturally.
