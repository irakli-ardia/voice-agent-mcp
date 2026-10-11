/** The error a promise rejects with; fails the test if it resolves or rejects with a non-error. */
export async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }

    throw new Error("The promise rejected with a value that is not an Error.");
  }

  throw new Error("Expected the promise to reject, but it resolved.");
}
