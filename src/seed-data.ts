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

// ---------------------------------------------------------------------------------------------------------------------
// The larger evaluation set: three more sample documents and 40 questions about all five. Added to an existing demo
// collection by `npm run db:seed` (it only adds what is missing, so nothing you uploaded yourself is touched).
// ---------------------------------------------------------------------------------------------------------------------

export const SECURITY_POLICY = {
  filename: "northwind-security-policy.md",
  content: `# Northwind Security Policy (sample)

## Accounts and passwords

Passwords must be at least 14 characters long, and every employee must use the company password manager. Passwords are changed only after a suspected compromise, not on a schedule. Multi-factor authentication is required on every company account. Administrators must use a hardware security key.

## Laptops

Every company laptop must have full-disk encryption turned on. Screens lock automatically after 5 minutes of inactivity. Operating system updates must be installed within 7 days of release, and critical security patches within 48 hours.

## Reporting incidents

Report a suspected phishing email or any security incident to security@northwind.example within 1 hour. The security team triages every report within 4 hours. A post-incident review is held within 5 business days of the incident being closed.

## Data classification

Data is classified as Public, Internal, Confidential or Restricted. Restricted data, such as customer personal data, may be accessed only from company laptops and never from personal devices.

## Access and offboarding

Access rights are reviewed every quarter. When someone leaves the company, all of their access is removed within 24 hours of their last working day.

## Backups and vendors

Backups run daily and are kept for 35 days. Restore tests are performed twice a year. Every new vendor needs a security review before a contract is signed, and the review takes up to 10 business days.
`,
} as const;

export const ONBOARDING_GUIDE = {
  filename: "northwind-onboarding-guide.md",
  content: `# Northwind Onboarding Guide (sample)

## Your first day

Pick up your laptop at the IT desk at 9:30. You will receive your building badge there. Orientation starts at 10:00 in the main meeting room on level 4 of the head office at 12 Harbour Street.

## Your first weeks

Every new hire is paired with a buddy for the first 8 weeks. Your buddy answers day-to-day questions and introduces you to the team. You must complete four mandatory trainings within 14 days of joining: security awareness, code of conduct, data privacy and anti-harassment.

## The 30/60/90 plan

In the first 30 days you learn the product and the team. In days 31 to 60 you start contributing to real work. By day 90 you own a piece of work end to end. You meet your manager to review progress at day 30, day 60 and day 90.

## Probation

The probationary period is 3 months. During probation, either side can end the employment with 1 week of notice.

## Tools

Northwind uses Slack for chat, Linear for tickets and Notion for documentation. Ask your buddy for access to each tool during your first week.

## Payroll

Salaries are paid on the last working day of each month. The payroll cutoff for changes to your details is the 20th of the month.
`,
} as const;

export const BENEFITS_GUIDE = {
  filename: "northwind-benefits-guide.md",
  content: `# Northwind Benefits Guide (sample)

## Health insurance

The company pays 80% of the health insurance premium for employees and 50% for their dependents. Cover starts on the first day of the month after you join.

## Retirement

After 6 months of service the company matches 100% of your retirement contributions, up to 4% of your salary. Matched contributions are yours immediately, with no vesting period.

## Learning budget

Each employee gets a learning budget of $1,200 per year for courses, books and conferences. Unused budget does not roll over to the next year.

## Parental leave

The primary caregiver receives 16 weeks of fully paid parental leave and the secondary caregiver receives 6 weeks. Leave must be taken within 12 months of the birth or adoption, and you should give 4 weeks of notice.

## Wellbeing

Employees receive a wellness stipend of $50 per month. The employee assistance program is free and covers 6 counselling sessions per issue.

## Home office

New employees can claim a one-time home office allowance of $400 for a desk or chair, within their first 90 days.

## Referrals and holidays

You earn a $2,000 referral bonus when someone you referred is hired and completes 6 months. The company observes 12 public holidays a year.
`,
} as const;

export type DocKey =
  "handbook" | "faq" | "security" | "onboarding" | "benefits";

export const DOC_FILENAMES: Record<DocKey, string> = {
  handbook: HANDBOOK.filename,
  faq: FAQ.filename,
  security: SECURITY_POLICY.filename,
  onboarding: ONBOARDING_GUIDE.filename,
  benefits: BENEFITS_GUIDE.filename,
};

export const DOC_CONTENT: Record<DocKey, string> = {
  handbook: HANDBOOK.content,
  faq: FAQ.content,
  security: SECURITY_POLICY.content,
  onboarding: ONBOARDING_GUIDE.content,
  benefits: BENEFITS_GUIDE.content,
};

export const NOT_IN_DOCUMENTS =
  "I couldn't find that in your documents. The answer is not in them.";

export type QuestionKind =
  "lookup" | "paraphrase" | "multi" | "cross" | "keyword" | "unanswerable";

export interface FullEvalQuestion {
  kind: QuestionKind;
  question: string;
  expected: string;
  /** The document the answer comes from. Unanswerable questions have none. */
  doc?: DocKey;
  /** A phrase that must appear in that document (checked by a test, so the expected answer is really in the text). */
  evidence?: string;
}

export const FULL_EVAL_SET = {
  name: "Northwind full evaluation",
  description:
    "40 questions about the five sample documents: lookups, paraphrases, multi-fact, cross-document, exact terms and questions that cannot be answered.",
} as const;

export const FULL_EVAL_QUESTIONS: FullEvalQuestion[] = [
  // --- lookups: one fact, asked the way the document says it (15)
  {
    kind: "lookup",
    doc: "handbook",
    question: "How many paid sick days do employees get per year?",
    expected: "10 paid sick days per year.",
    evidence: "10 paid sick days per year",
  },
  {
    kind: "lookup",
    doc: "handbook",
    question: "How many unused PTO days can be carried over to the next year?",
    expected: "Up to 5 days.",
    evidence: "carry over up to 5 unused days",
  },
  {
    kind: "lookup",
    doc: "handbook",
    question: "What are the core hours for remote work?",
    expected: "10:00 to 15:00 in the employee's own time zone.",
    evidence: "10:00 to 15:00",
  },
  {
    kind: "lookup",
    doc: "handbook",
    question: "Above what amount is a receipt required for an expense?",
    expected: "Any single expense above $25.",
    evidence: "above $25",
  },
  {
    kind: "lookup",
    doc: "handbook",
    question: "How often are laptops refreshed?",
    expected: "Every 3 years.",
    evidence: "refreshed every 3 years",
  },
  {
    kind: "lookup",
    doc: "faq",
    question: "Which plan includes single sign-on?",
    expected: "Only the Enterprise plan.",
    evidence: "only available on the Enterprise plan",
  },
  {
    kind: "lookup",
    doc: "faq",
    question: "What are the support hours?",
    expected: "Monday to Friday, 09:00 to 18:00 UTC.",
    evidence: "Monday to Friday, 09:00 to 18:00 UTC",
  },
  {
    kind: "lookup",
    doc: "faq",
    question: "How much does the Starter plan cost?",
    expected: "$12 per user per month.",
    evidence: "Starter costs $12 per user per month",
  },
  {
    kind: "lookup",
    doc: "security",
    question: "How long must a password be?",
    expected: "At least 14 characters.",
    evidence: "at least 14 characters",
  },
  {
    kind: "lookup",
    doc: "security",
    question: "After how many minutes of inactivity does the screen lock?",
    expected: "5 minutes.",
    evidence: "5 minutes of inactivity",
  },
  {
    kind: "lookup",
    doc: "security",
    question: "How quickly must a security incident be reported?",
    expected: "Within 1 hour.",
    evidence: "within 1 hour",
  },
  {
    kind: "lookup",
    doc: "onboarding",
    question: "At what time does orientation start on the first day?",
    expected: "At 10:00.",
    evidence: "Orientation starts at 10:00",
  },
  {
    kind: "lookup",
    doc: "onboarding",
    question: "How long is the probationary period?",
    expected: "3 months.",
    evidence: "probationary period is 3 months",
  },
  {
    kind: "lookup",
    doc: "benefits",
    question: "How big is the yearly learning budget?",
    expected: "$1,200 per year per employee.",
    evidence: "$1,200 per year",
  },
  {
    kind: "lookup",
    doc: "benefits",
    question: "How many public holidays does the company observe?",
    expected: "12 public holidays a year.",
    evidence: "12 public holidays",
  },

  // --- paraphrases: the question uses different words than the document (8)
  {
    kind: "paraphrase",
    doc: "handbook",
    question: "If I'm off ill, do I need a medical certificate?",
    expected:
      "No. A doctor's note is not needed for absences shorter than 3 days.",
    evidence: "no doctor's note is needed for absences shorter than 3 days",
  },
  {
    kind: "paraphrase",
    doc: "handbook",
    question: "How much can I claim for food on a work trip?",
    expected: "Meals are reimbursed up to $50 per day.",
    evidence: "meals are reimbursed up to $50 per day",
  },
  {
    kind: "paraphrase",
    doc: "faq",
    question: "Can I get my money back if I cancel after the first month?",
    expected:
      "Only for annual plans, pro rata for the months not used; monthly plans are not refunded.",
    evidence: "Monthly plans are not refunded",
  },
  {
    kind: "paraphrase",
    doc: "faq",
    question:
      "How long can I still download my data after closing my workspace?",
    expected: "90 days, then it is deleted permanently.",
    evidence: "kept for 90 days",
  },
  {
    kind: "paraphrase",
    doc: "security",
    question: "Is it okay to open customer personal data on my own phone?",
    expected:
      "No. Restricted data may only be accessed from company laptops, never from personal devices.",
    evidence: "never from personal devices",
  },
  {
    kind: "paraphrase",
    doc: "onboarding",
    question: "Who can help me with everyday questions when I start?",
    expected: "Your buddy, who you are paired with for the first 8 weeks.",
    evidence: "paired with a buddy for the first 8 weeks",
  },
  {
    kind: "paraphrase",
    doc: "benefits",
    question: "How long is time off for a new parent who is the main carer?",
    expected: "16 weeks of fully paid leave for the primary caregiver.",
    evidence: "16 weeks of fully paid parental leave",
  },
  {
    kind: "paraphrase",
    doc: "benefits",
    question: "What do I get towards a desk or chair at home?",
    expected:
      "A one-time $400 home office allowance, claimed within the first 90 days.",
    evidence: "one-time home office allowance of $400",
  },

  // --- multi-fact: the answer needs more than one fact from the same document (4)
  {
    kind: "multi",
    doc: "handbook",
    question: "How many days of PTO do I get, and how many can I carry over?",
    expected: "25 days a year, and up to 5 unused days carry over.",
    evidence: "25 days of paid time off",
  },
  {
    kind: "multi",
    doc: "security",
    question: "How fast must critical patches and normal updates be installed?",
    expected:
      "Critical security patches within 48 hours; other operating system updates within 7 days.",
    evidence: "critical security patches within 48 hours",
  },
  {
    kind: "multi",
    doc: "onboarding",
    question: "What happens at day 30, day 60 and day 90?",
    expected:
      "You review progress with your manager at each: learn (30), contribute (60), own a piece of work (90).",
    evidence: "day 30, day 60 and day 90",
  },
  {
    kind: "multi",
    doc: "benefits",
    question:
      "How much of my health insurance premium and my dependents' premium does the company pay?",
    expected: "80% for the employee and 50% for dependents.",
    evidence: "80% of the health insurance premium",
  },

  // --- cross-document: the answer is in one document, the question mixes topics (3)
  {
    kind: "cross",
    doc: "benefits",
    question:
      "Which perk covers counselling, and how many sessions are included?",
    expected:
      "The employee assistance program: 6 free counselling sessions per issue.",
    evidence: "6 counselling sessions per issue",
  },
  {
    kind: "cross",
    doc: "security",
    question: "What must I do within 24 hours when a colleague leaves?",
    expected:
      "Their access must be removed within 24 hours of their last working day.",
    evidence: "within 24 hours of their last working day",
  },
  {
    kind: "cross",
    doc: "onboarding",
    question:
      "When do I get paid, and by when must I send changes to my details?",
    expected: "On the last working day of the month; changes by the 20th.",
    evidence: "last working day of each month",
  },

  // --- exact terms: names, numbers and addresses a keyword search must catch (3)
  {
    kind: "keyword",
    doc: "security",
    question: "What is the security reporting email address?",
    expected: "security@northwind.example",
    evidence: "security@northwind.example",
  },
  {
    kind: "keyword",
    doc: "onboarding",
    question: "Which address is the head office at?",
    expected: "12 Harbour Street.",
    evidence: "12 Harbour Street",
  },
  {
    kind: "keyword",
    doc: "onboarding",
    question: "Which tool does Northwind use for tickets?",
    expected: "Linear.",
    evidence: "Linear for tickets",
  },

  // --- unanswerable: not in the documents, so the right answer is "I couldn't find that" (7)
  {
    kind: "unanswerable",
    question: "Who is the CEO of Northwind?",
    expected: NOT_IN_DOCUMENTS,
  },
  {
    kind: "unanswerable",
    question: "What was Northwind's revenue last year?",
    expected: NOT_IN_DOCUMENTS,
  },
  {
    kind: "unanswerable",
    question: "Can I bring my dog to the office?",
    expected: NOT_IN_DOCUMENTS,
  },
  {
    kind: "unanswerable",
    question: "Does Northwind offer a four-day work week?",
    expected: NOT_IN_DOCUMENTS,
  },
  {
    kind: "unanswerable",
    question: "What is the stock option vesting schedule?",
    expected: NOT_IN_DOCUMENTS,
  },
  {
    kind: "unanswerable",
    question: "What is the capital of France?",
    expected: NOT_IN_DOCUMENTS,
  },
  {
    kind: "unanswerable",
    question: "How do I reset my Slack password?",
    expected: NOT_IN_DOCUMENTS,
  },
];
