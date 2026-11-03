import assert from "node:assert/strict";
import {
  eventsShareProcessChain,
  normalizeUserTextContent,
  noNewOwnedProcessesRemain,
  parseFixtureButtonToken,
  proxyLifecycleIsVerified,
  proxyStartsWithoutExit,
} from "./munim-backend-failure-protocol.ts";

const marker = "isolated marker";
assert.equal(normalizeUserTextContent(marker), marker);
assert.equal(
  normalizeUserTextContent([
    { type: "text", text: "isolated " },
    { type: "text", text: "marker" },
  ]),
  "isolated \nmarker",
);
assert.equal(normalizeUserTextContent([{ type: "image_url", image_url: "ignored" }]), undefined);
assert.equal(
  normalizeUserTextContent([
    { type: "text", text: marker },
    { type: "image_url", image_url: "ignored" },
  ]),
  undefined,
);
assert.equal(normalizeUserTextContent([{ type: "unknown", text: marker }]), undefined);
assert.equal(normalizeUserTextContent([{ type: "text", text: 12 }]), undefined);
assert.equal(
  normalizeUserTextContent([{ type: "text", text: marker, extra: "unknown" }]),
  undefined,
);
assert.equal(normalizeUserTextContent({ type: "text", text: marker }), undefined);
const proxyStartOne = { kind: "proxy-started", proxyPid: 11, proxyCreationUtcTicks: "100" };
const proxyStartTwo = { kind: "proxy-started", proxyPid: 22, proxyCreationUtcTicks: "200" };
const proxyExitOne = { kind: "proxy-exit", proxyPid: 11, proxyCreationUtcTicks: "100" };
const proxyExitTwo = { kind: "proxy-exit", proxyPid: 22, proxyCreationUtcTicks: "200" };
assert.deepEqual(proxyStartsWithoutExit([proxyStartOne, proxyExitOne]), []);
assert.deepEqual(proxyStartsWithoutExit([proxyStartOne, proxyExitOne, proxyStartTwo]), [
  proxyStartTwo,
]);
assert.deepEqual(
  proxyStartsWithoutExit([proxyStartOne, proxyExitOne, proxyStartTwo, proxyExitTwo]),
  [],
);
assert.deepEqual(
  proxyStartsWithoutExit([
    proxyStartOne,
    { kind: "proxy-exit", proxyPid: 11, proxyCreationUtcTicks: "101" },
  ]),
  [proxyStartOne],
);
const imageStartOne = {
  ...proxyStartOne,
  proxyCreationUtcTicks: "100",
  proxyImagePath: "C:\\isolated\\proxy.exe",
};
const imageStartTwo = {
  ...proxyStartTwo,
  proxyCreationUtcTicks: "200",
  proxyImagePath: "C:\\isolated\\proxy.exe",
};
const imageExitOne = {
  ...proxyExitOne,
  proxyCreationUtcTicks: "100",
  proxyImagePath: "C:\\isolated\\proxy.exe",
};
const imageExitTwo = {
  ...proxyExitTwo,
  proxyCreationUtcTicks: "200",
  proxyImagePath: "C:\\isolated\\proxy.exe",
};
assert.equal(
  proxyLifecycleIsVerified(
    [imageStartOne, imageExitOne, imageStartTwo, imageExitTwo],
    "c:\\isolated\\proxy.exe",
  ),
  true,
);
assert.equal(
  proxyLifecycleIsVerified([imageStartOne, imageExitOne, imageStartTwo], "C:\\isolated\\proxy.exe"),
  true,
);
assert.equal(
  proxyLifecycleIsVerified([imageStartOne, imageStartTwo], "C:\\isolated\\proxy.exe"),
  true,
  "an absent exit record is acceptable when the OS inventory independently proves cleanup",
);
assert.equal(
  proxyLifecycleIsVerified(
    [{ ...imageStartOne, proxyImagePath: "C:\\foreign\\proxy.exe" }, proxyExitOne],
    "C:\\isolated\\proxy.exe",
  ),
  false,
);
assert.equal(
  proxyLifecycleIsVerified(
    [imageStartOne, imageExitOne, { kind: "startup-child-cleanup-failed", proxyPid: 11 }],
    "C:\\isolated\\proxy.exe",
  ),
  false,
);
const childStarted = {
  ...imageStartOne,
  kind: "real-munim-child-started",
  childPid: 33,
  childCreationUtcTicks: "3300",
  childImagePath: "C:\\isolated\\munim.exe",
  realMunimPath: "C:\\isolated\\munim.exe",
};
const childExited = {
  ...childStarted,
  kind: "real-munim-child-exited-after-controlled-kill",
};
const startupChild = {
  ...imageStartTwo,
  kind: "real-munim-child-started",
  childPid: 44,
  childCreationUtcTicks: "4400",
  childImagePath: "C:\\isolated\\munim.exe",
  realMunimPath: "C:\\isolated\\munim.exe",
};
const startupChildExited = {
  ...startupChild,
  kind: "real-munim-child-exited-after-controlled-kill",
};
const clickForActiveChild = {
  ...childStarted,
  kind: "click-forwarded-to-real-munim",
  requestId: 5,
};
assert.equal(eventsShareProcessChain(childStarted, clickForActiveChild), true);
assert.equal(
  eventsShareProcessChain(startupChild, clickForActiveChild),
  false,
  "a discovery child from another proxy cannot satisfy the active click's evidence",
);
assert.equal(
  proxyLifecycleIsVerified(
    [imageStartOne, childStarted, childExited],
    "C:\\isolated\\proxy.exe",
    "C:\\isolated\\munim.exe",
  ),
  true,
);
assert.equal(
  proxyLifecycleIsVerified(
    [imageStartOne, childStarted, { ...childExited, childCreationUtcTicks: "3301" }],
    "C:\\isolated\\proxy.exe",
    "C:\\isolated\\munim.exe",
  ),
  false,
  "an exit event must match the child PID and exact creation time",
);
assert.equal(
  proxyLifecycleIsVerified(
    [imageStartOne, imageStartTwo, childStarted, startupChild, childExited, startupChildExited],
    "C:\\isolated\\proxy.exe",
    "C:\\isolated\\munim.exe",
  ),
  true,
  "each of multiple proxy sessions can own a distinct real Munim child",
);
assert.equal(
  proxyLifecycleIsVerified(
    [
      imageStartOne,
      imageStartTwo,
      childStarted,
      startupChild,
      childExited,
      {
        ...startupChildExited,
        proxyPid: imageStartOne.proxyPid,
        proxyCreationUtcTicks: imageStartOne.proxyCreationUtcTicks,
        proxyImagePath: imageStartOne.proxyImagePath,
      },
    ],
    "C:\\isolated\\proxy.exe",
    "C:\\isolated\\munim.exe",
  ),
  false,
  "a child-exit event cross-wired to the wrong proxy identity fails closed",
);
assert.equal(
  proxyLifecycleIsVerified(
    [
      imageStartOne,
      imageStartTwo,
      childStarted,
      startupChild,
      childExited,
      { ...startupChildExited, proxyPid: 99, proxyCreationUtcTicks: "9900" },
    ],
    "C:\\isolated\\proxy.exe",
    "C:\\isolated\\munim.exe",
  ),
  false,
  "a child event naming an unknown proxy identity fails closed",
);
assert.equal(
  proxyLifecycleIsVerified(
    [imageStartOne, imageStartOne, childStarted],
    "C:\\isolated\\proxy.exe",
    "C:\\isolated\\munim.exe",
  ),
  false,
  "duplicate proxy identities fail closed",
);
assert.equal(
  proxyLifecycleIsVerified(
    [imageStartOne, imageStartTwo, imageExitOne, imageExitOne],
    "C:\\isolated\\proxy.exe",
  ),
  false,
  "duplicate proxy exit events fail closed",
);
assert.equal(
  proxyLifecycleIsVerified(
    [
      imageStartOne,
      imageStartTwo,
      childStarted,
      { ...startupChild, childPid: 33, childCreationUtcTicks: "3300" },
    ],
    "C:\\isolated\\proxy.exe",
    "C:\\isolated\\munim.exe",
  ),
  false,
  "the same child identity cannot be attributed to two proxy processes",
);
assert.equal(
  proxyLifecycleIsVerified(
    [imageStartOne, childStarted, childStarted],
    "C:\\isolated\\proxy.exe",
    "C:\\isolated\\munim.exe",
  ),
  false,
  "duplicate child identities fail closed",
);
assert.equal(
  proxyLifecycleIsVerified(
    [imageStartOne, childStarted, childExited, childExited],
    "C:\\isolated\\proxy.exe",
    "C:\\isolated\\munim.exe",
  ),
  false,
  "duplicate controlled child-exit events fail closed",
);
assert.equal(
  proxyLifecycleIsVerified(
    [imageStartOne, { ...childStarted, childImagePath: undefined }],
    "C:\\isolated\\proxy.exe",
    "C:\\isolated\\munim.exe",
  ),
  false,
  "an incomplete child identity fails closed",
);

const expectedPaths = ["C:\\isolated\\proxy.exe", "C:\\isolated\\munim.exe"];
const baseline = [
  { pid: 8, creationUtcTicks: "80", imagePath: "C:\\isolated\\proxy.exe" },
  { pid: 9, creationUtcTicks: "90000000", imagePath: "C:\\isolated\\munim.exe" },
];
assert.equal(noNewOwnedProcessesRemain(baseline, baseline, expectedPaths, true), true);
assert.equal(
  noNewOwnedProcessesRemain(
    baseline,
    [...baseline, { pid: 10, creationUtcTicks: "100", imagePath: expectedPaths[1] }],
    expectedPaths,
    true,
  ),
  false,
  "a newly observed child process is detected even when no start event was logged",
);
assert.equal(
  noNewOwnedProcessesRemain(
    baseline,
    [{ pid: 9, creationUtcTicks: "90000001", imagePath: expectedPaths[1] }],
    expectedPaths,
    true,
  ),
  false,
  "PID reuse one 100ns tick later counts as new, even within the same millisecond",
);
assert.equal(noNewOwnedProcessesRemain(baseline, [], expectedPaths, false), false);
assert.equal(
  noNewOwnedProcessesRemain(
    baseline,
    [{ pid: 10, imagePath: expectedPaths[1] }],
    expectedPaths,
    true,
  ),
  false,
  "a process with an incomplete identity fails closed",
);
assert.equal(
  noNewOwnedProcessesRemain(
    baseline,
    [{ pid: 1, creationUtcTicks: "1", imagePath: "C:\\other\\unknown.exe" }],
    expectedPaths,
    true,
  ),
  false,
);
assert.equal(
  noNewOwnedProcessesRemain(
    baseline,
    [{ pid: 10, creationUtcTicks: "100", imagePath: expectedPaths[1] }],
    expectedPaths,
    true,
  ),
  false,
  "a new owned process cannot be assumed absent",
);

const token = "munim_v1.12345678-abcd-1234-abcd-1234567890ab.4";
assert.equal(
  parseFixtureButtonToken(
    `42 (pid 42)\n${token} Button "Start isolated test action"`,
    "Start isolated test action",
  ),
  token,
);
assert.equal(
  parseFixtureButtonToken(
    `42 (pid 42)\n- ${token} Button "Start isolated test action"`,
    "Start isolated test action",
  ),
  token,
);
assert.equal(
  parseFixtureButtonToken(
    'munim_v1 Button "Start isolated test action"',
    "Start isolated test action",
  ),
  undefined,
);
assert.equal(
  parseFixtureButtonToken(`${token} Button "Other action"`, "Start isolated test action"),
  undefined,
);
assert.equal(
  parseFixtureButtonToken(
    `${token} Button "Start isolated test action"\n${token} Button "Start isolated test action"`,
    "Start isolated test action",
  ),
  undefined,
);
process.stdout.write("Munim wrapper token transcript contract passed.\n");
