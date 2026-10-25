// signal-exit 3.x без собственных типов. Этот же модуль Pi уже грузит: обработчики сигналов общие.
declare module "signal-exit" {
  export default function onExit(
    callback: (code: number | null, signal: string | null) => void,
    options?: { alwaysLast?: boolean },
  ): () => void;
}
