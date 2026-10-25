/**
 * The owner's site address in his message, for «бренд по адресу сайта» (research/20 §3): an explicit
 * http(s) URL, or a bare domain the way people write it («домен prsloy.online»). E-mail addresses and
 * file names are not sites.
 */
const EXPLICIT = /https?:\/\/[^\s«»"'<>()]+/i;
const TLD =
  "ru|рф|su|online|com|net|org|io|site|store|shop|pro|me|app|dev|tech|studio|space|art|cafe|by|kz|ua|uz|biz|info";
const BARE = new RegExp(
  `(?<![@\\w.-])((?:[a-z0-9а-яё](?:[a-z0-9а-яё-]{0,61}[a-z0-9а-яё])?\\.)+(?:${TLD}))(?:/[^\\s«»"'<>()]*)?(?![\\w@-])`,
  "iu",
);
const FILE = /\.(png|jpe?g|gif|webp|svg|pdf|zip|html?|css|js|txt|docx?|xlsx?|mp4)$/i;

export function siteUrl(text: string): string | undefined {
  const explicit = EXPLICIT.exec(text)?.[0]?.replace(/[.,;:!?]+$/, "");
  if (explicit) return explicit;
  const bare = BARE.exec(text);
  if (!bare || FILE.test(bare[1]!)) return undefined;
  return `https://${bare[0].replace(/[.,;:!?]+$/, "")}`;
}
