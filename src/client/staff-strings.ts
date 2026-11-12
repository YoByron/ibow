/**
 * Every string the staff screens show or speak, on top of the customer strings they share (`strings.ts`), kept apart
 * so the storefront bundle doesn't carry them. The spoken batch text is the core batch template, not a string here.
 */

import { en } from "./strings.ts";

export const staffEn = {
  // Staff: sign in and screens
  staffTitle: "Staff",
  signIn: "Unlock",
  pinSubtitle: "Enter your staff ID and PIN",
  staffUser: "Staff ID",
  pin: "PIN",
  signOut: "Sign out",
  badPin: "That ID and PIN don't match.",
  tooManyTries: "Too many tries. Wait a few minutes and try again.",
  chooseScreen: "Choose a screen",
  pinClear: "Clear",
  pinDelete: "Delete",
  collectCash: "Collect cash",
  totalDue: "Total due",
  changeDueTile: "Change due",
  stillShort: "Still short",
  tickets: "Tickets",
  itemsTotal: "Items",
  startShift: "Tap to start (turns sound on)",
  muteVoice: "Mute",
  speechRate: "Speech speed",

  // Counter
  counterTitle: "Counter",
  walkIn: "New order",
  tabPending: "Pending {n}",
  tabPreparing: "Preparing {n}",
  tabReady: "Ready {n}",
  noOrders: "No orders here.",
  lineQty: "{qty} × {name}",
  readyBadge: "Ready",
  waitingBadge: "Waiting",
  servedBadge: "Served",
  serve: "Serve",
  due: "Due {amount}",
  topUpDue: "Added items: take {amount} more",
  claimedUpi: "Customer says they paid {amount} by UPI. Check before confirming.",
  paidLabel: "Paid {amount}",
  cashReceived: "Cash",
  upiReceived: "UPI received",
  cashGiven: "Cash handed over",
  changeLabel: "Change {amount}",
  shortBy: "Short by {amount}",
  confirmCash: "Cash received: {amount}",
  startPreparing: "Start preparing",
  markDone: "Collected",
  callToken: "Call token",
  callText: "Token {token}, your order is ready.",
  addItems: "Add items",
  addingTo: "Add to {token}",
  addToOrder: "Add to {token}",
  printReceipt: "Print receipt",
  undo: "Undo",
  recentlyDone: "Collected in the last 5 minutes",
  newOrderAlert: "New order {token}",
  readyAlert: "Token {token} is ready",
  cancel: "Cancel",
  payCash: "Cash",
  payUpi: "UPI QR",
  showQr: "Show this QR to the customer: {amount}",

  // Stations
  replay: "Replay",
  allReady: "All ready",
  stationLive: "Live · batched across open orders",
  groupTotal: "{n} total",
  reading: "Reading:",
  oldest: "Oldest",
  oldestAge: "{n}m",
  moreTokens: "+{n}",
  tokensFor: "Tokens {tokens}",
  markReady: "Ready",
  undoReady: "Undo ready",
  jobReady: "Job ready",
  noJobs: "No jobs waiting.",
  newJob: "New job, token {token}: {items}",
  printTicket: "Print ticket",
  printAll: "Print tickets",

  // Tickets
  ticketToken: "Token {token}",
  receiptPaid: "Paid",
  receiptDue: "Due",
} as const;

const all: Readonly<Record<string, string>> = { ...en, ...staffEn };

export type StaffStringKey = keyof typeof en | keyof typeof staffEn;

/** The string for `key` with `{placeholders}` filled; an unknown placeholder stays visible rather than vanishing. */
export function t(key: StaffStringKey, vars: Readonly<Record<string, string>> = {}): string {
  return (all[key] as string).replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole);
}
