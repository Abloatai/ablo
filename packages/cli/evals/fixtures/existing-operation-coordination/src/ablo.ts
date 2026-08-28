export interface HeldLease {
  readonly id: string;
  release(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

// Existing, reviewed stateless worker boundary. Its installed SDK runtime and
// scoped credential are supplied before this application code runs.
export declare const ablo: {
  readonly taskRuns: {
    claim(
      id: string,
      options: {
        readonly contention: { readonly mode: 'skip' };
        readonly ttl: string;
        readonly heartbeat: { readonly every: string };
      },
    ): Promise<HeldLease | null>;
  };
};
