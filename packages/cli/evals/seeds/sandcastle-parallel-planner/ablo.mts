export interface HeldLease {
  readonly id: string;
  release(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

// Existing application wiring. The installed SDK and scoped worker credential
// are supplied by the application that generated this planner.
export declare const ablo: {
  readonly taskRuns: {
    claim(
      id: string,
      options: {
        readonly contention: { readonly mode: "skip" };
        readonly ttl: string;
        readonly heartbeat: { readonly every: string };
      },
    ): Promise<HeldLease | null>;
  };
};
