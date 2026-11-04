import { describe, expect, it } from "vite-plus/test";
import {
  COMPUTER_USE_REQUIRED_TOOLS,
  MUNIM_COMPUTER_USE_PACKAGE,
  describeComputerUseTarget,
  missingComputerUseTools,
  munimComputerUseServer,
} from "./computer-use.ts";

describe("PRSLOY computer-use opt-in contract", () => {
  it("uses the pinned Munim package and keeps browser control off", () => {
    expect(munimComputerUseServer()).toEqual({
      command: "npx",
      args: ["--yes", MUNIM_COMPUTER_USE_PACKAGE],
      env: { COMPUTER_USE_BROWSER: "0" },
      packageName: `npm:${MUNIM_COMPUTER_USE_PACKAGE}`,
    });
  });

  it("accepts only an explicit Windows binary path", () => {
    expect(
      munimComputerUseServer({ binaryPath: "C:\\Tools\\munim-computer-use.exe" }),
    ).toMatchObject({
      command: "C:\\Tools\\munim-computer-use.exe",
      env: { COMPUTER_USE_BROWSER: "0" },
    });
    expect(() => munimComputerUseServer({ binaryPath: "C:\\Tools\\other.exe" })).toThrow(
      /must end in munim-computer-use/u,
    );
    expect(() => munimComputerUseServer({ binaryPath: "munim-computer-use.exe" })).toThrow(
      /absolute path/u,
    );
  });

  it("reports an incomplete backend instead of claiming it can act", () => {
    expect(missingComputerUseTools(["list_apps", "get_app_state"])).toEqual([
      "click",
      "type_text",
      "screenshot",
    ]);
    expect(missingComputerUseTools(COMPUTER_USE_REQUIRED_TOOLS)).toEqual([]);
  });

  it("identifies the tested binary without exposing a machine path", () => {
    expect(describeComputerUseTarget("C:\\Tools\\munim-computer-use.exe")).toBe(
      "Munim Computer Use 0.9.0 (munim-computer-use.exe)",
    );
  });
});
