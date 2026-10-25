/**
 * The «Дизайн» tab's Python children (a6proxy, run.py and its pi agent, setup/pip) get their
 * env from design/env.ts buildHarnessEnv. It is an allowlist; pin that it never lets a
 * machine secret through, by the same patterns the Код agent's scrub uses.
 */
import { describe, expect, it } from "vite-plus/test";
import { buildHarnessEnv } from "../design/env.ts";
import { isSecretEnvName } from "./agent-env.ts";

const secrets: Record<string, string> = {
  GH_TOKEN: "ghp_x",
  GITHUB_TOKEN: "ghs_x",
  OPENAI_API_KEY: "sk-x",
  ANTHROPIC_API_KEY: "sk-ant-x",
  AWS_ACCESS_KEY_ID: "AKIA",
  AWS_SECRET_ACCESS_KEY: "x",
  AZURE_CLIENT_SECRET: "x",
  GOOGLE_APPLICATION_CREDENTIALS: "/x.json",
  NPM_TOKEN: "x",
  STRIPE_SECRET: "x",
  DB_PASSWORD: "x",
  PRSLOY_GATEWAY_KEY: "sk-prsloy-x",
};

describe("design tab child env", () => {
  for (const platform of ["win32", "linux"] as const) {
    it(`drops every machine secret (${platform})`, () => {
      const env = buildHarnessEnv({
        base: { ...secrets, PATH: "/usr/bin", HOME: "/home/u", HTTPS_PROXY: "http://p:1" },
        platform,
        pathDirs: ["/shims"],
        piBin: ["/pi"],
        piAgentDir: "/agent",
        proxyUrl: "http://127.0.0.1:1",
        chromiumOnly: true,
      });
      for (const name of Object.keys(env)) expect(isSecretEnvName(name), name).toBe(false);
      for (const value of Object.values(secrets)) {
        expect(Object.values(env)).not.toContain(value);
      }
      expect(env.HTTPS_PROXY).toBe("http://p:1");
    });
  }
});
