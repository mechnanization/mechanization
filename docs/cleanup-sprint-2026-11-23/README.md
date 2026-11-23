# Cleanup sprint audit, 2026-11-23

The full codebase audit behind the Jira cleanup sprint (project D3, sprint "MECH Sprint 3 – Cleanup (codebase audit 2026-11-23)", epics D3-211 to D3-223).

- [audit.md](audit.md): the task list (176 tasks, `DRY-01` … `PAGE-16`), the execution rules (section 0), the sidebar and page study (section 12), the sprint plan and the open decisions. The counts were taken on `feat/arrears-lump-sum@4224db6f` (= `develop@ff70e839` plus one commit); the code wins where they differ, so re-count before you rely on one.
- [jira-map.json](jira-map.json): audit ID to Jira key, and the 82 blocks/blocked-by links.
- [unused-exports.txt](unused-exports.txt), [unimported-files.txt](unimported-files.txt): the output of the unused-code scan (a name search; grep before every deletion).

A point-in-time report, not a rulebook: the rules stay in `CLAUDE.md` and `docs/`.
