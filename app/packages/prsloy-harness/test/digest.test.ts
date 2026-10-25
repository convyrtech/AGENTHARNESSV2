import { describe, expect, it } from "vite-plus/test";
import { buildDigest } from "../src/digest.ts";

const date = new Date("2026-10-25T12:00:00Z");

describe("digest «прошлый раз» (S6)", () => {
  it("files, preview and check in one short Russian line", () => {
    expect(
      buildDigest({
        date,
        files: ["index.html", "style.css", "index.html"],
        servers: [{ command: "python3 -m http.server 8099", ports: [8099] }],
        check: { label: "npm run test", green: true },
      }),
    ).toBe(
      "Прошлый раз (25.10.2026): правили index.html, style.css. Превью: python3 -m http.server 8099 (порт 8099). Проверка проекта (npm run test): зелёная.",
    );
  });

  it("no check — said so; many files — «и ещё N»; ≤600 characters; secrets scrubbed", () => {
    const text = buildDigest({
      date,
      files: Array.from({ length: 9 }, (_, i) => `f${i}.js`),
      servers: [
        {
          command: `node server.js --key ${["sk", "live", "0123456789abcdefghijkl"].join("_")}`,
          ports: [],
        },
      ],
    });
    expect(text).toContain("правили f0.js, f1.js, f2.js, f3.js, f4.js, f5.js и ещё 3.");
    expect(text).toContain("Проверки проекта нет.");
    expect(text).not.toContain("0123456789abcdefghijkl");
    expect(text.length).toBeLessThanOrEqual(600);
  });

  it("nothing changed and no preview — nothing to write (the previous digest stays)", () => {
    expect(buildDigest({ date, files: [], servers: [] })).toBe("");
  });
});
