// Sample content for `npm run db:seed`. The documents are written for the demo (no copyright), and the eval questions
// have answers that really are in them, so a run on a working AI service should score well.

export const DEMO_USER = {
  name: "Demo User",
  email: "demo@docmind.dev",
  password: "demo1234",
} as const;

export const ADMIN_USER = {
  name: "DocMind Admin",
  email: "admin@docmind.dev",
} as const;

export const DEMO_COLLECTION = {
  name: "Northwind Demo",
  description: "A sample employee handbook and product FAQ to try the chat on.",
} as const;

export const HANDBOOK = {
  filename: "northwind-handbook.md",
  content: `# Northwind Employee Handbook (sample)

## Time off

Every full-time employee gets 25 days of paid time off (PTO) per year. PTO accrues monthly, so you earn about two days
each month. You can carry over up to 5 unused days into the next year; anything above that expires on 31 December.
Sick leave is separate: employees get 10 paid sick days per year, and no doctor's note is needed for absences shorter
than 3 days.

## Remote work

Employees may work remotely up to 3 days per week. Everyone is expected to be reachable during core hours, 10:00 to
15:00 in their own time zone. Team leads can approve a different schedule for roles that need on-site presence.

## Expenses

Submit expense claims within 30 days of the purchase. Receipts are required for any single expense above $25. When
travelling for work, meals are reimbursed up to $50 per day. Flights and hotels must be booked through the company
travel portal.

## Equipment

New employees receive a laptop and a monitor. Laptops are refreshed every 3 years. Lost or stolen equipment must be
reported to IT within 24 hours.
`,
} as const;

export const FAQ = {
  filename: "northwind-product-faq.md",
  content: `# Northwind Product FAQ (sample)

## Plans and pricing

Northwind has three plans. Starter costs $12 per user per month, Team costs $29 per user per month, and Enterprise is
priced individually. Single sign-on (SSO) is only available on the Enterprise plan.

## Refunds

You can request a full refund within 30 days of your first payment. After that, annual plans are refunded pro rata
for the months not used. Monthly plans are not refunded.

## Support

Support is available Monday to Friday, 09:00 to 18:00 UTC, by email and live chat. Enterprise customers also get a
named account manager and a 4 hour response target for urgent issues.

## Data

After a workspace is cancelled, its data is kept for 90 days so you can still export it, and is then deleted
permanently. Data is encrypted in transit and at rest.
`,
} as const;

export const EVAL_SET = {
  name: "Handbook and FAQ basics",
  description:
    "Five factual questions with known answers from the sample documents.",
} as const;

export const EVAL_QUESTIONS = [
  {
    question: "How many days of paid time off do employees get each year?",
    expected: "25 days, accrued monthly.",
    doc: "handbook",
  },
  {
    question: "How many days a week can employees work remotely?",
    expected: "Up to 3 days per week.",
    doc: "handbook",
  },
  {
    question: "How long do I have to submit an expense claim?",
    expected: "Within 30 days of the purchase.",
    doc: "handbook",
  },
  {
    question: "How much does the Team plan cost per user per month?",
    expected: "$29 per user per month.",
    doc: "faq",
  },
  {
    question: "How long is data kept after a workspace is cancelled?",
    expected: "90 days, then it is deleted permanently.",
    doc: "faq",
  },
] as const;
