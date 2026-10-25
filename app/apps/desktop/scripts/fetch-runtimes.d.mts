/** Types for the parts of fetch-runtimes.mjs that design-smoke.mts imports. */
export function pythonDistMeta(
  target: { os: string; arch: string },
  versions: { python: string; pythonReleaseTag: string },
): { url: string; archiveName: string; kind: string; stripTop: boolean };
