import { readFile, rm, writeFile } from "node:fs/promises";

type ImmutableArtifact = {
  path: string;
  bytes: string;
  label?: string;
};

const isNodeError = (error: unknown, code: string) =>
  error instanceof Error &&
  "code" in error &&
  (error as NodeJS.ErrnoException).code === code;

/** Validate the complete immutable set before creating missing members.
 * Concurrent create races are compared, and any files created by a failed
 * call are rolled back so failure never leaves a partial batch. */
export async function freezeImmutableArtifacts(artifacts: ImmutableArtifact[]) {
  const missing: ImmutableArtifact[] = [];
  for (const artifact of artifacts) {
    try {
      if ((await readFile(artifact.path, "utf8")) !== artifact.bytes)
        throw new Error(
          "Frozen calibration batch changed: " +
            (artifact.label ?? artifact.path),
        );
    } catch (error) {
      if (isNodeError(error, "ENOENT")) missing.push(artifact);
      else throw error;
    }
  }

  const created: string[] = [];
  try {
    for (const artifact of missing) {
      try {
        await writeFile(artifact.path, artifact.bytes, { flag: "wx" });
        created.push(artifact.path);
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
        if ((await readFile(artifact.path, "utf8")) !== artifact.bytes)
          throw new Error(
            "Frozen calibration batch changed: " +
              (artifact.label ?? artifact.path),
          );
      }
    }
  } catch (error) {
    await Promise.all(created.map((path) => rm(path, { force: true })));
    throw error;
  }
  return {
    verified: artifacts.length - missing.length,
    created: created.length,
  };
}
