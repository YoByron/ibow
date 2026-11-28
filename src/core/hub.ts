/**
 * The links hub (D-074): every screen of an install, each with what it is for, grouped by the lowest level that may open it.
 * The list is built from the config's stations and spots, never from names in code, and what a signed-in person sees is
 * filtered by the one powers table (`levels.ts`), so the hub can never offer a link its level would be refused.
 */

import { can, type Level, type Power } from "./levels.ts";

export type HubGroup = "everyone" | Level;

export interface HubLink {
  id: string;
  /** Where it opens, from the site root. */
  href: string;
  title: string;
  /** One line: what the screen is for. */
  what: string;
  group: HubGroup;
  /** The power needed to open it; none means anyone, signed in or not. */
  power?: Power;
}

export interface HubInput {
  stations: readonly { id: string; name: string }[];
  /** Whether the business has set up spots (tables or zones), which adds the QR sheet. */
  hasSpots: boolean;
  /** Whether a zone of spots is rooms, which adds the Rooms screen (D-083). */
  hasRooms?: boolean;
  /** Whether the AI analyst is set up, which adds its panel to the owner's dashboard. */
  ai: boolean;
}

export const GROUP_ORDER: readonly HubGroup[] = ["everyone", "staff", "manager", "owner", "admin"];

/** Every screen of the install. */
export function hubLinks(input: HubInput): HubLink[] {
  const owner = (id: string, tab: string, title: string, what: string, power: Power = "reports"): HubLink => ({
    id: `owner-${id}`,
    href: `/owner#/${tab}`,
    title,
    what,
    group: "owner",
    power,
  });
  return [
    {
      id: "storefront",
      href: "/",
      title: "Storefront",
      what: "What customers open on their own phone: the menu, the cart, paying, and following an order",
      group: "everyone",
    },
    {
      id: "kiosk",
      href: "/?kiosk=1",
      title: "Screen ordering",
      what: "The same menu on a screen the business owns, big buttons, resetting for the next customer",
      group: "everyone",
    },
    {
      id: "counter",
      href: "/staff#/counter",
      title: "Counter",
      what: "Take payment, add to an order, call a number and hand over, with refunds where the level allows",
      group: "staff",
      power: "orders.run",
    },
    ...input.stations.map(
      (s): HubLink => ({
        id: `station-${s.id}`,
        href: `/staff#/station/${encodeURIComponent(s.id)}`,
        title: s.name,
        what: "This station's batched, spoken list of what to make next",
        group: "staff",
        power: "orders.view",
      }),
    ),
    {
      id: "runner",
      href: "/staff#/runner",
      title: "Runner",
      what: "Every open order with where it sits and what is ready to carry out, late ones first",
      group: "staff",
      power: "orders.run",
    },
    ...(input.hasSpots
      ? [
          {
            id: "floor",
            href: "/staff#/floor",
            title: "Floor",
            what: "Every section's tables coloured by what is happening there, and who runs each section today",
            group: "staff",
            power: "orders.run",
          } satisfies HubLink,
        ]
      : []),
    ...(input.hasRooms
      ? [
          {
            id: "rooms",
            href: "/staff#/rooms",
            title: "Rooms",
            what: "Each room's open bill, settled in one payment when the guest checks out",
            group: "staff",
            power: "orders.run",
          } satisfies HubLink,
        ]
      : []),
    {
      id: "manager",
      href: "/staff#/manager",
      title: "Menu today",
      what: "Switch items on or off, set how many are left today, and the business's events",
      group: "manager",
      power: "menu.switch",
    },
    {
      id: "sections",
      href: "/staff#/sections",
      title: "Sections",
      what: "Add, rename and delete the table sections and their spots; rooms stay as spots.json sets them",
      group: "manager",
      power: "sections.edit",
    },
    // One link to the one switches page: the page shows each person the scopes their level may flip (the owner also the
    // look and menu switches), so a second link to the same page would only repeat it.
    {
      id: "switches",
      href: "/admin#/switches",
      title: "Switches",
      what: "UPI, counter first, guest messages and sections (and for the owner the look and menu switches), changed while the install runs, with who changed what",
      group: "manager",
      power: "flags.ops",
    },
    owner("today", "", "Today", "Sales so far, the busiest hour, what to prepare, and the day against yesterday"),
    owner(
      "orders",
      "orders",
      "Orders",
      "Every order of a day, paid or not, with the money split by cash, UPI and card",
    ),
    owner("items", "items", "Items", "Switch items on or off and set today's counts"),
    owner("staff", "staff", "Staff", "Add staff and managers and change their PINs and roles", "staff.manage"),
    owner("reviews", "reviews", "Reviews", "What customers rated and wrote"),
    owner("events", "events", "Events", "Markets, music nights and busy days, for guests or staff only"),
    ...(input.hasSpots
      ? [owner("spots", "spots", "Spots and QR sheet", "Where customers sit, and a printable QR for each", "look.edit")]
      : []),
    owner("appearance", "appearance", "Appearance", "Colours, header, logo and the look's switches", "look.edit"),
    {
      id: "health",
      href: "/admin#/health",
      title: "Health",
      what: "Is this install well: requests and errors, the slowest routes, live streams, rows written today, size, uptime, backup",
      group: "admin",
      power: "telemetry",
    },
    {
      id: "system-switches",
      href: "/admin#/switches",
      title: "System switches",
      what: "The AI analyst, retention days and the showcase page, changed while the install runs",
      group: "admin",
      power: "flags.system",
    },
  ];
}

/**
 * The links this person may open. Signed out: the public ones. Station-only staff are not offered the counter or the
 * runner, which their role refuses. A link keeps the group of the lowest level that opens it.
 */
export function linksFor(
  links: readonly HubLink[],
  level: Level | undefined,
  access: "counter" | "station" | "all" = "all",
): HubLink[] {
  return links.filter((l) => {
    if (l.power === undefined) return true;
    if (level === undefined || !can(level, l.power)) return false;
    if (access === "station" && (l.id === "counter" || l.id === "runner" || l.id === "rooms" || l.id === "floor"))
      return false;
    return true;
  });
}

/** Links by group, in the order screens are met, empty groups left out. */
export function grouped(links: readonly HubLink[]): { group: HubGroup; links: HubLink[] }[] {
  return GROUP_ORDER.map((group) => ({ group, links: links.filter((l) => l.group === group) })).filter(
    (g) => g.links.length > 0,
  );
}
