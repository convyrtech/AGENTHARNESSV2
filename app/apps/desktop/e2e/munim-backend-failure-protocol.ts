const OPAQUE_TOKEN = String.raw`munim_v1\.[0-9a-f-]{36}\.[0-9]+`;

type ProxyLifecycleEvent = {
  kind?: string;
  proxyPid?: number;
  proxyCreationUtcTicks?: string;
  proxyImagePath?: string;
  childPid?: number;
  childCreationUtcTicks?: string;
  childImagePath?: string;
  realMunimPath?: string;
};

export function eventsShareProcessChain(
  left: ProxyLifecycleEvent,
  right: ProxyLifecycleEvent,
): boolean {
  return (
    isValidIdentity(
      {
        pid: left.proxyPid,
        creationUtcTicks: left.proxyCreationUtcTicks,
        imagePath: left.proxyImagePath,
      },
      right.proxyImagePath,
    ) &&
    isValidIdentity(
      {
        pid: right.proxyPid,
        creationUtcTicks: right.proxyCreationUtcTicks,
        imagePath: right.proxyImagePath,
      },
      left.proxyImagePath,
    ) &&
    left.proxyPid === right.proxyPid &&
    left.proxyCreationUtcTicks === right.proxyCreationUtcTicks &&
    isValidIdentity(
      {
        pid: left.childPid,
        creationUtcTicks: left.childCreationUtcTicks,
        imagePath: left.childImagePath,
      },
      right.childImagePath,
    ) &&
    isValidIdentity(
      {
        pid: right.childPid,
        creationUtcTicks: right.childCreationUtcTicks,
        imagePath: right.childImagePath,
      },
      left.childImagePath,
    ) &&
    left.childPid === right.childPid &&
    left.childCreationUtcTicks === right.childCreationUtcTicks &&
    typeof left.realMunimPath === "string" &&
    typeof right.realMunimPath === "string" &&
    left.realMunimPath.toLowerCase() === right.realMunimPath.toLowerCase()
  );
}

export type OwnedProcessIdentity = {
  pid: number;
  creationUtcTicks: string;
  imagePath: string;
};

/** Return every proxy start that lacks its matching PID-plus-creation-time exit event. */
export function proxyStartsWithoutExit(events: ProxyLifecycleEvent[]): ProxyLifecycleEvent[] {
  const starts = events.filter((event) => event.kind === "proxy-started");
  return starts.filter(
    (start) =>
      !Number.isSafeInteger(start.proxyPid) ||
      !isValidTicks(start.proxyCreationUtcTicks) ||
      !events.some(
        (event) =>
          event.kind === "proxy-exit" &&
          event.proxyPid === start.proxyPid &&
          event.proxyCreationUtcTicks === start.proxyCreationUtcTicks,
      ),
  );
}

/** Validate logged process identities and event pairings; OS snapshots prove actual absence. */
export function proxyLifecycleIsVerified(
  events: ProxyLifecycleEvent[],
  expectedImagePath: string,
  expectedMunimPath?: string,
): boolean {
  const starts = events.filter((event) => event.kind === "proxy-started");
  const childStarts = events.filter((event) => event.kind === "real-munim-child-started");
  const proxyKey = (event: ProxyLifecycleEvent) =>
    `${event.proxyPid}:${event.proxyCreationUtcTicks}`;
  const childKey = (event: ProxyLifecycleEvent) =>
    `${proxyKey(event)}:${event.childPid}:${event.childCreationUtcTicks}`;
  const bareChildKey = (event: ProxyLifecycleEvent) =>
    `${event.childPid}:${event.childCreationUtcTicks}`;
  const proxyKeys = new Set(starts.map(proxyKey));
  const childKeys = new Set(childStarts.map(childKey));
  const uniqueChildKeys = new Set(childStarts.map(bareChildKey));
  const proxyExits = events.filter((event) => event.kind === "proxy-exit");
  const controlledChildExits = events.filter(
    (event) => event.kind === "real-munim-child-exited-after-controlled-kill",
  );
  const uniqueProxyExitKeys = new Set(proxyExits.map(proxyKey));
  const uniqueChildExitKeys = new Set(controlledChildExits.map(childKey));
  const invalidProxyExit = events.some(
    (event) => event.kind === "proxy-exit" && !proxyKeys.has(proxyKey(event)),
  );
  const invalidChildEvent = events.some(
    (event) =>
      event.kind === "real-munim-child-exited-after-controlled-kill" &&
      !childKeys.has(childKey(event)),
  );
  return (
    starts.length > 0 &&
    proxyKeys.size === starts.length &&
    childKeys.size === childStarts.length &&
    uniqueChildKeys.size === childStarts.length &&
    uniqueProxyExitKeys.size === proxyExits.length &&
    uniqueChildExitKeys.size === controlledChildExits.length &&
    starts.every((start) =>
      isValidIdentity(
        {
          pid: start.proxyPid,
          creationUtcTicks: start.proxyCreationUtcTicks,
          imagePath: start.proxyImagePath,
        },
        expectedImagePath,
      ),
    ) &&
    childStarts.every(
      (start) =>
        proxyKeys.has(proxyKey(start)) &&
        isValidIdentity(
          {
            pid: start.childPid,
            creationUtcTicks: start.childCreationUtcTicks,
            imagePath: start.childImagePath,
          },
          expectedMunimPath ?? start.realMunimPath,
        ) &&
        isValidIdentity(
          {
            pid: start.proxyPid,
            creationUtcTicks: start.proxyCreationUtcTicks,
            imagePath: start.proxyImagePath,
          },
          expectedImagePath,
        ),
    ) &&
    events.every((event) => {
      if (event.kind === "proxy-started" || event.kind === "proxy-exit")
        return isValidIdentity(
          {
            pid: event.proxyPid,
            creationUtcTicks: event.proxyCreationUtcTicks,
            imagePath: event.proxyImagePath,
          },
          expectedImagePath,
        );
      if (event.kind === "real-munim-child-started")
        return isValidIdentity(
          {
            pid: event.childPid,
            creationUtcTicks: event.childCreationUtcTicks,
            imagePath: event.childImagePath,
          },
          expectedMunimPath ?? event.realMunimPath,
        );
      if (event.kind === "real-munim-child-exited-after-controlled-kill")
        return (
          isValidIdentity(
            {
              pid: event.proxyPid,
              creationUtcTicks: event.proxyCreationUtcTicks,
              imagePath: event.proxyImagePath,
            },
            expectedImagePath,
          ) &&
          isValidIdentity(
            {
              pid: event.childPid,
              creationUtcTicks: event.childCreationUtcTicks,
              imagePath: event.childImagePath,
            },
            expectedMunimPath ?? event.realMunimPath,
          )
        );
      return true;
    }) &&
    !invalidProxyExit &&
    !invalidChildEvent &&
    !events.some((event) => event.kind === "startup-child-cleanup-failed")
  );
}

function isValidIdentity(
  identity: {
    pid?: number | undefined;
    creationUtcTicks?: string | undefined;
    imagePath?: string | undefined;
  },
  expectedImagePath?: string,
): boolean {
  return (
    Number.isSafeInteger(identity.pid) &&
    identity.pid! > 0 &&
    isValidTicks(identity.creationUtcTicks) &&
    typeof identity.imagePath === "string" &&
    identity.imagePath.length > 0 &&
    (!expectedImagePath || identity.imagePath.toLowerCase() === expectedImagePath.toLowerCase())
  );
}

function isValidTicks(value?: string): boolean {
  return typeof value === "string" && /^[0-9]{1,19}$/u.test(value) && BigInt(value) > 0n;
}

/** Fail closed if either process inventory is incomplete or any new owned image remains. */
export function noNewOwnedProcessesRemain(
  baseline: OwnedProcessIdentity[],
  current: OwnedProcessIdentity[],
  expectedPaths: string[],
  querySucceeded: boolean,
): boolean {
  if (!querySucceeded || expectedPaths.length === 0) return false;
  const paths = new Set(expectedPaths.map((path) => path.toLowerCase()));
  const validInventory = (items: OwnedProcessIdentity[]) =>
    items.every(
      (item) =>
        Number.isSafeInteger(item.pid) &&
        item.pid > 0 &&
        isValidTicks(item.creationUtcTicks) &&
        typeof item.imagePath === "string" &&
        paths.has(item.imagePath.toLowerCase()),
    );
  if (!validInventory(baseline) || !validInventory(current)) return false;
  const baselineKeys = new Set(
    baseline.map((item) => `${item.pid}:${item.creationUtcTicks}:${item.imagePath.toLowerCase()}`),
  );
  return current.every((item) =>
    baselineKeys.has(`${item.pid}:${item.creationUtcTicks}:${item.imagePath.toLowerCase()}`),
  );
}

/** Accept only plain text user content; reject images, unknown blocks, and malformed parts. */
export function normalizeUserTextContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;

  const parts: string[] = [];
  for (const part of content) {
    if (
      typeof part !== "object" ||
      part === null ||
      Array.isArray(part) ||
      !("type" in part) ||
      part.type !== "text" ||
      !("text" in part) ||
      typeof part.text !== "string" ||
      Object.keys(part).length !== 2 ||
      !Object.hasOwn(part, "type") ||
      !Object.hasOwn(part, "text")
    )
      return undefined;
    parts.push(part.text);
  }
  return parts.join("\n");
}

/** Parse the post-guard tool transcript shape: token is the first field on the exact control row. */
export function parseFixtureButtonToken(text: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const rows = text.split(/\r?\n/u).filter((line) => line.includes(`Button "${label}"`));
  if (rows.length !== 1) return undefined;
  return rows[0]?.match(
    new RegExp(`^\\s*(?:-\\s*)?(${OPAQUE_TOKEN})\\s+Button\\s+"${escaped}"\\s*$`, "u"),
  )?.[1];
}
