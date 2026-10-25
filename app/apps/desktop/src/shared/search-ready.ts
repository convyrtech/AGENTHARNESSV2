/**
 * Web search (issue #23) is ready for people: flip to `true` after design's review fixes and the bench
 * measurement. While `false`, the first run goes key → import → folder (no search step), and Settings →
 * «Поиск в интернете» shows only in developer mode. The harness flag `webTools` stays off either way
 * until someone turns it on.
 */
export const SEARCH_READY = false;
