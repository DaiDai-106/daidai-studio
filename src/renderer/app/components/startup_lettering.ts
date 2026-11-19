// Hand-lettered outlines in writing order. Each path begins with a new pen stroke.
const letters: Record<string, readonly [advance: number, ...strokes: string[]]> = {
  W: [65, "M3 7 C8 17 10 42 16 55 C22 48 27 21 33 11 C36 22 38 44 43 55 C53 45 55 19 62 5"],
  e: [32, "M3 40 C13 41 27 37 25 31 C22 21 7 30 4 41 C0 53 12 61 29 49"],
  l: [24, "M3 48 C13 38 31 8 22 5 C15 1 8 23 5 40 C2 53 9 59 21 50"],
  c: [30, "M25 32 C21 25 11 27 5 37 C-1 47 4 57 15 55 C20 55 25 53 28 49"],
  o: [
    33,
    "M26 32 C20 24 10 27 5 35 C-1 44 2 55 12 55 C22 56 30 45 28 35 C26 28 17 28 16 34 C15 39 21 42 29 40",
  ],
  m: [
    48,
    "M2 55 Q6 41 9 29 L7 44 C12 35 18 28 23 30 C29 33 22 49 21 54 C25 43 33 28 39 31 C48 35 34 54 42 56 Q45 56 47 51",
  ],
  t: [29, "M18 10 C15 25 7 42 8 49 C9 58 18 58 26 49", "M2 31 Q14 27 27 29"],
  D: [60, "M15 9 C14 22 11 40 8 55", "M7 9 C24 0 55 5 55 27 C56 49 32 64 6 54"],
  a: [
    37,
    "M28 34 C24 24 11 28 5 37 C-2 48 4 57 12 55 C21 53 25 42 28 33 C25 42 22 52 28 55 Q32 58 35 51",
  ],
  i: [23, "M10 31 C7 41 4 50 9 54 Q14 57 20 51", "M14 17 l0.5 -1"],
  S: [
    49,
    "M43 13 C40 3 22 3 12 10 C2 17 6 25 18 30 C28 34 43 38 37 49 C31 61 13 61 5 53 C2 50 3 45 8 41",
  ],
  u: [39, "M6 31 C4 39 0 50 5 54 C13 60 25 47 29 34 C27 42 23 52 30 55 Q34 56 37 50"],
  d: [
    39,
    "M27 33 C21 25 10 28 5 37 C-1 47 4 57 13 55 C24 53 30 35 34 18 C38 4 35 2 32 9 C28 19 21 44 24 52 Q28 61 37 50",
  ],
};

export function startupLettering(text: string) {
  let width = 0;
  const strokes: { x: number; d: string; word: number }[] = [];
  let word = 0;
  for (const letter of text) {
    if (letter === " ") {
      width += 20;
      word++;
      continue;
    }
    const shape = letters[letter];
    if (!shape) throw new Error(`Missing startup lettering for ${letter}`);
    const [advance, ...paths] = shape;
    for (const d of paths) strokes.push({ x: width, d, word });
    width += advance;
  }
  return { width, strokes };
}
