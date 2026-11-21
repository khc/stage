// A dependency (Firestore, Cloud Run, Pub/Sub) failed. `code` is the short,
// detail-free error the caller sees with a 502; `cause` is only logged.
export class DependencyError extends Error {
  readonly code: string;
  constructor(code: string, cause: unknown) {
    super(code, { cause });
    this.name = "DependencyError";
    this.code = code;
  }
}

// Runs a call to a dependency and turns any failure into a DependencyError.
export const guard = async <T>(code: string, call: () => Promise<T>): Promise<T> => {
  try {
    return await call();
  } catch (err) {
    throw new DependencyError(code, err);
  }
};
