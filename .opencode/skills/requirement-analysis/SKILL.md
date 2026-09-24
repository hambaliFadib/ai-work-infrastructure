---
name: requirement-analysis
description: >
  Requirement analysis — extract, clarify, and structure business requirements
  from various sources (BPMN, MOM, PRD, issue tracker, or ad-hoc descriptions).
scope: project-local
category: analysis
---

# Requirement Analysis

Extract, clarify, and structure business requirements from available sources.

## Source Inventory
| Source | Location | Status |
|---|---|---|
| BPMN | project-defined | Active |
| MOM | project-defined | Active |
| App Standards | project-defined | Active |
| Issue Tracker | project-defined | Active |
| DB Reference | project-defined | Active |

## Trigger
- Identifying requirement sources for a feature
- Identifying actors, system boundaries, user roles
- Extracting business flows from BPMN
- Extracting business rules from MOM
- Detecting ambiguity, contradiction, missing requirements
- Mapping pre/post conditions per flow
- Documenting exception flows
- Defining acceptance criteria
- Building traceability matrix
- Preparing clarification list
- Flagging risks

## Non-trigger
| Topic | Skill |
|---|---|
| Creating final test cases | test-case-designer, qa-standards |
| Running tests | ui-automation, api-testing, db-testing |
| Modifying requirements | Stakeholder approval required |

## Output Classification
FACT | INFERENCE | ASSUMPTION | OPEN QUESTION | CONFLICT

## Process
1. Source Inventory: list all sources for target feature
2. Actor & Scope: identify actors and boundaries
3. Business Flow: trace BPMN happy path, identify gateways
4. Business Rules: IF/THEN rules, calculations, segment rules
5. Ambiguity Detection: flag unclear statements
6. Contradiction Detection: cross-source comparison
7. Missing Req: gaps in BPMN/UI/API/test coverage
8. Pre/Post Conditions: state before and after flow
9. Exception Flow: at least one per happy path
10. Acceptance Criteria: Given-When-Then format
11. Testability Review: inputs controllable? outputs observable?
12. Traceability: Req ID -> Source -> Criteria -> Test Case
13. Clarification List: questions for stakeholders

## Golden Rules: Zero Assumption & No Blind Spot Policy

1. **Exhaustive Scenario Matrix (No Blind Spot)**
   Core scenarios must not be tested in isolation. Cross-testing (scenario multiplication) with other business variables is required.

2. **Zero Assumption Policy**
   Every requirement must be verified against source documents. Never assume behavior based on "common sense" or "standard practice" without source backing.

3. **Classification Discipline**
   Every finding must be classified as FACT, INFERENCE, ASSUMPTION, OPEN QUESTION, or CONFLICT. Never leave unclassified findings.
