/**
 * Short mp4 clips of a region of the window, from Chromium's own screencast (what Playwright's
 * video records, but with exact frame times, so a clip shows exactly the moment asked for).
 * Frames are written next to the clip and assembled by ffmpeg at their real durations.
 */
import type { Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type Region = { x: number; y: number; width: number; height: number };

export async function startClip(page: Page, path: string, region: Region) {
  const cdp = await page.context().newCDPSession(page);
  const frames: { data: Buffer; t: number }[] = [];
  cdp.on("Page.screencastFrame", (frame) => {
    frames.push({ data: Buffer.from(frame.data, "base64"), t: frame.metadata.timestamp ?? 0 });
    void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
  return async function stop() {
    await cdp.send("Page.stopScreencast").catch(() => {});
    await cdp.detach().catch(() => {});
    const dir = `${path}.frames`;
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const list: string[] = [];
    for (const [index, frame] of frames.entries()) {
      const name = `${String(index).padStart(5, "0")}.png`;
      await writeFile(join(dir, name), frame.data);
      const next = frames[index + 1]?.t ?? frame.t + 0.5;
      list.push(`file '${name}'`, `duration ${Math.max(0.001, next - frame.t).toFixed(3)}`);
    }
    // the concat demuxer needs the last file repeated to honor its duration
    if (frames.length) list.push(`file '${String(frames.length - 1).padStart(5, "0")}.png'`);
    await writeFile(join(dir, "frames.txt"), `${list.join("\n")}\n`);
    const { x, y, width, height } = region;
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      join(dir, "frames.txt"),
      "-vf",
      `crop=${width}:${height}:${x}:${y},fps=30,format=yuv420p`,
      "-c:v",
      "libx264",
      "-an",
      "-movflags",
      "+faststart",
      path,
    ]);
    await rm(dir, { recursive: true, force: true });
  };
}
