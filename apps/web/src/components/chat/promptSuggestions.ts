type PromptSuggestionToken = "project" | "timeOfDay" | "user";

interface PromptSuggestionInput {
  readonly projectName: string | null | undefined;
  readonly userName?: string | null | undefined;
  readonly now?: Date;
  readonly seed?: string | null | undefined;
}

const PROJECT_PROMPT_SUGGESTIONS: ReadonlyArray<string> = [
  "What are we doing in {project} today?",
  "Good {timeOfDay}, {user}. What should we move forward in {project}?",
  "What would make {project} feel sharper today?",
  "Let's get {project} into a better state.",
  "What should we clean up in {project} first?",
  "Find the next high-leverage fix in {project}.",
  "Help me plan the next useful change for {project}.",
  "What is the fastest win we can make in {project}?",
  "Review {project} and tell me what deserves attention.",
  "Let's make {project} easier to use.",
  "What should the agents tackle in {project} next?",
  "Good {timeOfDay}. Let's make progress on {project}.",
  "Where is {project} feeling rough right now?",
  "Help me untangle the next task in {project}.",
  "What would improve the flow of {project} today?",
  "Let's polish one thing in {project}.",
  "What is blocking {project} from feeling great?",
  "Help me think through {project}'s next move.",
  "What should we test or verify in {project}?",
  "Let's make {project} more reliable.",
  "Give me a smart first step for {project}.",
  "Good {timeOfDay}, {user}. What are we building in {project}?",
  "What part of {project} should we make calmer and cleaner?",
  "Help me ship something solid in {project}.",
  "What is the most annoying edge in {project} right now?",
  "Let's inspect {project} and pick a clean path.",
  "What is worth simplifying in {project}?",
  "Help me make {project} feel more finished.",
  "What should I ask the agents to handle in {project}?",
  "What a good {timeOfDay} to work on {project}. Where do we start?",
];

const FALLBACK_PROJECT_NAME = "this project";

export function buildProjectPromptSuggestion(input: PromptSuggestionInput): string {
  const projectName = cleanTokenValue(input.projectName) ?? FALLBACK_PROJECT_NAME;
  const userName = cleanTokenValue(input.userName);
  const now = input.now ?? new Date();
  const seed = input.seed ?? `${projectName}:${now.toDateString()}:${now.getHours()}`;
  const template =
    PROJECT_PROMPT_SUGGESTIONS[stableIndex(seed, PROJECT_PROMPT_SUGGESTIONS.length)] ??
    PROJECT_PROMPT_SUGGESTIONS[0] ??
    "What are we doing in {project} today?";

  return renderPromptTemplate(template, {
    project: projectName,
    timeOfDay: timeOfDayLabel(now),
    user: userName ?? "",
  });
}

function renderPromptTemplate(
  template: string,
  tokens: Readonly<Record<PromptSuggestionToken, string>>,
): string {
  return template
    .replaceAll("{project}", tokens.project)
    .replaceAll("{timeOfDay}", tokens.timeOfDay)
    .replaceAll("{user}", tokens.user)
    .replace(/\s+,/gu, ",")
    .replace(/,\s*\./gu, ".")
    .replace(/\s{2,}/gu, " ")
    .trim();
}

function cleanTokenValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function timeOfDayLabel(now: Date): string {
  const hour = now.getHours();
  if (hour < 5) return "night";
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  if (hour < 21) return "evening";
  return "night";
}

function stableIndex(seed: string, length: number): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % length;
}
