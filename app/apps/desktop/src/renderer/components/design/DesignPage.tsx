/**
 * «Дизайн» tab: the owner asks for a page, the design-pipeline harness leads him
 * through it. Owner cards carry pictures/videos and choice buttons; one progress line
 * shows the current step; at the end the built page opens in a sandboxed preview.
 */
import type {
  DesignEditPin,
  DesignFile,
  DesignOptionGroup,
  DesignSetupProgress,
  DesignStatus,
} from "@zeno/contracts";
import {
  Check,
  Download,
  ExternalLink,
  FolderOpen,
  Loader2,
  Paperclip,
  Pencil,
  RotateCcw,
  Send,
  SlidersHorizontal,
  Square,
  X,
} from "lucide-react";
import { ImagePreviewDialog } from "../ContentPreviewDialog.tsx";
import {
  addPin,
  type EditPin,
  parseTextMessage,
  pinsToSend,
  type TextRefusal,
} from "../../lib/design-edit.ts";
import { EditPanel } from "./EditPanel.tsx";
import { TokenPanel } from "./TokenPanel.tsx";
import { type PreviewDevice, PreviewDeviceSwitch, PreviewStage } from "../PreviewFrame.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { unwrapRemoteIpcError } from "../../../shared/ipc-error.ts";
import {
  answerText,
  type DesignItem,
  type DesignView,
  editAnswer,
  editOptions,
  EMPTY_DESIGN_VIEW,
  foldDesign,
  harnessNow,
  isLetterKey,
  optionLabel,
  openQuestion,
  ownerText,
  RECOMMEND_ANSWER,
  reduceDesign,
} from "../../lib/design-state.ts";
import { t, type Locale, type MessageKey } from "../../lib/i18n.ts";
import { cn } from "../../lib/utils.ts";
import { Button } from "../ui/button.tsx";
import { Textarea } from "../ui/textarea.tsx";
import { ConfirmDialog } from "../ConfirmDialog.tsx";
import { CONFIRM_STOP_AFTER_MS } from "../../lib/design-progress.ts";
import { FigCaption } from "../FigCaption.tsx";
import { LineLoader } from "../motion/LineLoader.tsx";
import { DesignProgress } from "./DesignProgress.tsx";

type Props = { locale: Locale; projectPath: string | undefined };
type Picked = { token: string; name: string };

export function DesignPage({ locale, projectPath }: Props) {
  const tr = useCallback(
    (key: MessageKey, vars?: Record<string, string>) => t(locale, key, vars),
    [locale],
  );
  const api = window.zeno.design;
  const [status, setStatus] = useState<DesignStatus | undefined>();
  const [view, setView] = useState<DesignView>(EMPTY_DESIGN_VIEW);
  const [setup, setSetup] = useState<DesignSetupProgress | undefined>();
  const [draft, setDraft] = useState("");
  const [picked, setPicked] = useState<Picked[]>([]);
  const [sendError, setSendError] = useState<string | undefined>();
  const [now, setNow] = useState(() => Date.now());
  const [stopping, setStopping] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const workspaceRef = useRef<string | undefined>(undefined);
  const streamRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    // a main-side failure here must not leave a blank tab or a stack trace
    const s = await api.status(projectPath).catch(
      (): DesignStatus => ({
        toolsReady: false,
        setupMb: 0,
        setupDiskMb: 0,
        workspace: "",
        running: false,
        history: [],
        needsKey: false,
        available: false,
        canImportTools: false,
      }),
    );
    workspaceRef.current = s.workspace;
    setStatus(s);
    setView(foldDesign(s.history, s.running));
  }, [api, projectPath]);

  useEffect(() => {
    void refresh();
    const offEvent = api.onEvent((msg) => {
      if (msg.workspace !== workspaceRef.current) return;
      setView((v) => reduceDesign(v, msg.event));
    });
    const offSetup = api.onSetup((p) => setSetup(p));
    return () => {
      offEvent();
      offSetup();
    };
  }, [api, refresh]);

  useEffect(() => {
    if (!view.running) {
      setStopping(false);
      return;
    }
    const id = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(id);
  }, [view.running]);

  // «Остановить»: a turn that has run a while asks first; until the run exits, «Останавливаю…».
  const stop = useCallback(() => {
    setStopping(true);
    void api.cancel(projectPath).catch(() => setStopping(false));
  }, [api, projectPath]);
  const requestStop = useCallback(() => {
    const since = view.stage?.stepSince;
    const ranFor = since === undefined ? 0 : harnessNow(view, Date.now()) - since;
    if (ranFor >= CONFIRM_STOP_AFTER_MS) setConfirmStop(true);
    else stop();
  }, [view, stop]);

  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [view.items.length, view.running]);

  const send = useCallback(
    async (text: string, tokens: string[] = [], retry = false) => {
      setSendError(undefined);
      try {
        await api.say(projectPath, text, tokens, retry);
      } catch (error) {
        setSendError(unwrapRemoteIpcError(error instanceof Error ? error.message : String(error)));
      }
    },
    [api, projectPath],
  );

  // «Править» → «Применить»: an error stays in the edit panel, next to the marks it is about
  const edit = useCallback(
    async (pins: DesignEditPin[]) => {
      try {
        await api.edit(projectPath, pins);
      } catch (error) {
        throw new Error(
          unwrapRemoteIpcError(error instanceof Error ? error.message : String(error)),
        );
      }
    },
    [api, projectPath],
  );

  const submit = useCallback(() => {
    const text = draft.trim();
    if (!text && picked.length === 0) return;
    setDraft("");
    setPicked([]);
    void send(
      text,
      picked.map((p) => p.token),
    );
  }, [draft, picked, send]);

  const runSetup = useCallback(async () => {
    setSetup({ phase: "venv" });
    const result = await api.setup().catch(
      (error: unknown): DesignSetupProgress => ({
        phase: "error",
        error: unwrapRemoteIpcError(error instanceof Error ? error.message : String(error)),
      }),
    );
    setSetup(result);
    if (result.phase === "done") void refresh();
  }, [api, refresh]);

  const question = openQuestion(view);
  const last = view.items.at(-1);

  if (!status) return <div className="flex-1" data-testid="design-page" />;
  if (!status.available) {
    return (
      <section
        className="design-page main-column flex h-full min-w-0 flex-1 items-center justify-center"
        data-testid="design-page"
      >
        <UnavailableCard canImport={status.canImportTools} onImported={refresh} tr={tr} />
      </section>
    );
  }

  return (
    <section
      className="design-page main-column relative flex h-full min-w-0 flex-1 flex-col"
      data-testid="design-page"
    >
      <div ref={streamRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-8">
          {status.needsKey ? (
            <p className="text-sm text-muted-foreground" data-testid="design-needs-key">
              {tr("design.needsKey")}
            </p>
          ) : null}
          {!status.toolsReady ? (
            <SetupCard
              mb={status.setupMb}
              diskMb={status.setupDiskMb}
              progress={setup}
              tr={tr}
              onStart={runSetup}
            />
          ) : view.items.length === 0 ? (
            <div className="flex flex-col items-center gap-3 pt-[18vh]">
              <FigCaption locale={locale} n={2} label={tr("fig.design")} />
              <h1 className="design-hero text-center" data-testid="design-empty">
                {tr("design.empty")}
              </h1>
            </div>
          ) : null}
          {view.items.map((item) => (
            <StreamItem
              key={item.id}
              locale={locale}
              item={item}
              isLast={item === last}
              running={view.running}
              projectPath={projectPath}
              tr={tr}
              onEdit={edit}
              onAnswer={(text) => {
                // files attached before a button answer go with it
                setPicked([]);
                void send(
                  text,
                  picked.map((p) => p.token),
                );
              }}
              onRetry={() => void send("", [], true)}
              onContinue={() => void send("")}
            />
          ))}
        </div>
      </div>

      {view.running ? (
        <DesignProgress view={view} now={now} tr={tr} stopping={stopping} onStop={requestStop} />
      ) : null}
      <ConfirmDialog
        open={confirmStop}
        title={tr("design.stop.confirmTitle")}
        message={tr("design.stop.confirmBody")}
        confirmLabel={tr("design.stop.button")}
        cancelLabel={tr("design.stop.keep")}
        testId="design-stop-confirm"
        onConfirm={() => {
          setConfirmStop(false);
          stop();
        }}
        onCancel={() => setConfirmStop(false)}
      />

      {status.toolsReady ? (
        <footer className="mx-auto w-full max-w-3xl px-6 pb-5">
          {sendError ? (
            <p className="mb-2 text-sm text-destructive" data-testid="design-send-error">
              {sendError}
            </p>
          ) : null}
          {picked.length > 0 ? (
            <ul className="mb-2 flex flex-wrap gap-1.5" data-testid="design-attachments">
              {picked.map((p) => (
                <li
                  key={p.token}
                  className="flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs"
                >
                  <span className="max-w-48 truncate">{p.name}</span>
                  <button
                    type="button"
                    aria-label={tr("design.removeFile")}
                    className="opacity-60 hover:opacity-100"
                    onClick={() => setPicked((all) => all.filter((x) => x.token !== p.token))}
                  >
                    <X className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex items-end gap-2 rounded-xl border bg-background p-2 shadow-xs">
            <Button
              variant="ghost"
              size="icon-sm"
              title={tr("design.attach")}
              aria-label={tr("design.attach")}
              data-testid="design-attach"
              disabled={view.running}
              onClick={() =>
                void api.pickFiles().then((files) => setPicked((all) => [...all, ...files]))
              }
            >
              <Paperclip />
            </Button>
            <Textarea
              data-testid="design-input"
              className="max-h-48 min-h-9 flex-1 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
              placeholder={view.items.length === 0 ? tr("design.placeholder") : ""}
              value={draft}
              disabled={view.running}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            {view.running ? (
              <Button
                variant="outline"
                size="icon-sm"
                title={tr("design.stop")}
                aria-label={tr("design.stop")}
                data-testid="design-stop"
                disabled={stopping}
                onClick={requestStop}
              >
                <Square className="fill-current" />
              </Button>
            ) : (
              <Button
                size="icon-sm"
                title={tr("design.send")}
                aria-label={tr("design.send")}
                data-testid="design-send"
                disabled={!draft.trim() && picked.length === 0}
                onClick={submit}
              >
                <Send />
              </Button>
            )}
          </div>
          {question ? <span className="sr-only" data-testid="design-awaiting" /> : null}
        </footer>
      ) : null}
    </section>
  );
}

type Tr = (key: MessageKey, vars?: Record<string, string>) => string;

function SetupCard({
  mb,
  diskMb,
  progress,
  tr,
  onStart,
}: {
  mb: number;
  diskMb: number;
  progress: DesignSetupProgress | undefined;
  tr: Tr;
  onStart: () => void;
}) {
  const busy = progress && progress.phase !== "error" && progress.phase !== "done";
  const pct =
    progress?.phase === "download" && progress.totalBytes
      ? Math.round(((progress.doneBytes ?? 0) / progress.totalBytes) * 100)
      : progress?.phase === "install"
        ? 100
        : undefined;
  const mbOf = (b: number | undefined) => String(Math.round((b ?? 0) / 1024 / 1024));
  const phaseText =
    progress?.phase === "venv"
      ? tr("design.setup.venv")
      : progress?.phase === "download"
        ? tr("design.setup.download", {
            done: mbOf(progress.doneBytes),
            total: mbOf(progress.totalBytes),
          })
        : progress?.phase === "install"
          ? tr("design.setup.install")
          : progress?.phase === "browser"
            ? tr("design.setup.browser")
            : undefined;
  return (
    <div
      className="mt-[14vh] flex flex-col items-center gap-4 text-center"
      data-testid="design-setup"
      data-phase={progress?.phase ?? "idle"}
    >
      <p className="design-heading">
        {tr("design.setup.title", { mb: String(mb), disk: String(diskMb) })}
      </p>
      {busy ? (
        <div className="flex w-72 flex-col gap-2">
          <LineLoader
            testId="design-setup-loader"
            label={phaseText}
            {...(pct === undefined ? {} : { value: Math.max(4, pct) / 100 })}
          />
          <p className="text-sm text-muted-foreground">{phaseText}</p>
        </div>
      ) : (
        <>
          {progress?.phase === "error" ? (
            <p className="max-w-md text-sm text-destructive" data-testid="design-setup-error">
              {progress.error}
            </p>
          ) : null}
          <Button data-testid="design-setup-start" onClick={onStart}>
            {progress?.phase === "error" ? tr("design.retry") : tr("design.setup.start")}
          </Button>
        </>
      )}
    </div>
  );
}

function Media({ file, locale }: { file: DesignFile; locale: Locale }) {
  const [open, setOpen] = useState(false);
  if (file.kind === "image") {
    return (
      <>
        <button
          type="button"
          className="design-media-button"
          aria-label={t(locale, "timeline.imagePreview")}
          onClick={() => setOpen(true)}
        >
          <img src={file.url} alt="" className="design-media" data-testid="design-image" />
        </button>
        <ImagePreviewDialog open={open} onOpenChange={setOpen} source={file.url} locale={locale} />
      </>
    );
  }
  if (file.kind === "video") {
    // Short muted loops of the movement candidates: they play by themselves. A paused video with
    // only its metadata loaded kept Chromium's loading ring over the poster on Windows.
    return (
      <video
        src={file.url}
        controls
        autoPlay
        loop
        muted
        playsInline
        preload="auto"
        className="design-media"
        data-testid="design-video"
      />
    );
  }
  return null;
}

function StreamItem({
  locale,
  item,
  isLast,
  running,
  projectPath,
  tr,
  onAnswer,
  onEdit,
  onRetry,
  onContinue,
}: {
  locale: Locale;
  item: DesignItem;
  isLast: boolean;
  running: boolean;
  projectPath: string | undefined;
  tr: Tr;
  onAnswer: (text: string) => void;
  onEdit: (pins: DesignEditPin[]) => Promise<void>;
  onRetry: () => void;
  onContinue: () => void;
}) {
  const live = isLast && !running;
  switch (item.kind) {
    case "user": {
      // run.py's buttons after an edit are keys; the owner sees what he pressed
      const pressed = editAnswer(item.text);
      return (
        <div className="flex flex-col items-end gap-1" data-testid="design-user">
          {item.text ? (
            <p className="max-w-[80%] rounded-2xl bg-secondary px-4 py-2 whitespace-pre-wrap text-secondary-foreground">
              {pressed
                ? tr(pressed === "keep" ? "design.edit.keep" : "design.edit.revert")
                : item.text}
            </p>
          ) : null}
          {item.files.length > 0 ? (
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Paperclip className="size-3" />
              {item.files.join(", ")}
            </p>
          ) : null}
        </div>
      );
    }
    case "owner": {
      const text = ownerText(item.text, item.files, item.options);
      const media = item.files.filter((f) => f.kind === "image" || f.kind === "video");
      const open = live && !item.answered;
      return (
        <article className="design-card flex flex-col gap-3 p-5" data-testid="design-owner">
          {text ? <p className="whitespace-pre-wrap leading-relaxed">{text}</p> : null}
          {media.length > 0 ? (
            <div className={cn("grid gap-2", media.length > 1 && "sm:grid-cols-2")}>
              {media.map((f) => (
                <Media key={f.path} file={f} locale={locale} />
              ))}
            </div>
          ) : null}
          {open ? <OwnerChoices groups={item.options} tr={tr} onAnswer={onAnswer} /> : null}
        </article>
      );
    }
    case "stuck":
    case "error":
      return (
        <div className="flex flex-col gap-2" data-testid={`design-${item.kind}`}>
          <p className="design-heading">
            {tr(item.kind === "stuck" ? "design.stuck" : "design.error")}
          </p>
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none">{tr("design.details")}</summary>
            <p className="mt-1 whitespace-pre-wrap">{item.detail}</p>
          </details>
          {live ? (
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              data-testid="design-retry"
              onClick={item.kind === "stuck" ? onRetry : onContinue}
            >
              <RotateCcw />
              {tr("design.retry")}
            </Button>
          ) : null}
        </div>
      );
    case "paused":
    case "cancelled":
    case "interrupted":
      return (
        <div className="flex items-center gap-3" data-testid={`design-${item.kind}`}>
          <p className="text-muted-foreground">
            {tr(
              item.kind === "paused"
                ? "design.paused"
                : item.kind === "interrupted"
                  ? "design.interrupted"
                  : "design.cancelled",
            )}
          </p>
          {live ? (
            <Button variant="outline" size="sm" data-testid="design-continue" onClick={onContinue}>
              {tr("design.continue")}
            </Button>
          ) : null}
        </div>
      );
    case "done":
      // after an edit the stream has several: the page and its controls only under the last one
      return isLast ? (
        <DoneCard projectPath={projectPath} tr={tr} locale={locale} live={live} onEdit={onEdit} />
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="design-done-past">
          {tr("design.done")}
        </p>
      );
  }
}

/**
 * Answer buttons, one row per question. One question answers on click; several collect a
 * pick per row and send them together ("1А 2Б"). «Как рекомендуешь» always closes the card.
 */
function OwnerChoices({
  groups,
  tr,
  onAnswer,
}: {
  groups: DesignOptionGroup[];
  tr: Tr;
  onAnswer: (text: string) => void;
}) {
  const [picks, setPicks] = useState<Record<number, string>>({});
  const multi = groups.length > 1;
  const answer = answerText(groups, picks);
  return (
    <div className="flex flex-col gap-3" data-testid="design-options">
      {groups.map((g, gi) => (
        <div key={gi} className="flex flex-col gap-1.5" data-testid={`design-question-${gi + 1}`}>
          {multi && g.q ? <p className="text-sm text-muted-foreground">{g.q}</p> : null}
          <div className="flex flex-wrap gap-2">
            {g.options.map((o) => {
              const picked = picks[gi] === o.key;
              return (
                <Button
                  key={o.key}
                  variant={picked ? "default" : "outline"}
                  size="sm"
                  aria-pressed={multi ? picked : undefined}
                  className="h-auto max-w-full py-1.5 text-left whitespace-normal"
                  data-testid={`design-option-${o.key}`}
                  onClick={() => {
                    const next = { ...picks, [gi]: o.key };
                    if (!multi) onAnswer(answerText(groups, next) ?? o.key);
                    else setPicks(next);
                  }}
                >
                  {isLetterKey(o.key) ? <span className="font-semibold">{o.key}</span> : null}
                  {optionLabel(o) ? <span>{optionLabel(o)}</span> : null}
                  {o.recommended ? (
                    <span className="text-xs opacity-60">{tr("design.recommended")}</span>
                  ) : null}
                </Button>
              );
            })}
          </div>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        {multi ? (
          <Button
            size="sm"
            disabled={!answer}
            data-testid="design-answer"
            onClick={() => answer && onAnswer(answer)}
          >
            {tr("design.answer")}
          </Button>
        ) : null}
        {/* after an edit run.py takes only its own two keys: «как рекомендуешь» would start a step */}
        {editOptions(groups) ? null : (
          <Button
            variant="secondary"
            size="sm"
            data-testid="design-recommend"
            onClick={() => onAnswer(RECOMMEND_ANSWER)}
          >
            {tr("design.recommend")}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Builds without the private pipeline: one calm line, and the owner's own tools file if he has it. */
function UnavailableCard({
  canImport,
  onImported,
  tr,
}: {
  canImport: boolean;
  onImported: () => Promise<void>;
  tr: Tr;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pick = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const res = await window.zeno.design.importTools();
      if (res?.ok) await onImported();
      else if (res) setError(res.error);
    } catch (e) {
      setError(unwrapRemoteIpcError(e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <p className="design-heading text-muted-foreground" data-testid="design-unavailable">
        {tr("design.unavailable")}
      </p>
      {canImport ? (
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          disabled={busy}
          data-testid="design-import-tools"
          onClick={() => void pick()}
        >
          {busy ? <Loader2 className="animate-spin" /> : null}
          {tr("design.importTools")}
        </Button>
      ) : null}
      {error ? (
        <p className="text-sm text-muted-foreground" role="alert" data-testid="design-import-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function DoneCard({
  projectPath,
  tr,
  locale,
  live,
  onEdit,
}: {
  projectPath: string | undefined;
  tr: Tr;
  locale: Locale;
  live: boolean;
  onEdit: (pins: DesignEditPin[]) => Promise<void>;
}) {
  const api = window.zeno.design;
  const [url, setUrl] = useState<string | null | undefined>();
  useEffect(() => {
    let alive = true;
    void api
      .preview(projectPath)
      .then((r) => alive && setUrl(r?.url ?? null))
      .catch(() => alive && setUrl(null));
    return () => {
      alive = false;
    };
  }, [api, projectPath]);
  const [device, setDevice] = useState<PreviewDevice>("desktop");
  const [saved, setSaved] = useState(false);
  const [tweaking, setTweaking] = useState(false);
  // «Править»: the page from the inspecting server, marks and the owner's words
  const [editing, setEditing] = useState(false);
  const [editUrl, setEditUrl] = useState<string>();
  const [picking, setPicking] = useState(false);
  const [pins, setPins] = useState<EditPin[]>([]);
  useEffect(() => {
    if (!editing || editUrl) return;
    let alive = true;
    void api
      .preview(projectPath, true)
      .then((r) => alive && setEditUrl(r?.url))
      .catch(() => alive && setEditing(false));
    return () => {
      alive = false;
    };
  }, [api, projectPath, editing, editUrl]);
  // text retyped on the page: main writes it only where the place is certain; the page reloads either way
  const stageRef = useRef<HTMLDivElement>(null);
  const [textNote, setTextNote] = useState<{ ok: boolean; text: string }>();
  useEffect(() => {
    if (!editing) return;
    const refused: Record<TextRefusal, MessageKey> = {
      nested: "design.edit.refused.nested",
      move: "design.edit.refused.move",
      unmarked: "design.edit.refused.unmarked",
    };
    const listener = (event: MessageEvent) => {
      const frame = stageRef.current?.querySelector("iframe")?.contentWindow;
      // the design preview is a scripts-only sandbox: its messages come from the opaque "null" origin
      if (!frame || event.source !== frame || event.origin !== "null") return;
      const message = parseTextMessage(event.data);
      if (!message) return;
      if (message.type === "text-refused") {
        setTextNote({ ok: false, text: tr(refused[message.reason]) });
        return;
      }
      const { type: _type, ...edit } = message;
      void api
        .editText(projectPath, edit)
        .then((r) =>
          setTextNote(
            r.ok ? { ok: true, text: tr("design.edit.textSaved") } : { ok: false, text: r.error },
          ),
        )
        .catch((e: unknown) =>
          setTextNote({
            ok: false,
            text: unwrapRemoteIpcError(e instanceof Error ? e.message : String(e)),
          }),
        )
        .finally(() => setShown((n) => n + 1));
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [api, projectPath, editing, tr]);
  const startEdit = (on: boolean) => {
    setTextNote(undefined);
    setEditing(on);
    setPicking(on);
    setPins([]);
    if (on) setTweaking(false);
  };
  // «Настроить» shows values by reloading the page main serves with them
  const [shown, setShown] = useState(0);
  const shownUrl = editing ? editUrl : url;
  const frame = useMemo(
    () =>
      shownUrl ? (
        <PreviewStage
          locale={locale}
          url={shown ? `${shownUrl}?v=${shown}` : shownUrl}
          device={device}
          testId="design-preview"
          {...(editing
            ? {
                bridge: {
                  picking,
                  onMessage: (m) => {
                    if (m.type === "picked") {
                      setPins((all) => addPin(all, m));
                      setPicking(false);
                    } else if (m.type === "pick-cancel") setPicking(false);
                  },
                },
              }
            : {})}
        />
      ) : null,
    [shownUrl, locale, device, shown, editing, picking],
  );
  return (
    <div className="flex flex-col gap-3" data-testid="design-done">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="design-heading">{tr("design.done")}</p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {url ? (
            <PreviewDeviceSwitch
              locale={locale}
              device={device}
              onChange={setDevice}
              testIdPrefix="design"
            />
          ) : null}
          <Button
            variant="outline"
            size="sm"
            data-testid="design-open-folder"
            onClick={() => void api.openFolder(projectPath)}
          >
            <FolderOpen />
            {tr("design.openFolder")}
          </Button>
          {url ? (
            <Button
              variant={tweaking ? "secondary" : "outline"}
              size="sm"
              aria-pressed={tweaking}
              data-testid="design-tweak-open"
              onClick={() => {
                setTweaking((v) => !v);
                if (editing) startEdit(false);
              }}
            >
              <SlidersHorizontal />
              {tr("design.tweak")}
            </Button>
          ) : null}
          {url && live ? (
            <Button
              variant={editing ? "secondary" : "outline"}
              size="sm"
              aria-pressed={editing}
              data-testid="design-edit-open"
              onClick={() => startEdit(!editing)}
            >
              <Pencil />
              {tr("design.edit")}
            </Button>
          ) : null}
          {url ? (
            <Button
              variant="outline"
              size="sm"
              data-testid="design-open-browser"
              onClick={() => void api.openInBrowser(projectPath)}
            >
              <ExternalLink />
              {tr("design.openInBrowser")}
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            data-testid="design-download-zip"
            onClick={() =>
              void api
                .exportZip(projectPath)
                .then((r) => setSaved(!!r))
                .catch(() => setSaved(false))
            }
          >
            {saved ? <Check /> : <Download />}
            {tr(saved ? "design.zipSaved" : "design.downloadZip")}
          </Button>
        </div>
      </div>
      {tweaking && url ? (
        <TokenPanel
          projectPath={projectPath}
          tr={tr}
          onPreview={() => setShown((n) => n + 1)}
          onClose={() => setTweaking(false)}
        />
      ) : null}
      {editing && url ? (
        <EditPanel
          pins={pins}
          picking={picking}
          {...(textNote ? { note: textNote } : {})}
          tr={tr}
          onPick={() => setPicking(true)}
          onChange={setPins}
          onApply={async () => {
            await onEdit(pinsToSend(pins, device === "phone" ? 390 : 1440));
            startEdit(false);
          }}
          onCancel={() => startEdit(false)}
        />
      ) : null}
      <div ref={stageRef}>{frame}</div>
    </div>
  );
}
