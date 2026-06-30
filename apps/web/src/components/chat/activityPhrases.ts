const AGENT_ACTIVITY_WORDS: ReadonlyArray<string> = [
  "Assembling",
  "Balancing",
  "Brewing",
  "Calculating",
  "Charting",
  "Composing",
  "Crunching",
  "Debugging",
  "Decoding",
  "Disambiguating",
  "Discombobulating",
  "Drafting",
  "Exploring",
  "Finessing",
  "Focusing",
  "Forging",
  "Framing",
  "Grooving",
  "Harmonizing",
  "Inspecting",
  "Iterating",
  "Mapping",
  "Massaging",
  "Navigating",
  "Orchestrating",
  "Parsing",
  "Planning",
  "Polishing",
  "Profiling",
  "Reasoning",
  "Reconciling",
  "Refining",
  "Rendering",
  "Researching",
  "Resolving",
  "Scaffolding",
  "Sequencing",
  "Shaping",
  "Simmering",
  "Sketching",
  "Smoothing",
  "Sorting",
  "Stitching",
  "Synthesizing",
  "Tuning",
  "Untangling",
  "Validating",
  "Weaving",
  "Wiring",
  "Wrangling",
];

export function agentActivityWord(seed: string | null | undefined): string {
  return (
    AGENT_ACTIVITY_WORDS[stableIndex(seed ?? "working", AGENT_ACTIVITY_WORDS.length)] ?? "Working"
  );
}

function stableIndex(seed: string, length: number): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = Math.imul(hash ^ seed.charCodeAt(index), 2654435761);
  }
  return Math.abs(hash) % length;
}
