import type { ExecutionAdmissionGate } from "./contracts.mjs";

/** One project-owned short admission critical section. Never await remote work
 * inside it: commit admitted/in-flight intent, release, then dispatch. */
export class ProjectExecutionAdmission implements ExecutionAdmissionGate {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }
}
