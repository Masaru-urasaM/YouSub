# YouSub — Hard Rules for AI Assistant

## Always conduct a thorough, comprehensive, and professional review. Take as much time and use as many tokens as needed. Check it as meticulously as possible to ensure the project is professional and effective. After each phase, if there are manual steps for the user, explain in detail with step-by-step instructions.

**NEVER write code, edit spec files, or make implementation changes without explicit user approval. The code must be written completely in English. Developer is using Vietnamese for communication only, do not use Vietnamese in code no matter what.**

## Project Overview

A new software project.

**Tech Stack**: To be determined

## MANDATORY WORKFLOW — User-Driven Development

**NEVER write code without explicit user approval.** Follow this strict flow for every implementation step:

1. **Present** — Explain what needs to be done, the options, tradeoffs, and your recommended approach.
2. **Discuss** — User reads, asks questions, gives feedback. Iterate until alignment is reached.
3. **Choose** — User explicitly selects the approach and says "go ahead" or equivalent.
4. **Plan** — Before planning, ALWAYS read the relevant spec files (`YOUSUB_PROJECT_SPEC.md`, `ROADMAP.md`, `ROADMAP_DONE.md`, `YOUSUB_DESIGN_DECISIONS.md`) to fully understand the roadmap, architecture, and design decisions. Never plan from memory alone — specs are the single source of truth. Also research how similar professional projects in the same domain structure their tests. Adopt proven patterns. If it suits the project, suggest it to the developer. Write a detailed plan for user review. User approves before any code is written.
5. **Code** — Only after user approval, write the code.

**Critical Rules:**
- Before each implementation step, ask the user for direction. Do NOT auto-code. Only code when the developer gives a specific command.
- Present multiple options with pros/cons when there are meaningful alternatives.
- If only one reasonable approach exists, explain it and wait for confirmation.
- Break large phases into small, reviewable steps. One step at a time.
- After each step completes, summarize what was done and present the next step for approval.
- Communicate in Vietnamese. Code in English.

---

## Rule 1: No Unsolicited Code or Spec Writing

Workflow for any problem/task:
1. **Present options**: Show 2-3 approaches with pros/cons/tradeoffs for each
2. **Wait for user questions**: User may ask for more information, research, or clarification
3. **Wait for explicit approval**: User must explicitly say "go ahead", "write it", "implement this", or similar
4. **Only then execute**: Write code/spec changes based on the approved approach

This applies to ALL changes — spec documents, code files, config files, any project file.

"Check and update" = analyze and present options, NOT silently write everything.

## Rule 2: Be Honest About Uncertainty

- If a design decision has tradeoffs, say so clearly
- If a number/parameter is an educated guess, label it as such
- Never claim 100% certainty on design decisions — only production testing proves correctness
- Cite sources when making claims

## Rule 3: Respect Output Token Limits — Phase-Based Execution

Gemini Pro has a large context window, but output should be managed effectively. Every task MUST be scoped to fit within reasonable limits.

**Mandatory workflow**:
1. **Before starting**: Estimate the scope of work. If it may be too large (e.g., editing 5+ files, writing 200+ lines of new code, or making 10+ edits across files), split into phases BEFORE writing any code.
2. **Phase execution**: Complete one phase fully, then stop and propose what the next phase should be. Do NOT start the next phase without user confirmation.
3. **After all phases complete**: Run a final comprehensive check — verify cross-references, run tests, confirm no regressions.
4. **When in doubt, split**: It is always safer to split into 2 small phases than to risk hitting the token limit mid-edit. An incomplete edit is worse than a slower workflow.

**Signs you should split into phases**:
- Task touches more than 4-5 files
- Task requires both research AND implementation
- Task involves writing a new module/feature from scratch (>150 lines)
- Multiple independent subtasks bundled into one request

**Token budget reference** (approximate, for planning):
- 1 line of code ≈ 10–15 tokens
- 1 tool call (Edit/Read/Bash) ≈ 200–500 tokens overhead
- A phase with 5 file edits + verification ≈ 5K–10K tokens

## Rule 4: Maintain CHANGELOG.md After Every Implementation

After completing each implementation phase (code written + tests passing + committed), **you MUST update `CHANGELOG.md`** at the project root before moving to the next task.

**Required format:**
```
### Phase N — Short Title (YYYY-MM-DD)

**Added**
- What was created: modules, models, tests, schemas

**Changed** (if applicable)
- What was modified in existing code

**Fixed during implementation** (if applicable)
- Bugs or API issues discovered and resolved during implementation

**Tests**: count changes (old -> new total), regressions, analyze issues
```

**Rules**:
- Update CHANGELOG.md in the **same commit** as the implementation, or in a dedicated follow-up commit if already committed
- Include concrete details: file names, test counts, key decisions
- Document bugs/fixes encountered during implementation — this is valuable context for future sessions
- Keep entries under `## [Unreleased]` until a version is tagged

**Also update after each phase**:
- `ROADMAP.md` — Update the Status column in the Build Order table to `DONE (YYYY-MM-DD)`
- `MEMORY.md` (Gemini memory) — Update the `Status` line in Project Overview + add entry to Implementation Log

## Rule 5: Proactive Tool/Dependency Installation

When a task requires installing tools, packages, or dependencies:

1. **Just do it**: If Gemini can install it (via `winget`, `curl`, `npm`, `pip`, etc.), **install it immediately** without asking. Do NOT stop to propose — just install and move on.
2. **Only ask when truly impossible**: Only explain manual steps to the developer when the installation absolutely requires something Gemini cannot do (e.g., GUI-only installer with no CLI alternative, hardware-level changes).
3. **After any installation**: Verify with a version check command and confirm success.

**Key principle**: Maximize autonomy. Developer does NOT want to be asked for permission on routine installations. Just do it and keep moving.

## Rule 6: Test-Driven Development with Machine-Readable Logs

Every task MUST include tests before it is considered done. Tests are not optional or "do later" — they are part of the definition of done. Each feature/function must be verified working before moving on to the next.

**Test design principles**:
1. **Machine-readable output**: All test output must be parseable by Gemini — structured logs, clear pass/fail indicators, specific error messages with file:line references. No ambiguous output.
2. **Verbose failure logging**: When a test fails, it must log enough context for Gemini to diagnose the issue by reading the log alone — input values, expected vs actual, stack trace, relevant state.
3. **Reference professional projects**: Before writing test infrastructure, research how similar professional projects in the same domain structure their tests. Adopt proven patterns, not ad-hoc approaches.
4. **Three-tier strategy**:
   - Unit tests: Pure logic, no I/O, milliseconds — run after every code change
   - Integration tests: Multiple components, I/O boundaries — run after each phase
   - E2E tests: Full system, real environment — run at milestones
5. **Log retention**: Test logs must be written to files (not just console) so Gemini can read them in subsequent sessions to diagnose issues reported by the developer.
6. **Monotonic test count**: Any decrease in test count = regression = bug

## Rule 7: Record Design Decisions

Record significant decisions in `YOUSUB_DESIGN_DECISIONS.md` — architecture, library choices, algorithm selections, data model designs. This prevents Gemini from re-proposing rejected approaches in future sessions.

**Required format:**
```
### Decision N — Title

**Date**: YYYY-MM-DD
**Status**: RESOLVED / PENDING / REVISITING

**Problem**: What needed to be decided and why

**Options considered**:
1. **Option A** — Pros: ... Cons: ...
2. **Option B** — Pros: ... Cons: ...

**Resolution**: What was chosen, why, and what was rejected

**References**: Related files, specs, or links
```

## Rule 8: Track Deferred Items

When deferring any feature or task, record in `DEFERRED.md`:
- What was deferred and why
- Dependencies that need to be met first
- Effort estimate (Small / Medium / Large)
- When to revisit (trigger condition)

Review at milestone starts — flag items whose dependencies are now met. Remove when implemented.

## Rule 9: Debug Logging for Gemini

All projects MUST implement structured debug logging that Gemini can parse directly.

**Format**: JSON Lines (`.jsonl`), one object per line:
```json
{"ts":"ISO-8601","level":"ERROR","tag":"Component","msg":"Description"}
```

**Required fields**: `ts` (ISO-8601), `level` (DEBUG/INFO/WARN/ERROR), `tag` (module name), `msg` (message)

**Design**:
- Ring buffer rotation (N files x M MB) — prevent unbounded growth
- Buffered writes with periodic flush
- Document log retrieval path in project GEMINI.md
- Gemini reads logs directly to diagnose issues from developer testing

## Rule 10: Roadmap Management and Archiving

After completing each task, you MUST review the `ROADMAP.md` file to see what has been completed and verify progress. 
If the phase or work item has been completed 100%, summarize it and move the content to the `ROADMAP_DONE.md` file. 
The purpose of this is to keep `ROADMAP.md` clean and only contain tasks that are being worked on and those that have not been done yet.

## Rule 11: Mandatory Context Check Before & After Tasks 

Before starting any task and after completing a task, you MUST always check the two files `ROADMAP.md` and `ROADMAP_DONE.md` first. 
This check is mandatory for you to understand the project context, grasp what has been done and what is about to be done next.

---

## Documentation Architecture

| File | Purpose |
|------|---------|
| `GEMINI.md` | Project-specific AI rules (this file) |
| `CONTEXT.md` | High-level background, goals, reasons and desired outcomes |
| `ROADMAP.md` | Single source of truth for ongoing and upcoming operations |
| `ROADMAP_DONE.md` | Archive of 100% completed operations |
| `YOUSUB_PROJECT_SPEC.md` | Navigation hub — full project specification |
| `YOUSUB_DESIGN_DECISIONS.md` | Technical problems + resolved design decisions |
| `CHANGELOG.md` | Change history by phase |
| `DEFERRED.md` | Deferred features and tasks |
| `PROMPT.md` | Current task prompt template |

## Directory Structure

```
YouSub/
├── GEMINI.md                          # Project-specific rules (this file)
├── YOUSUB_PROJECT_SPEC.md           # Navigation hub — project specification
├── YOUSUB_DESIGN_DECISIONS.md       # Design decisions record
├── CHANGELOG.md                       # Change history
├── DEFERRED.md                        # Deferred items
├── PROMPT.md                          # Current task prompt
├── ROADMAP.md                         # Current and remaining tasks
├── ROADMAP_DONE.md                    # Archived completed tasks
├── .gemini/
│   └── settings.local.json            # Gemini local permissions
└── [project source code]
```

