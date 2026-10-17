// Static builds replay runs recorded from the app instead of asking it. Building with VITE_TRACES set
// (the book does: VITE_TRACES=./traces/) turns every API call into a fetch of a JSON file under
// that path; `npm run save-traces` records the files from a running app.

export const TRACES: string | undefined = import.meta.env.VITE_TRACES || undefined;

/** A recorded response, e.g. recorded("queue-retry") for traces/queue-retry.json. */
export async function recorded<T>(name: string): Promise<T> {
  const res = await fetch(`${TRACES}${name}.json`);
  if (!res.ok) throw new Error(`${res.status} for ${name}.json`);
  return (await res.json()) as T;
}
