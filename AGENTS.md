# Agent Foundation Contract

This repository is a general-purpose AI work infrastructure. No profession, client, workflow, or project type defines the root architecture.

## Execution Model

Agents operate evidence-first:

1. Read the relevant files and current state.
2. Plan the smallest safe change.
3. Change only the approved scope.
4. Test or validate the result.
5. Report what changed and what was verified.

Sensitive writes require human approval. Agents must not perform silent destructive actions, expose secrets, or mix project state across isolation boundaries.

## Isolation

Project, job, and runtime state must remain isolated from the base control plane. Generated sessions, logs, ledgers, local databases, browser profiles, and credentials are not source content.

## OpenCode Boundary

The OpenCode engine is an upstream dependency. This repository owns the OpenCode control plane: configuration contracts, governance, bootstrap surfaces, reusable capabilities, and workspace structure.

Full behavior migration belongs to later reviewed phases.
