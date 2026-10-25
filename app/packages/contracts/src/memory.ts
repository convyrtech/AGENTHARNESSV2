/**
 * «Память» (research/18 §6, STATUS-harness S4/S5): what the agent remembers about the owner
 * («Обо мне») and the open project («Об этом проекте»). Files live in the agent folder
 * (`prsloy-memory/`); main reads and changes them through the harness's `MemoryStore`
 * (IPC `prsloy:memory-*`, core). Each call returns the fresh snapshot.
 */
export type MemoryItem = { id: string; text: string; created?: string };

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
};

export interface MemoryApi {
  list(workspace?: string): Promise<MemorySnapshot>;
  /** Also tells an open session to stop using it (hidden note, contract S4). */
  forget(id: string, workspace?: string): Promise<MemorySnapshot>;
  restore(id: string, workspace?: string): Promise<MemorySnapshot>;
  /** «Обо мне» and every project. */
  forgetAll(): Promise<MemorySnapshot>;
}
