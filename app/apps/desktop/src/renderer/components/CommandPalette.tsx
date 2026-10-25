import { useEffect, useMemo, useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ChatSearchResult } from "@zeno/contracts";
import { MessageSquare } from "lucide-react";
import {
  CHAT_SEARCH_DEBOUNCE_MS,
  chatResultSnippet,
  chatResultTitle,
  searchChats,
} from "../lib/chat-search.ts";
import type { ShellCommand } from "../lib/commands.ts";
import { t, type Locale, type MessageKey } from "../lib/i18n.ts";
import { cn } from "../lib/utils.ts";

export function CommandPalette(props: {
  open: boolean;
  locale: Locale;
  commands: ShellCommand[];
  onClose: () => void;
  /** Search over old chats: a found chat opens like a click in the sidebar. */
  onOpenChat?: (path: string, cwd: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [chats, setChats] = useState<ChatSearchResult[]>([]);
  const tr = (key: MessageKey, vars?: Record<string, string>) => t(props.locale, key, vars);

  useEffect(() => {
    if (!props.open) setQuery("");
  }, [props.open]);

  // Old chats: main reads pi's session files, so wait for a pause in typing.
  useEffect(() => {
    if (!props.onOpenChat) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      void searchChats(query).then((found) => alive && setChats(found));
    }, CHAT_SEARCH_DEBOUNCE_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [query, props.onOpenChat]);

  const groups = useMemo(() => {
    const navigation = props.commands.filter((c) =>
      ["new-thread", "packages", "resources", "settings", "thread"].includes(c.id),
    );
    const editor = props.commands.filter((c) =>
      [
        "focus-composer",
        "fork-thread",
        "toggle-theme",
        "toggle-review",
        "toggle-env-panel",
      ].includes(c.id),
    );
    const rest = props.commands.filter(
      (c) => !navigation.some((n) => n.id === c.id) && !editor.some((e) => e.id === c.id),
    );
    return [
      { id: "nav", heading: tr("command.group.navigation"), items: navigation },
      { id: "editor", heading: tr("command.group.editor"), items: editor },
      ...(rest.length > 0
        ? [{ id: "other", heading: tr("command.group.other"), items: rest }]
        : []),
    ].filter((g) => g.items.length > 0);
  }, [props.commands, props.locale]);

  async function run(command: ShellCommand) {
    props.onClose();
    await command.run();
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        data-testid="command-palette"
        className={cn(
          // Centered in the app window (viewport).
          "top-1/2 left-1/2 z-[11000] w-[min(520px,92vw)] max-w-[calc(100%-2rem)]",
          "translate-x-[-50%] translate-y-[-50%] gap-0 overflow-hidden p-0",
          "rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface-panel)]",
          "text-[var(--foreground)] shadow-[var(--shadow-soft)]",
          "duration-150 data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100",
          // No divider under search input.
          "[&_[data-slot=command-input-wrapper]]:border-0",
        )}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{tr("command.palette.title")}</DialogTitle>
          <DialogDescription>{tr("command.palette.description")}</DialogDescription>
        </DialogHeader>
        <Command
          shouldFilter
          className="rounded-none border-0 bg-transparent shadow-none"
          label={tr("command.palette.title")}
        >
          <CommandInput
            autoFocus
            data-testid="command-palette-input"
            placeholder={tr("command.palette.placeholder")}
            value={query}
            onValueChange={setQuery}
            className="h-11 text-[14px] placeholder:text-[var(--text-subtle)]"
          />
          <CommandList
            data-testid="command-palette-list"
            className="command-palette-scroll max-h-[min(360px,50vh)] px-1 pb-1.5"
          >
            <CommandEmpty className="py-8 text-[13px] text-[var(--text-subtle)]">
              {tr("command.palette.empty")}
            </CommandEmpty>
            {groups.map((group) => (
              <CommandGroup
                key={group.id}
                heading={group.heading}
                className="[&_[cmdk-group-heading]]:group-label [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5"
              >
                {group.items.map((command) => (
                  <CommandItem
                    key={command.id}
                    value={`${command.label} ${command.id}`}
                    data-testid={`command-${command.id}`}
                    onSelect={() => void run(command)}
                    className="gap-2 rounded-[var(--radius-control)] px-2.5 py-2 text-[13px] data-[selected=true]:bg-[var(--hover-fill)] data-[selected=true]:text-[var(--hover-fill-foreground)]"
                  >
                    <span className="min-w-0 flex-1 truncate">{command.label}</span>
                    {command.shortcut ? (
                      <CommandShortcut className="font-mono text-[11px] tracking-wide text-[var(--text-subtle)]">
                        {command.shortcut}
                      </CommandShortcut>
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
            {props.onOpenChat && query.trim() && chats.length > 0 ? (
              <CommandGroup
                heading={tr("features.search.group")}
                data-testid="command-palette-chats"
                className="[&_[cmdk-group-heading]]:group-label [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5"
              >
                {chats.map((chat) => (
                  <CommandItem
                    key={chat.path}
                    value={`chat:${chat.path}`}
                    // Main already matched every word; cmdk must not filter these out again.
                    keywords={[query]}
                    data-testid="command-chat"
                    onSelect={() => {
                      props.onClose();
                      props.onOpenChat?.(chat.path, chat.cwd);
                    }}
                    className="items-start gap-2 rounded-[var(--radius-control)] px-2.5 py-2 text-[13px] data-[selected=true]:bg-[var(--hover-fill)] data-[selected=true]:text-[var(--hover-fill-foreground)]"
                  >
                    <MessageSquare className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{chatResultTitle(props.locale, chat)}</span>
                      {chatResultSnippet(chat) ? (
                        <span className="truncate text-[12px] text-[var(--text-subtle)]">
                          {chatResultSnippet(chat)}
                        </span>
                      ) : null}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
