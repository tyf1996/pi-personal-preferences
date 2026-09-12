export type BackgroundKind = "feedback" | "group";

interface RunningTask {
  controller: AbortController;
  promise: Promise<void>;
}

export interface BackgroundSnapshot {
  feedbackIds: ReadonlySet<string>;
  groupNames: ReadonlySet<string>;
  count: number;
}

export class BackgroundTasks {
  private accepting = true;
  private readonly feedback = new Map<string, RunningTask>();
  private readonly groups = new Map<string, RunningTask>();
  private readonly onChange: () => void | Promise<void>;
  private readonly onUnhandledError: (error: unknown) => void;

  constructor(onChange: () => void | Promise<void>, onUnhandledError: (error: unknown) => void) {
    this.onChange = onChange;
    this.onUnhandledError = onUnhandledError;
  }

  snapshot(): BackgroundSnapshot {
    return {
      feedbackIds: new Set(this.feedback.keys()),
      groupNames: new Set(this.groups.keys()),
      count: this.feedback.size + this.groups.size,
    };
  }

  cancel(kind: BackgroundKind, key: string): boolean {
    const collection = kind === "feedback" ? this.feedback : this.groups;
    const task = collection.get(key);
    if (!task) return false;
    task.controller.abort();
    return true;
  }

  start(kind: BackgroundKind, key: string, run: (signal: AbortSignal) => Promise<void>): boolean {
    if (!this.accepting) return false;
    const collection = kind === "feedback" ? this.feedback : this.groups;
    if (collection.has(key)) return false;
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(() => run(controller.signal))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) this.onUnhandledError(error);
      })
      .finally(() => {
        if (collection.get(key)?.promise === promise) collection.delete(key);
        this.changed();
      });
    collection.set(key, { controller, promise });
    this.changed();
    return true;
  }

  async shutdown(maximumWaitMs = 500): Promise<void> {
    this.accepting = false;
    const running = [...this.feedback.values(), ...this.groups.values()];
    for (const task of running) task.controller.abort();
    if (!running.length) return;
    await Promise.race([
      Promise.allSettled(running.map((task) => task.promise)).then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, maximumWaitMs)),
    ]);
  }

  private changed(): void {
    Promise.resolve(this.onChange()).catch(this.onUnhandledError);
  }
}
