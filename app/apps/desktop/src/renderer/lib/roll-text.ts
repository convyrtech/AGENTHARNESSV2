/**
 * Rolling numbers («12 мин», «1,20 ₽», «осталось ~5 мин»): a text split into pieces keyed by
 * their place counted from the end, so when the text changes only the digits that changed get
 * a new key — React remounts just those, and their CSS entrance is the roll. Counting from the
 * end keeps «9 мин» → «10 мин» rolling the 0 in place and the new 1 in, not every character.
 */
export type RollPiece = { key: string; text: string; digit: boolean };

const DIGIT = /\d/u;

export function rollPieces(text: string): RollPiece[] {
  const chars = Array.from(text);
  return chars.map((char, index) => {
    const fromEnd = chars.length - 1 - index;
    return { key: `${fromEnd}:${char}`, text: char, digit: DIGIT.test(char) };
  });
}
