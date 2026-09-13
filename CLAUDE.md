## graphify

This project has a knowledge graph in `graphify-out/` (code via AST plus the planning docs in `docs/`). It is committed to git. Use it whenever it gets you to the answer faster than grepping and reading files. That is usually the case when you don't yet know where something lives.

**Use the graph first** when:
- you need to find where a concept lives and don't know the file yet
- the question crosses layers (frontend ↔ backend ↔ DB ↔ `docs/` spec), e.g. "how does occupancy reach billing"
- you need the blast radius of a change ("what touches `UnitOccupancy`?")
- you want an architecture overview, or you are orienting in an unfamiliar module

Commands (about 1–2 seconds; keep `--budget` modest so the output stays small):
- `graphify query "<question>" --budget 1500` gives a scoped subgraph for a question
- `graphify path "<A>" "<B>"` shows how two concepts connect
- `graphify explain "<symbol or concept>"` gives one node and its neighbours
- `graphify-out/GRAPH_REPORT.md` covers the whole architecture (community hubs, god nodes). Read it only for a broad review.

**Skip the graph** when:
- the file or symbol is already known (the user named it, it is the IDE selection, or you just found it)
- a single exact-string search answers it (an error message, a translation key, a specific identifier)
- you are editing lines you have already located

**Treat results as leads, not facts.** The graph is a snapshot and can lag behind the working tree. Open the source at the `src=… loc=…` it gives before you edit or cite anything. If a result points at a file or symbol that no longer exists, run `graphify update .`. It is AST-only and free, but it rewrites the tracked `graphify-out/graph.json`. Mention that in your reply, and keep it out of unrelated commits.

When spawning a subagent to explore code, tell it the graph exists and pass along these rules.
