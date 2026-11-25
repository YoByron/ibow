import { ConfigError } from "./config.ts";
import { type PLURAL_CATEGORIES, pluralForm } from "./plural.ts";

/**
 * Every label and text the customer sees, in English: the defaults that an install's `strings.<locale>.json` may
 * override key by key (D-047). Placeholders are `{name}`. Amounts arrive already formatted, so no string holds a
 * currency symbol. The staff and owner screens keep their own tables.
 */

export const LABELS = {
  // Header and navigation
  findToken: "Find my order",
  backToMenu: "Back to the menu",
  loading: "Loading…",
  retry: "Try again",

  // Header, tabs and the menu
  tagline: "Order and pick up",
  openNow: "Open now",
  closedNow: "Closed",
  leftToday: "{n} left today",
  lastOrderAt: "Last order {time}",
  ordersClosed: "We are not taking orders now. Orders open again at {time}.",
  closedTitle: "We're closed right now",
  closedBody: "Orders open again at {time}. Have a look through the menu in the meantime.",
  closedDayTitle: "We're closed today",
  closedDayBody: "We open again {day} at {time}. Have a look through the menu in the meantime.",
  lastOrderTitle: "Last orders have been taken",
  lastOrderBody: "We stopped taking orders at {last} today. We open again at {time}.",
  pausedNotice: "Ordering opens at {time}",
  pausedNoticeLast: "Last orders were at {last}. We open again at {time}.",
  browseMenu: "Browse the menu",
  offlineTitle: "You're offline",
  itemGoneTitle: "Something in your order just ran out",
  itemGoneBody: "Your cart is as you left it. Take that item out or pick something else, then place the order again.",
  offlineBody: "Your order is still here. Check your connection, then try again.",
  lastOrdersTaken: "Last orders taken",
  tryAgain: "Try again",
  backToCart: "Back to my order",
  statAhead: "Orders ahead",
  tabs: "Sections",
  tabMenu: "Menu",
  tabCart: "Cart",
  tabTrack: "Track",
  darkMode: "Dark mode",
  close: "Close",
  favourites: "Favourites",
  favouritesHint: "Tap the star to save",
  favouritesCount: "{n} saved",
  favourite: "Favourite {item}",
  recent: "Recent",
  recentHint: "Your last orders",
  recentCount: "{n} on this phone",
  recentEmpty: "Your recent orders on this phone will show here.",
  orderAgain: "Order again",
  live: "LIVE",
  tokenCard: "Order {token}",
  itemsCount: "{n} items",
  itemsCount_one: "{n} item",
  sizesCount: "{n} sizes",
  sizesCount_one: "{n} size",
  tagBestseller: "Bestseller",
  tagPopular: "Popular",
  etaAbout: "~{n} min",
  etaReady: "Usually ready in about {n} min",
  chooseSize: "Choose size",
  required: "Required",
  addWithPrice: "Add item · {price}",
  filters: "Diet and allergens",
  filtersNote: "Filters follow the menu's tags. Tell staff about any allergy.",
  optionsFor: "Options for {item}",
  chooseUpTo: "Choose up to {n}",
  chooseExactly: "Choose {n}",
  optional: "Optional",
  noteLabel: "Note for the kitchen",
  notePlaceholder: "For example: less spicy, no onion",
  addNote: "Add a note",
  spotLabel: "Where are you sitting?",
  spotNone: "Not sure yet",
  spotAt: "Sitting at {spot}",
  spotHint: "Staff bring your order to you.",
  roomLabel: "Your room",
  roomHint: "We bring your order to your room.",

  // Catalog
  featured: "Most loved",
  featuredOpen: "Show {item} in the menu",
  search: "Search the menu",
  categories: "Categories",
  allCategories: "All",
  noMatch: "Nothing matches that search.",
  sizesFor: "Sizes of {item}",
  addItem: "Add {item}",
  addSize: "Add {item}, size {size}",
  add: "Add",
  itemsInCart: "{n} in your order",
  reviewOrder: "Review order",
  reviewChange: "Review change",
  editingBanner: "Changing order {token}.",
  cancelChange: "Keep it as it was",

  // Cart
  yourOrder: "Your order",
  changeTitle: "Change order {token}",
  less: "One less {item}",
  more: "One more {item}",
  total: "Total",
  yourName: "What's your name?",
  yourNameHint: "So staff know whose order it is. You can leave it empty.",
  yourNamePlaceholder: "First name",
  forName: "For {name}",
  placeOrder: "Place order",
  updateOrder: "Update order",

  // Cart and payment
  each: "{price} each",
  payWith: "Pay with",
  noFees: "No fees",
  payUpiTitle: "UPI",
  payUpiSub: "Scan, or tap to open your UPI app. Amount and order number are filled in.",
  payCounterTitle: "Pay at counter",
  payCounterSub: "Cash or UPI at the counter, any time before you leave",
  toPay: "To pay",
  payTitle: "Pay {amount}",
  qrLabel: "UPI QR code for {amount}",
  openUpiApp: "Open a UPI app",
  upiHint: "Scan with any UPI app, pay, then tap the button below.",
  iPaid: "I've paid",
  payAtCounterInstead: "Pay at the counter instead",
  payByUpiInstead: "Pay by UPI instead",
  payAtCounter: "Please pay {amount} at the counter.",
  claimedNote: "You said you paid {amount}. Staff will check it.",
  stillToPay: "Still to pay: {amount} at the counter.",
  paid: "Paid. Thank you!",

  // Token page
  trackTitle: "Track order",
  trackSub: "Live · updates automatically",
  findSub: "Type the number from your order page",
  now: "Now",
  stepPlaced: "Order placed",
  stepPlacedSub: "{name} got it",
  stepPaid: "Payment confirmed",
  stepReady: "Ready for pickup",
  stepReadySub: "We will call order {token}",
  stepReadyBrought: "Ready",
  stepReadyBroughtSub: "We are bringing it to {spot}",
  statItems: "Items",
  statPaid: "Paid",
  statPartPaid: "Part paid",
  statChecking: "Checking",
  statDue: "To pay",
  viewOrder: "View order",
  yourToken: "Your order number",
  statusPending: "Order placed",
  statusPreparing: "Being prepared",
  statusCompleted: "Ready! Please collect it.",
  statusCompletedBrought: "Ready! It is on its way to {spot}.",

  // The room bill (D-082)
  payRoomTitle: "Add to my room bill",
  payRoomSub: "Pay for it all when you check out",
  roomBillNote: "On your room bill. We'll bring it to your room.",
  roomBillSettled: "Paid at checkout. Thank you!",

  // Events (D-085)
  eventToday: "Today",
  eventTomorrow: "Tomorrow",
  eventInDays: "In {n} days",
  eventStartsIn: "starts in {time}",
  eventOnNow: "on now",
  eventMinutes: "{m} min",
  eventHours: "{h} h",
  eventHoursMinutes: "{h} h {m} min",
  eventRush: "Expect a rush",
  eventWeekly: "Weekly",
  eventDismiss: "Hide this event",
  eventOrderLine: "While you're here: {title}, {when}",
  stepPreparing: "Preparing",
  editFor: "Change order ({left} left)",
  notifyMe: "Notify me when it changes",
  alertTitle: "Order {token}",
  orderSummary: "Order details · {total}",
  newOrder: "Start a new order",
  orderGone: "That order isn't here any more.",

  // Review
  reviewTitle: "How was it?",
  rating: "Rating",
  stars: "{n} out of 5",
  reviewText: "Anything to add? (optional)",
  sendReview: "Send",
  thanksReview: "Thanks for your review!",

  // Token lookup
  tokenNumber: "Order number",
  tokenExample: "47",
  check: "Check",
  tokenNotFound: "No order with that number today.",

  // Kiosk
  listenForToken: "Listen for your name or order number.",
  newOrderIn: "New order in {seconds} s",
  startNewOrder: "Start a new order",

  // Failures
  failed: "Something went wrong. Please try again or ask at the counter.",
  offline: "No connection. Check your internet and try again.",
  tooMany: "Too many orders from this network just now. Please wait a minute.",
  itemGone: "Something in your order is no longer available. Please check it.",
  editClosed: "This order can't be changed any more.",
} as const;

export type LabelKey = keyof typeof LABELS;

/**
 * Validates a strings file: an object of known label keys to non-empty strings, each keeping the placeholders of the
 * default (so a translation can't drop the amount). Errors name the file and the key.
 */
export function parseStrings(raw: unknown, file: string): LabelOverrides {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(file, "", "an object of label keys to texts", Array.isArray(raw) ? "an array" : String(raw));
  }
  const out: LabelOverrides = {};
  for (const [key, value] of Object.entries(raw)) {
    const form = pluralForm(key);
    if (!(key in LABELS) && !(form !== undefined && form.base in LABELS))
      throw new ConfigError(file, key, "a known label key (see src/core/labels.ts)", "an unknown key");
    if (typeof value !== "string" || value.trim() === "") {
      throw new ConfigError(file, key, "a non-empty text", JSON.stringify(value));
    }
    const holes = (text: string) => new Set(text.match(/\{\w+\}/g) ?? []);
    // A plural form ("one item") may leave the count out; the general text keeps it.
    const need = form === undefined ? holes(LABELS[key as LabelKey]) : new Set<string>();
    const have = holes(value);
    for (const p of need) {
      if (!have.has(p)) throw new ConfigError(file, key, `a text containing ${p}`, JSON.stringify(value));
    }
    out[key as LabelKey] = value;
  }
  return out;
}

/** A strings file's content: label keys, and the plural forms (`itemsCount_one`) of any of them (D-053). */
export type LabelOverrides = Partial<Record<LabelKey | `${LabelKey}_${(typeof PLURAL_CATEGORIES)[number]}`, string>>;
