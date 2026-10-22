# Interrupted project recovery

Crew retains each project's agents, native chat references, access settings and execution evidence outside the app bundle. An interrupted controller can leave writer leases behind even after its process has exited. A lease is ownership evidence, not an agent's workflow status.

When an unavailable project shows **Recover interrupted project**, the owner can request a fresh check. Crew checks the original private state path, the recorded controller PIDs, retained native launch PIDs and the OS open-file report. A live or unverified process prevents takeover. Older empty transport leases require corroborating dead controller records; new transport leases include their own PID and random ownership token.

Successful recovery moves only the recognised abandoned leases into a private timestamped `recovery/` archive with a SHA-256 manifest, then retries the normal project open. It does not reset profiles, authentication, agents, jobs, chat references or environment journals. It does not stop or dispose an environment, infer its readiness, or replay an uncertain command. Environment execution is reconciled by the normal service after reopening.

A failed project no longer necessarily traps the entire app in Quit. Quit can include an unavailable project after fresh ownership, recorded native process, environment command settlement and OS open-file checks prove that it has no unresolved recorded execution. These checks run again during final reservation and close. An unresolved command still requires recovery and inspection. Updates retain their stricter requirement that all projects open normally.

Recovery does not fix an incompatible/missing Codex installation, malformed saved data, unavailable encryption or a live second controller. It preserves the data and reports that recovery could not proceed. It never removes an unknown file or guesses that an inaccessible process has exited.

Implementation: `src/desktop/project-recovery.mts`, desktop owner IPC, and the unavailable-project view. Ticket: [#106](https://github.com/MattGibney/Crew/issues/106). Native Quit follow-up: [#39](https://github.com/MattGibney/Crew/issues/39).
