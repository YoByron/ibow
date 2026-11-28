/**
 * Every string the owner's dashboard shows, kept apart from the storefront's and the staff screens' so neither of
 * their bundles carries them. Amounts, hours and dates arrive already formatted through Intl; no string holds a symbol.
 */

import { type Pluralised, pluralKey } from "../core/plural.ts";
import { orderNumber, orderNumbers } from "../core/tokens.ts";

export const ownerEn = {
  ownerTitle: "Owner",
  ownerDashboard: "Owner dashboard",
  signIn: "Unlock dashboard",
  pinSubtitle: "Enter your PIN to open the dashboard",
  pin: "Owner PIN",
  signOut: "Sign out",
  badPin: "That PIN doesn't match.",
  tooManyTries: "Too many tries. Wait a few minutes and try again.",
  darkMode: "Dark mode",
  pinClear: "Clear",
  pinDelete: "Delete",
  failed: "Something went wrong. Try again.",
  offline: "No connection. Check your internet and try again.",
  retry: "Try again",

  // Navigation
  navToday: "Today",
  navOrders: "Orders",
  navItems: "Items",
  navStaff: "Staff",
  navReviews: "Reviews",
  navEvents: "Events",
  statRoomBills: "Open room bills",
  roomBillsCount: "{n} orders, paid at checkout",
  roomBillsCount_one: "{n} order, paid at checkout",
  navSpots: "Spots",
  spotsNone: "No spots are set up. Add a spots.json to the config folder to give each table a QR code.",
  spotsHint:
    "Print a QR for each spot. Scanning it opens the menu with that spot chosen, so staff know where to bring the order.",
  spotsPrint: "Print all {n} QR cards",
  spotScan: "Scan to order",
  spotNewQr: "New QR",
  spotNewQrTitle: "New QR for {room}?",
  spotNewQrBody:
    "The QR in this room stops working at once, so a guest who has checked out can't put orders on the bill with a photo of it. Print the new card and replace the old one.",
  spotNewQrConfirm: "Make a new QR",
  spotNewQrCancel: "Keep the old one",
  navAppearance: "Appearance",

  // Today
  summaryTitle: "Today in short",
  sumNone: "No orders yet today.",
  sumOrders: "{orders} orders so far, worth {ordered}. Received (confirmed by staff): {received}.",
  sumOrders_one: "{orders} order so far, worth {ordered}. Received (confirmed by staff): {received}.",
  sumAwaiting: "{n} orders, {amount}, still awaiting payment confirmation.",
  sumAwaiting_one: "{n} order, {amount}, still awaiting payment confirmation.",
  sumReceivedTrend: "Money received: {pct}% against yesterday by this time.",
  sumUp: "Busier than yesterday by this time: orders up {pct}%.",
  sumDown: "Quieter than yesterday by this time: orders down {pct}%.",
  sumFlat: "About the same as yesterday by this time ({pct}%).",
  sumPeak: "The busiest hour was {hour}, with {orders} orders.",
  sumPeak_one: "The busiest hour was {hour}, with {orders} order.",
  sumTop: "Most ordered: {name}, {qty} sold.",
  sumTopValue: "Top item by revenue: {name}, {amount}.",
  sumForecast: "Prep for {day}: about {orders} orders; most needed {items}.",
  sumForecast_one: "Prep for {day}: about {orders} order; most needed {items}.",
  sumForecastRecent: "(from the last few days; not enough same-weekday history yet)",
  statOrdered: "Ordered",
  statReceived: "Received",
  statAwaiting: "Awaiting confirmation",
  itemCountLabel: "Count for {name}",
  itemCountPlaceholder: "Left today",
  itemCountSet: "Set",
  statCarry: "Ready to delivered",
  minutes: "{n} min",
  carrySub: "longest {max} min; {n} handed over",
  runnersTitle: "Handed over today, by person",
  runnerHandovers: "{n} handed over",
  runnerAverage: "{n} min ready to delivered",
  chartTitle: "Orders by hour",
  peakPill: "Peak {hour} · {orders}",
  topItems: "Top items",
  topItemsHint: "By units today",
  topValueHint: "By value today",
  unitsSold: "{n} sold",
  liveAt: "Live · {time}",
  vsYesterday: "{pct}% orders vs yesterday by now",
  vsYesterdayReceived: "{pct}% received vs yesterday by now",
  ordersAverage: "{orders} orders · average {average}",
  ordersAverage_one: "{orders} order · average {average}",
  yesterdayWhole: "Yesterday, whole day: {orders} orders, {amount}",
  yesterdayWhole_one: "Yesterday, whole day: {orders} order, {amount}",
  cashUpi: "{cash} cash · {upi} UPI",
  cashUpiCard: "{cash} cash · {upi} UPI · {card} card",
  awaitingCount: "{n} orders to match",
  awaitingCount_one: "{n} order to match",
  review: "Review",
  chartLabel: "Orders each hour today; the busiest hour is {hour}.",
  barLabel: "{hour}: {orders} orders",
  barLabel_one: "{hour}: {orders} order",
  popularValue: "Top items by revenue",
  forecastTitle: "Prep for {day}",
  forecastRule: "Mean of the same weekday over the last 4 weeks, days with orders only, rounded up.",
  forecastRecentRule: "No same-weekday history yet: mean of the last 7 days with orders, rounded up.",
  forecastNone: "No history yet to forecast from.",
  forecastMore: "And {n} more lines, each needed fewer times.",
  forecastMore_one: "And {n} more line, needed fewer times.",
  qtyName: "{qty} × {name}",

  // Orders
  tabPending: "Pending {n}",
  tabPreparing: "Preparing {n}",
  tabCompleted: "Completed {n}",
  noOrders: "No orders here.",
  returning: "Returning · {n} earlier visits",
  returning_one: "Returning · {n} earlier visit",
  notPaid: "Not paid",
  paidLabel: "Paid {amount}",
  claimedLabel: "Customer says paid {amount} (not confirmed)",
  paidDueLabel: "Paid {amount} · due {due}",

  // Items
  itemsHint: "Switch an item off when it runs out; customers stop seeing it within half a minute.",
  itemOn: "On",
  itemOff: "Off",
  itemSwitch: "{name}: available",

  // Staff
  staffHint: "Staff sign in on the staff page with their ID and PIN. Saving a PIN or role signs that person out.",
  noStaff: "No staff yet.",
  staffId: "Staff ID",
  staffName: "Name",
  staffPin: "New PIN (4 to 12 digits)",
  staffRole: "Role",
  roleAll: "Counter and stations",
  roleCounter: "Counter",
  roleStation: "Stations only",
  roleManager: "Manager (menu, refunds, every staff screen)",
  saveStaff: "Save",
  editStaff: "Edit {name}",
  staffLine: "{name} ({id}) · {role}",

  // Reviews
  noReviews: "No reviews yet.",
  reviewAverage: "{average} out of 5 from the latest {count} reviews",
  reviewAverage_one: "{average} out of 5 from the latest review",
  reviewStars: "{rating} out of 5",
  reviewToken: "Order {token} · {date}",

  // Appearance
  appearanceHint:
    "Change how the storefront and staff screens look. Customers and staff see it within half a minute, without reloading. Photos and item pictures come from the config for now.",
  colours: "Colours",
  colPrimary: "Main colour (buttons)",
  colAccent: "Accent (highlights)",
  colHeader: "Header",
  colLightSurface: "Page, light mode",
  colLightText: "Text, light mode",
  colDarkSurface: "Page, dark mode",
  colDarkText: "Text, dark mode",
  colAwningA: "Awning stripe 1",
  colAwningB: "Awning stripe 2",
  fontLabel: "Typeface",
  fontInter: "Inter",
  fontLora: "Lora (serif)",
  fontNunito: "Nunito (rounded)",
  fontSpace: "Space Grotesk",
  fontSystem: "This device's own",
  radiusLabel: "Corners",
  radiusSharp: "Square",
  radiusSoft: "Soft",
  radiusRound: "Round",
  densityLabel: "Spacing",
  densityComfortable: "Comfortable",
  densityCompact: "Compact",
  headerLabel: "Header style",
  headerAwning: "Awning",
  headerPlain: "Plain",
  headerImage: "Image from the config",
  logoLabel: "Logo icon",
  logoConfig: "As configured",
  features: "Show on the storefront",
  featFavourites: "Favourites (stars)",
  featRecent: "Recent orders",
  featVeg: "Veg and non-veg markers",
  featDark: "Dark mode button",
  featEta: "Typical wait on the cart bar",
  featTags: "Bestseller and popular tags",
  tagsOff: "Off",
  tagsCatalog: "From the catalog only",
  tagsAuto: "From the catalog and from sales",
  contrastTitle: "Readability",
  contrastOk: "Every checked pair is easy to read (WCAG AA).",
  contrastBad: "{pair}: contrast {ratio}:1, needs {min}:1.",
  save: "Save",
  saveAnyway: "Save anyway",
  contrastWarn: "Some colours are hard to read. Customers may struggle to see them.",
  resetToConfig: "Reset to config",
  saved: "Saved. Open screens update within half a minute.",
  resetDone: "Back to the look in the config.",
  previewTitle: "Preview",
  previewLight: "Light",
  previewDark: "Dark",
  usingOverride: "Showing your saved changes.",
  usingConfig: "Showing the look from the config.",
} as const;

export type OwnerStringKey = keyof typeof ownerEn;

/** The string for `key` with `{placeholders}` filled; an unknown placeholder stays visible rather than vanishing. */
/** `{token}` and `{tokens}` in any label read as order numbers ("#47"), never as the stored `25-047` (M13). */
function readable(vars: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  if (vars.token === undefined && vars.tokens === undefined) return vars;
  return {
    ...vars,
    ...(vars.token === undefined ? {} : { token: orderNumber(vars.token) }),
    ...(vars.tokens === undefined ? {} : { tokens: orderNumbers(vars.tokens) }),
  };
}

export function t(key: OwnerStringKey, vars: Readonly<Record<string, string>> = {}): string {
  vars = readable(vars);
  return (ownerEn[key] as string).replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole);
}

/** The string for `key` in the form its `count` takes ("1 order", "3 orders"); `vars` carries the count as text too. */
export function tn(
  key: Pluralised<typeof ownerEn>,
  count: number,
  vars: Readonly<Record<string, string>> = {},
): string {
  return t(pluralKey(key, count, "en", (k) => k in ownerEn) as OwnerStringKey, vars);
}
