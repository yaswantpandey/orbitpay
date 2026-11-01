import { z } from "zod";

// All money is integer cents. Max single transfer: $10,000.
export const amountCentsSchema = z.number().int().positive().max(1_000_000);

export const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{16,64}$/, "Idempotency key must be 16-64 characters (alphanumeric, dash, underscore)");

export const noteSchema = z
  .string()
  .max(200)
  .transform((s) => s.replace(/[\x00-\x1F\x7F]/g, "").trim())
  .default("");

export const emailSchema = z.string().trim().toLowerCase().email();

export const transferSchema = z.object({
  toEmail: emailSchema,
  amountCents: amountCentsSchema,
  note: noteSchema,
  idempotencyKey: idempotencyKeySchema,
});

export const topupSchema = z.object({
  amountCents: z.number().int().min(100).max(500_000),
  method: z.enum(["card", "bank"]),
  idempotencyKey: idempotencyKeySchema,
});

export const createRequestSchema = z.object({
  payerEmail: emailSchema,
  amountCents: amountCentsSchema,
  note: noteSchema,
});

export const lineItemSchema = z.object({
  description: z.string().min(1, "Each line needs a description").max(200),
  quantity: z.number().int().min(1).max(1000),
  unitPriceCents: z.number().int().min(1).max(1_000_000),
});

export const createInvoiceSchema = z.object({
  recipientEmail: emailSchema,
  lineItems: z.array(lineItemSchema).min(1).max(50),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a due date"),
  memo: z.string().max(500).transform((s) => s.replace(/[\x00-\x1F\x7F]/g, "").trim()).default(""),
  send: z.boolean(),
});

export const createScheduleSchema = z.object({
  toEmail: emailSchema,
  amountCents: amountCentsSchema,
  note: noteSchema,
  frequency: z.enum(["weekly", "monthly"]),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a start date"),
});

export const contactSchema = z.object({
  email: emailSchema.max(200),
  name: z.string().max(100).default(""),
});

export const CATEGORIES = [
  "food", "transport", "shopping", "bills", "entertainment", "rent", "travel", "health", "other",
] as const;

/** Parse a user-entered dollar string like "12.34" into integer cents without floats. */
export function dollarsToCents(input: string): number | null {
  const m = input.trim().match(/^(\d{1,7})(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 100 + parseInt((m[2] ?? "").padEnd(2, "0"), 10);
}
