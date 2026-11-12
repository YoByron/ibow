/** Every string the AI analyst's panel shows, in its own bundle with it (`owner-ai.ts`), apart from the dashboard's. */

export const analystEn = {
  title: "Ask the analyst",
  privacy:
    "Answers come from the dashboard's figures for today, yesterday, the last 7 days and tomorrow's prep. The AI model sees only anonymous counts and item names: no customer names, no reviews.",
  question: "Your question",
  placeholder: "Which hour was busiest today?",
  ask: "Ask",
  asking: "Asking…",
  used: "Figures used",
  figure: "{label}: {value}",
  unverified: "Check this answer: the figures it cites don't back what is marked ({numbers}).",
  unbackedMark: "Not among the dashboard's figures",
  tooMany: "That's a lot of questions for one sign-in. Wait a while and ask again.",
  signedOut: "You were signed out. Sign in again to ask.",
  offline: "No connection. Check your internet and try again.",
  failed: "The analyst couldn't answer: {message}",
} as const;

export function t(key: keyof typeof analystEn, vars: Readonly<Record<string, string>> = {}): string {
  return (analystEn[key] as string).replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole);
}
