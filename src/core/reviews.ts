/** A customer's review of a finished order: a store rating and optional text, nothing that identifies them. */

import { type Order, OrderError } from "./orders.ts";

export const MAX_REVIEW_TEXT = 500;

export interface Review {
  orderId: string;
  /** 1 to 5. */
  rating: number;
  text?: string;
  at: number;
}

export function reviewOrder(order: Order, input: { rating: number; text?: string; now: number }): Review {
  if (order.status !== "completed") throw new OrderError("not_completed", "a completed order", order.status);
  const { rating } = input;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new OrderError("bad_rating", "a whole rating from 1 to 5", String(rating));
  }
  const text = input.text?.trim();
  if (text !== undefined && text.length > MAX_REVIEW_TEXT) {
    throw new OrderError("bad_rating", `review text up to ${MAX_REVIEW_TEXT} characters`, `${text.length}`);
  }
  return { orderId: order.id, rating, ...(text ? { text } : {}), at: input.now };
}
