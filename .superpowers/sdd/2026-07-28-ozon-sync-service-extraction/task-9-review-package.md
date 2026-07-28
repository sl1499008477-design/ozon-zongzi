# Task 9 review package

- Business-code diff: none; Task 9 is verification only.
- Inputs:
  - `task-9-brief.md`
  - `task-9-report.md`
  - Task 1 baseline report and dirty baseline
- Review focus:
  - Every required targeted and full verification command has an actual result.
  - The six PostgreSQL failures are demonstrably the same offline baseline, not newly introduced failures.
  - Build, extension parity, test inventory, secrets scan, ownership checks, module boundaries, and whitespace results are recorded.
  - Unverified database success paths and real Ozon behavior are explicitly disclosed.
  - No business file, database/container, Git state, or external service was mutated by Task 9.
