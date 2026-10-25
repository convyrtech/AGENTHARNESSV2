/**
 * Web search (issue #23) is ready for people (alpha.2, measured on the live web suite): Settings →
 * «Поиск в интернете» shows to everyone, and the harness flag `webTools` is on by default (a hand-set
 * false stays). The first run asks nothing about it (FIRST_RUN_SEARCH_STEP).
 */
export const SEARCH_READY = true;

/**
 * The first-run search question (FirstRunSearch). Off for alpha.2: search is on by default, so the step
 * would ask about something already on; it can be turned off in Settings → «Поиск в интернете».
 */
export const FIRST_RUN_SEARCH_STEP = false;
