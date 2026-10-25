/**
 * «Дизайн» tab: the owner asks for a page, the design-pipeline harness leads him
 * through it. Owner cards carry pictures/videos and choice buttons; one progress line
 * shows the current step; at the end the built page opens in a sandboxed preview.
 */
import type {
  DesignFile,
  DesignOptionGroup,
  DesignSetupProgress,
  DesignStatus,
} from "@zeno/contracts";
import { FolderOpen, Loader2, Paperclip, RotateCcw, Send, Square, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { unwrapRemoteIpcError } from "../../../shared/ipc-error.ts";
import {
  answerText,
  type DesignItem,
  type DesignView,
  EMPTY_DESIGN_VIEW,
  elapsedMinutes,
  foldDesign,
  openQuestion,
  ownerText,
  RECOMMEND_ANSWER,
  reduceDesign,
  stepOf,
} from "../../lib/design-state.ts";
import { t, type Locale, type MessageKey } from "../../lib/i18n.ts";
import { cn } from "../../lib/utils.ts";
import { Button } from "../ui/button.tsx";
import { Textarea } from "../ui/textarea.tsx";

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
  const workspaceRef = useRef<string | undefined>(undefined);
  const streamRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    // a main-side failure here must not leave a blank tab or a stack trace
    const s = await api.status(projectPath).catch(
      (): DesignStatus => ({
        toolsReady: false,
        setupMb: 0,
        workspace: "",
        running: false,
        history: [],
        needsKey: false,
        available: false,
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
    if (!view.running) return;
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, [view.running]);

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
        className="main-column flex h-full min-w-0 flex-1 items-center justify-center"
        data-testid="design-page"
      >
        <p className="text-lg text-muted-foreground" data-testid="design-unavailable">
          {tr("design.unavailable")}
        </p>
      </section>
    );
  }

  return (
    <section
      className="main-column relative flex h-full min-w-0 flex-1 flex-col"
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
            <SetupCard mb={status.setupMb} progress={setup} tr={tr} onStart={runSetup} />
          ) : view.items.length === 0 ? (
            <h1 className="pt-[18vh] text-center text-2xl font-medium" data-testid="design-empty">
              {tr("design.empty")}
            </h1>
          ) : null}
          {view.items.map((item) => (
            <StreamItem
              key={item.id}
              item={item}
              isLast={item === last}
              running={view.running}
              projectPath={projectPath}
              tr={tr}
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

      {view.running ? <ProgressLine view={view} now={now} tr={tr} /> : null}

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
                onClick={() => void api.cancel(projectPath)}
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
  progress,
  tr,
  onStart,
}: {
  mb: number;
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
      <p className="text-lg">{tr("design.setup.title", { mb: String(mb) })}</p>
      {busy ? (
        <div className="flex w-72 flex-col gap-2">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full rounded-full bg-primary transition-[width] duration-300",
                pct === undefined && "w-1/3 animate-pulse",
              )}
              style={pct === undefined ? undefined : { width: `${Math.max(4, pct)}%` }}
            />
          </div>
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

function ProgressLine({ view, now, tr }: { view: DesignView; now: number; tr: Tr }) {
  const stage = view.stage;
  const step = stage ? stepOf(stage.gate) : undefined;
  const minutes = elapsedMinutes(stage, now);
  return (
    <div className="mx-auto w-full max-w-3xl px-6 pb-2" data-testid="design-progress">
      <div className="flex items-center gap-2 text-sm">
        <Loader2 className="size-4 shrink-0 animate-spin opacity-70" />
        <span className="truncate" data-testid="design-progress-step">
          {step
            ? tr("design.progress", {
                n: String(step.index),
                total: String(step.total),
                title: tr(step.key),
              })
            : tr("design.progress.working")}
        </span>
        {minutes > 0 ? (
          <span className="shrink-0 text-muted-foreground">
            · {tr("design.progress.minutes", { n: String(minutes) })}
          </span>
        ) : null}
      </div>
      <div
        className="mt-0.5 truncate pl-6 font-mono text-xs text-muted-foreground/70"
        data-testid="design-ticker"
      >
        {view.ticker.at(-1) ?? " "}
      </div>
    </div>
  );
}

function Media({ file }: { file: DesignFile }) {
  if (file.kind === "image") {
    return (
      <a href={file.url} target="_blank" rel="noreferrer" className="block">
        <img
          src={file.url}
          alt=""
          className="max-h-[420px] w-full rounded-lg border object-contain"
          data-testid="design-image"
        />
      </a>
    );
  }
  if (file.kind === "video") {
    return (
      <video
        src={file.url}
        controls
        loop
        muted
        playsInline
        className="w-full rounded-lg border"
        data-testid="design-video"
      />
    );
  }
  return null;
}

function StreamItem({
  item,
  isLast,
  running,
  projectPath,
  tr,
  onAnswer,
  onRetry,
  onContinue,
}: {
  item: DesignItem;
  isLast: boolean;
  running: boolean;
  projectPath: string | undefined;
  tr: Tr;
  onAnswer: (text: string) => void;
  onRetry: () => void;
  onContinue: () => void;
}) {
  const live = isLast && !running;
  switch (item.kind) {
    case "user":
      return (
        <div className="flex flex-col items-end gap-1" data-testid="design-user">
          {item.text ? (
            <p className="max-w-[80%] rounded-2xl bg-secondary px-4 py-2 whitespace-pre-wrap text-secondary-foreground">
              {item.text}
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
    case "owner": {
      const text = ownerText(item.text, item.files, item.options);
      const media = item.files.filter((f) => f.kind === "image" || f.kind === "video");
      const open = live && !item.answered;
      return (
        <article
          className="flex flex-col gap-3 rounded-xl border bg-card p-4"
          data-testid="design-owner"
        >
          {text ? <p className="whitespace-pre-wrap leading-relaxed">{text}</p> : null}
          {media.length > 0 ? (
            <div className={cn("grid gap-2", media.length > 1 && "sm:grid-cols-2")}>
              {media.map((f) => (
                <Media key={f.path} file={f} />
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
          <p>{tr(item.kind === "stuck" ? "design.stuck" : "design.error")}</p>
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
      return (
        <div className="flex items-center gap-3" data-testid={`design-${item.kind}`}>
          <p className="text-muted-foreground">
            {tr(item.kind === "paused" ? "design.paused" : "design.cancelled")}
          </p>
          {live ? (
            <Button variant="outline" size="sm" data-testid="design-continue" onClick={onContinue}>
              {tr("design.continue")}
            </Button>
          ) : null}
        </div>
      );
    case "done":
      return <DoneCard projectPath={projectPath} tr={tr} />;
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
                  <span className="font-semibold">{o.key}</span>
                  <span>{o.label}</span>
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
        <Button
          variant="secondary"
          size="sm"
          data-testid="design-recommend"
          onClick={() => onAnswer(RECOMMEND_ANSWER)}
        >
          {tr("design.recommend")}
        </Button>
      </div>
    </div>
  );
}

function DoneCard({ projectPath, tr }: { projectPath: string | undefined; tr: Tr }) {
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
  const frame = useMemo(
    () =>
      url ? (
        <iframe
          src={url}
          title={tr("design.preview")}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          className="h-[70vh] w-full rounded-lg border bg-white"
          data-testid="design-preview"
        />
      ) : null,
    [url, tr],
  );
  return (
    <div className="flex flex-col gap-3" data-testid="design-done">
      <div className="flex items-center justify-between gap-3">
        <p className="font-medium">{tr("design.done")}</p>
        <Button
          variant="outline"
          size="sm"
          data-testid="design-open-folder"
          onClick={() => void api.openFolder(projectPath)}
        >
          <FolderOpen />
          {tr("design.openFolder")}
        </Button>
      </div>
      {frame}
    </div>
  );
}
