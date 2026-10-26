// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { PreviewStage } from "./PreviewFrame.tsx";

afterEach(cleanup);

const URL_ = "http://127.0.0.1:41000/site/index.html";
const ready = { source: "prsloy-preview", type: "ready" };

async function stage(sandbox?: string) {
  const onMessage = vi.fn();
  render(
    <PreviewStage
      locale="ru"
      url={URL_}
      device="desktop"
      testId="frame"
      {...(sandbox ? { sandbox } : {})}
      bridge={{ picking: true, onMessage }}
    />,
  );
  const frame = screen.getByTestId("frame") as HTMLIFrameElement;
  const posted: [unknown, string][] = [];
  vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(((m: unknown, o: string) => {
    posted.push([m, o]);
  }) as never);
  await act(async () => {});
  const say = (origin: string, source: unknown = frame.contentWindow) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { data: ready, origin, source: source as Window }),
      );
    });
  return { onMessage, posted, say };
}

describe("PreviewStage bridge", () => {
  it("«Код» (same-origin sandbox): only the page's own origin, commands to it", async () => {
    const { onMessage, posted, say } = await stage("allow-scripts allow-same-origin");
    say("null");
    say("http://127.0.0.1:9");
    expect(onMessage).not.toHaveBeenCalled();
    say("http://127.0.0.1:41000");
    expect(onMessage).toHaveBeenCalledWith({ type: "ready" });
    expect(posted.at(-1)).toEqual([
      { source: "prsloy-host", type: "pick", active: true },
      "http://127.0.0.1:41000",
    ]);
  });

  it("«Дизайн» (scripts-only sandbox): the opaque origin, and only from this frame", async () => {
    const { onMessage, posted, say } = await stage();
    say("http://127.0.0.1:41000");
    say("null", window);
    expect(onMessage).not.toHaveBeenCalled();
    say("null");
    expect(onMessage).toHaveBeenCalledWith({ type: "ready" });
    expect(posted.at(-1)?.[1]).toBe("*");
  });

  it("arms picking once, on «ready»: nothing before it, so a late second «on» cannot undo a pick", async () => {
    const onMessage = vi.fn();
    const view = (picking: boolean) => (
      <PreviewStage
        locale="ru"
        url={URL_}
        device="desktop"
        testId="frame"
        bridge={{ picking, onMessage }}
      />
    );
    const { rerender } = render(view(false));
    const frame = screen.getByTestId("frame") as HTMLIFrameElement;
    const posted: unknown[] = [];
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(((m: unknown) => {
      posted.push(m);
    }) as never);
    // the owner turns picking on while the page is still loading: nothing is sent yet
    rerender(view(true));
    await act(async () => {});
    expect(posted).toEqual([]);
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { data: ready, origin: "null", source: frame.contentWindow }),
      );
    });
    expect(posted).toEqual([{ source: "prsloy-host", type: "pick", active: true }]);
  });
});
