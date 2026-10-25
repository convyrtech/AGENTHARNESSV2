/**
 * «Память» (research/18 §6, STATUS-harness S4/S5): what the agent remembers about the owner
 * («Обо мне») and the open project («Об этом проекте»). Files live in the agent folder
 * (`prsloy-memory/`); main reads and changes them through the harness's `MemoryStore`
 * (IPC `prsloy:memory-*`, core). Each call returns the fresh snapshot.
 */
export type MemoryItem = {
  id: string;
  text: string;
  created?: string;
  /**
   * Memory v2 (research/24 §3.6), optional until core's M-1: «вы просили» (`user`) or «заметил сам»
   * (`auto`), the owner's words it came from, and «Закрепить».
   */
  origin?: "user" | "auto";
  quote?: string;
  pinned?: boolean;
  /** Where it was learned (research/27 §2): the session id, for «Забыть всё из этого чата». */
  sessions?: string[];
};

/** «Было» (research/24 §3.6): replaced, expired or forgotten, with «Вернуть» by the journal `opId`. */
export type MemoryHistoryItem = {
  opId: string;
  scope: "user" | "project";
  kind: "replaced" | "expired" | "forgotten";
  /** What it was. */
  text: string;
  /** For `replaced`: what it is now. */
  now?: string;
  at: string;
};

/** Forgotten, still in the tombstones: «Вернуть» brings it back (text from the journal). */
export type MemoryForgottenItem = {
  id: string;
  scope: "user" | "project";
  text: string;
  forgotten: string;
};

export type MemorySnapshot = {
  user: MemoryItem[];
  /** Empty without an open project. */
  project: MemoryItem[];
  /** «Что было в прошлый раз» (S6): written by the harness's code, not the owner. */
  digest?: { text: string; updated: string };
  /** Newest first, up to 20. */
  forgotten: MemoryForgottenItem[];
  /** Memory v2: one history of what changed, newest first, 90 days (core M-1). */
  history?: MemoryHistoryItem[];
};

/**
 * Cards the harness shows in the chat for automatic memory (research/24 §3.6), `details` of the custom
 * message. `prsloy-memory.auto` — «Заметил и запомнил «…»» (one) or «Запомнил несколько вещей (N)» (several);
 * `prsloy-memory.updated` — «Обновил: было «…», стало «…»» with «Вернуть»; when the replaced entry was
 * pinned, the card asks instead: «Раньше вы просили «…». Теперь — «…»?».
 */
export type MemoryAutoCardDetails = {
  items: { id: string; scope: "user" | "project"; text: string; quote?: string }[];
};

export type MemoryUpdatedCardDetails = {
  opId: string;
  /** The new entry. «Да, теперь так» on a pinned one calls pin(id, true): pinned stays pinned. */
  id: string;
  scope: "user" | "project";
  before: string;
  after: string;
  /** The replaced entry was pinned: ask, do not just tell. */
  pinned?: boolean;
};

export interface MemoryApi {
  list(workspace?: string): Promise<MemorySnapshot>;
  /** Also tells an open session to stop using it (hidden note, contract S4). */
  forget(id: string, workspace?: string): Promise<MemorySnapshot>;
  restore(id: string, workspace?: string): Promise<MemorySnapshot>;
  /** «Обо мне» and every project. */
  forgetAll(): Promise<MemorySnapshot>;
  /**
   * «Закрепить» / «Открепить» (research/24 §3.5–3.6): a pinned entry never expires by itself and changes only
   * through a card. Contract from the plumbing PR (§2); main's handler — core.
   */
  pin(id: string, pinned: boolean, workspace?: string): Promise<MemorySnapshot>;
  /**
   * «Вернуть» for an automatic change (replaced / expired / forgotten, research/24 §3.6): undoes the operation
   * with this journal `opId` byte for byte. Contract from the plumbing PR (§2); main's handler — core.
   */
  revert(opId: string, workspace?: string): Promise<MemorySnapshot>;
  /**
   * The answer to a `prsloy-memory.confirm` card (research/27 §2): the agent's tool only proposes «forget» or
   * «replace»; yes applies it, no drops it. Core, #14.
   */
  confirm?(confirmId: string, yes: boolean, workspace?: string): Promise<MemorySnapshot>;
  /** «Забыть всё, что выучено из этого чата»: entries learned only there go, others lose its quotes. Core, #14. */
  forgetSource?(session: string, workspace?: string): Promise<MemorySnapshot>;
}

/** `prsloy-memory.confirm` card details: the tool asked, the user decides (`MemoryApi.confirm`). */
export type MemoryConfirmCardDetails = {
  confirmId: string;
  action: "forget" | "replace";
  scope: "user" | "project";
  /** The entry it is about. */
  id: string;
  /** forget: its text. */
  text?: string;
  /** replace: what is remembered and what the user said now. */
  before?: string;
  after?: string;
};
