// @vitest-environment jsdom
/**
 * #75: attaching a picture to a model that cannot see must warn before the send and offer a
 * model that can. pi would otherwise swap the picture for
 * «(image omitted: model does not support images)» without a word.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Composer, type ComposerProps } from "./Composer.tsx";

afterEach(cleanup);

const VISION = { provider: "prsloy", id: "deepseek", name: "DeepSeek", input: ["text", "image"] };
const BLIND = { provider: "prsloy", id: "mimo", name: "MiMo", input: ["text"] };

function props(overrides: Partial<ComposerProps> = {}): ComposerProps {
  return {
    locale: "ru",
    prompt: "",
    onPromptChange: vi.fn(),
    onSubmit: vi.fn(),
    onAbort: vi.fn(),
    onKeyDown: vi.fn(),
    running: false,
    composerRef: createRef<HTMLTextAreaElement>(),
    workspacePath: undefined,
    recentWorkspaces: [],
    onOpenProject: vi.fn(),
    onAddProject: vi.fn(),
    accessMode: "default",
    onAccessMode: vi.fn(),
    accessVisibility: { default: true, autoReview: true, full: true },
    modelOptions: [BLIND, VISION],
    modelValue: `${BLIND.provider}/${BLIND.id}`,
    onModelChange: vi.fn(),
    thinkingLevel: "off",
    thinkingLevels: [],
    onThinkingChange: vi.fn(),
    serviceTier: "default",
    serviceTiers: [],
    onServiceTierChange: vi.fn(),
    contextPercent: undefined,
    contextTokens: undefined,
    projectTrusted: true,
    runState: "idle",
    piThemeLabel: "",
    attachments: [],
    onPickAttachments: vi.fn(),
    onRemoveAttachment: vi.fn(),
    slashCommands: [],
    queuedMessages: { steering: [], followUp: [] },
    onClearQueue: vi.fn(),
    ...overrides,
  };
}

describe("composer image warning (#75)", () => {
  it("warns when a picture is attached to a model that cannot see", () => {
    render(<Composer {...props({ attachments: ["/tmp/shot.png"] })} />);
    const warning = screen.getByTestId("composer-image-warning");
    expect(warning.textContent).toContain("MiMo");
    expect(warning.textContent).toContain("не видит картинки");
  });

  it("the offer switches to a model that takes pictures", () => {
    const onModelChange = vi.fn();
    render(<Composer {...props({ attachments: ["/tmp/shot.png"], onModelChange })} />);
    const button = screen.getByTestId("composer-image-warning-switch");
    expect(button.textContent).toContain("DeepSeek");
    fireEvent.click(button);
    expect(onModelChange).toHaveBeenCalledWith(VISION.provider, VISION.id);
  });

  it("stays silent when the model takes pictures or nothing is attached", () => {
    render(
      <Composer {...props({ modelValue: `${VISION.provider}/${VISION.id}`, attachments: ["/tmp/shot.png"] })} />,
    );
    expect(screen.queryByTestId("composer-image-warning")).toBeNull();
    cleanup();
    render(<Composer {...props({ attachments: ["/tmp/notes.md"] })} />);
    expect(screen.queryByTestId("composer-image-warning")).toBeNull();
  });

  it("warns without an offer when no served model takes pictures", () => {
    render(
      <Composer {...props({ attachments: ["/tmp/shot.png"], modelOptions: [BLIND] })} />,
    );
    expect(screen.getByTestId("composer-image-warning")).toBeTruthy();
    expect(screen.queryByTestId("composer-image-warning-switch")).toBeNull();
  });
});
