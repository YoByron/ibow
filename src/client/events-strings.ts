/** The strings of the events editor (the owner's Events tab and the manager's screen), apart from the storefront's. */

export const eventsEn = {
  eventsTitle: "Events",
  eventsSub: "Markets, music nights and busy days: shown on the screens and, if you choose, to guests",
  eventsNone: "No events yet.",
  eventsAdd: "Add event",
  eventsSave: "Save changes",
  eventsCancel: "Cancel",
  eventsEdit: "Edit",
  eventsDelete: "Delete",
  eventTitle: "Title",
  eventDate: "Date (first date if it repeats)",
  eventStart: "Starts",
  eventEnd: "Ends (optional)",
  eventNote: "One line for the banner (optional)",
  eventPrice: "Entry price (optional)",
  eventWho: "Who sees it",
  eventWhoAll: "Guests and staff",
  eventWhoStaff: "Staff only",
  eventRushFlag: "Expect a rush",
  eventRepeat: "Repeats weekly on",
  eventUntil: "Until (optional)",
  eventStaffOnly: "Staff only",
  eventsDeleteTitle: "Delete {title}?",
  eventsDeleteBody: "It goes from every screen. A repeating event goes with all its coming dates.",
  eventWeeklyOn: "Weekly: {days}",
  eventOnce: "{day} {time}",
} as const;

export type EventsStringKey = keyof typeof eventsEn;

export function te(key: EventsStringKey, vars: Readonly<Record<string, string>> = {}): string {
  return (eventsEn[key] as string).replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole);
}
