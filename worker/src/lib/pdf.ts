/**
 * PDF generation for Insurance Authorization Form.
 * Ported from toledo_insurance_form_v3.py (reportlab) to pdf-lib for Cloudflare Workers.
 */

import { PDFDocument, PDFPage, PDFFont, StandardFonts, rgb, LineCapStyle } from 'pdf-lib';

// ── Brand colours ───────────────────────────────────────────────────────────
const NAVY = rgb(0x1B / 255, 0x2A / 255, 0x4A / 255);
const GOLD = rgb(0xF5 / 255, 0xA8 / 255, 0x00 / 255);
const GRAY = rgb(0x55 / 255, 0x55 / 255, 0x55 / 255);
const LGRAY = rgb(0xE8 / 255, 0xE8 / 255, 0xE8 / 255);
const WHITE = rgb(1, 1, 1);
const NOTICE_BG = rgb(0xFF / 255, 0xFB / 255, 0xF0 / 255);

// ── Page layout ─────────────────────────────────────────────────────────────
const PAGE_W = 612; // letter width in points
const PAGE_H = 792; // letter height
const MARGIN = 46.8; // 0.65 inch
const USABLE = PAGE_W - 2 * MARGIN;

export interface PdfFormData {
  studentName: string;       // "Last, First M."
  rocketNumber: string;      // "R12345678"
  sport: string;
  term: string;              // "Fall 2026"
  premiumCost: string;       // "$1,234.00"
  coachName: string;
  coachEmail: string;
  submissionDeadline?: string; // "September 8, 2026"
  signatures: {
    role: 'COACH' | 'SPORT_ADMIN' | 'CFO';
    name: string;
    date: string;            // formatted date string
  }[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function drawLine(page: PDFPage, x: number, y: number, w: number, thickness: number, color: typeof NAVY) {
  page.drawLine({
    start: { x, y },
    end: { x: x + w, y },
    thickness,
    color,
    lineCap: LineCapStyle.Butt,
  });
}

function drawRect(page: PDFPage, x: number, y: number, w: number, h: number, color: typeof NAVY) {
  page.drawRectangle({ x, y, width: w, height: h, color });
}

function drawText(page: PDFPage, text: string, x: number, y: number, font: PDFFont, size: number, color: typeof NAVY) {
  page.drawText(text, { x, y, size, font, color });
}

/** Truncate text to fit within maxWidth */
function fitText(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let t = text;
  while (t.length > 0 && font.widthOfTextAtSize(t + '…', size) > maxWidth) {
    t = t.slice(0, -1);
  }
  return t + '…';
}

// ── Main build function ─────────────────────────────────────────────────────

export async function buildInsuranceFormPdf(data: PdfFormData, logoPngBytes?: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle('UT Athletics – Insurance Authorization Form');
  doc.setAuthor('University of Toledo Athletics');

  const page = doc.addPage([PAGE_W, PAGE_H]);
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await doc.embedFont(StandardFonts.HelveticaBold);

  let y = PAGE_H - 32; // start near top (topMargin ~ 0.45 inch)

  // ── HEADER ──────────────────────────────────────────────────────────────

  // Logo (if provided)
  if (logoPngBytes) {
    try {
      const logoImg = await doc.embedPng(logoPngBytes);
      const logoW = 97; // ~1.35 inch
      const logoH = 57; // ~0.79 inch
      page.drawImage(logoImg, { x: MARGIN, y: y - logoH, width: logoW, height: logoH });
    } catch {
      // Skip logo if embedding fails
    }
  }

  // Title block (center area)
  const titleX = MARGIN + 108; // 1.5 inch from left margin
  drawText(page, 'DEPARTMENT OF INTERCOLLEGIATE ATHLETICS', titleX, y - 10, helveticaBold, 7, GRAY);
  drawText(page, 'Insurance Authorization Form', titleX, y - 30, helveticaBold, 16, NAVY);
  drawText(page, 'University of Toledo  ·  Health & Insurance Services', titleX, y - 42, helvetica, 7, GRAY);

  // Address block (right)
  const addrX = PAGE_W - MARGIN - 100;
  drawText(page, 'University of Toledo', addrX, y - 10, helvetica, 6.5, GRAY);
  drawText(page, '2801 W. Bancroft St.', addrX, y - 20, helvetica, 6.5, GRAY);
  drawText(page, 'Toledo, OH  43606', addrX, y - 30, helvetica, 6.5, GRAY);
  drawText(page, 'utoledo.edu/athletics', addrX, y - 40, helvetica, 6.5, GRAY);

  y -= 64;

  // Gold + navy rules
  drawLine(page, MARGIN, y, USABLE, 3, GOLD);
  y -= 5;
  drawLine(page, MARGIN, y, USABLE, 0.8, NAVY);
  y -= 12;

  // ── NOTICE BOX ──────────────────────────────────────────────────────────
  const noticeH = 32;
  drawRect(page, MARGIN, y - noticeH, USABLE, noticeH, NOTICE_BG);
  // Gold left border
  drawRect(page, MARGIN, y - noticeH, 4, noticeH, GOLD);
  // Gold outline
  page.drawRectangle({
    x: MARGIN, y: y - noticeH, width: USABLE, height: noticeH,
    borderColor: GOLD, borderWidth: 0.75, color: undefined,
  });

  const noticeText = 'IMPORTANT:  This form must be completed in full and signed before any athletic-related medical treatment may be authorized. Incomplete forms will be returned without processing.';
  drawText(page, 'IMPORTANT:', MARGIN + 10, y - 13, helveticaBold, 7.5, NAVY);
  const restText = noticeText.replace('IMPORTANT:', '').trim();
  // Wrap notice text
  const noticeMaxW = USABLE - 24;
  const words = restText.split(' ');
  let line1 = '';
  let line2 = '';
  let onLine1 = true;
  for (const word of words) {
    const test = onLine1 ? (line1 ? line1 + ' ' + word : word) : (line2 ? line2 + ' ' + word : word);
    if (onLine1 && helvetica.widthOfTextAtSize(test, 7.5) > noticeMaxW - 68) {
      onLine1 = false;
      line2 = word;
    } else if (onLine1) {
      line1 = test;
    } else {
      line2 = test;
    }
  }
  drawText(page, line1, MARGIN + 76, y - 13, helvetica, 7.5, NAVY);
  if (line2) drawText(page, line2, MARGIN + 10, y - 25, helvetica, 7.5, NAVY);

  y -= noticeH + 12;

  // ── SECTION 1 — STUDENT-ATHLETE INFORMATION ─────────────────────────────
  y = drawSectionTitle(page, 'SECTION 1 — STUDENT-ATHLETE INFORMATION', y, helveticaBold);
  y -= 6;

  // Parse name into last/first/MI
  const nameParts = data.studentName.split(' ');
  let lastName = '', firstName = '', mi = '';
  if (nameParts.length >= 2) {
    firstName = nameParts[0];
    lastName = nameParts.slice(1).join(' ');
  } else {
    lastName = data.studentName;
  }

  // Row 1: Last Name, First Name, MI
  const half = USABLE / 2;
  y = drawFieldRow(page, helvetica, y, [
    { label: 'Last Name', value: lastName, width: half - 10 },
    { label: 'First Name', value: firstName, width: half - 10 },
    { label: 'Middle Initial', value: mi, width: 20 },
  ]);
  y -= 6;

  // Row 2: Rocket Number, Sport
  y = drawFieldRow(page, helvetica, y, [
    { label: 'UT Student ID (Rocket Number)', value: data.rocketNumber, width: half },
    { label: 'Sport', value: data.sport, width: half },
  ]);
  y -= 6;

  // Row 3: Coach Name
  y = drawFieldRow(page, helvetica, y, [
    { label: 'Coach Name', value: data.coachName, width: half },
  ]);
  y -= 12;

  // ── SECTION 2 — ACKNOWLEDGMENTS ─────────────────────────────────────────
  y = drawSectionTitle(page, 'SECTION 2 — REQUIRED ACKNOWLEDGMENTS & AUTHORIZATION', y, helveticaBold);
  y -= 8;

  const deadline = data.submissionDeadline ?? 'September 8, 2026';
  const acknowledgments: [string, string][] = [
    [
      'Budget Deduction Authorization',
      'By signing this form and applying my digital signature, I acknowledge and authorize that the total cost of the student-athlete health insurance premium for the selected term will be deducted entirely from my program\'s operating budget. I understand that the central Athletics department will not cover or subsidize this expense under any circumstances.',
    ],
    [
      'Submission Deadline Acknowledgment',
      `All requests for health insurance enrollment must be fully executed and submitted prior to the start of the semester. The deadline for the upcoming term is ${deadline}. I acknowledge that requests submitted after this date will be automatically rejected by the system.`,
    ],
    [
      'Finality of Submission',
      'I acknowledge that once this request is submitted and the signature routing process begins, no further changes, edits, or retractions can be made to this document. If an error is discovered regarding the student-athlete name or Rocket Number, the request must be formally voided by the Chief Financial Officer and a new request must be initiated.',
    ],
  ];

  for (const [title, body] of acknowledgments) {
    y = drawAcknowledgment(page, helvetica, helveticaBold, y, title, body);
    y -= 7;
  }

  y -= 4;

  // ── SECTION 3 — SIGNATURES ──────────────────────────────────────────────
  y = drawSectionTitle(page, 'SECTION 3 — APPROVAL SIGNATURES', y, helveticaBold);
  y -= 8;

  const sigMap: Record<string, { name: string; date: string } | undefined> = {};
  for (const sig of data.signatures) {
    sigMap[sig.role] = { name: sig.name, date: sig.date };
  }

  for (const role of ['Head Coach', 'Sport Administrator', 'Chief Financial Officer (CFO)']) {
    const roleKey = role === 'Head Coach' ? 'COACH' : role === 'Sport Administrator' ? 'SPORT_ADMIN' : 'CFO';
    const sig = sigMap[roleKey];
    y = drawSignatureRow(page, helvetica, y, role, sig?.name ?? '', sig?.date ?? '');
    y -= 6;
  }

  y -= 4;

  // ── FOOTER ──────────────────────────────────────────────────────────────
  drawLine(page, MARGIN, y, USABLE, 0.8, LGRAY);
  y -= 4;
  drawLine(page, MARGIN, y, USABLE, 2.5, GOLD);
  y -= 10;

  drawText(page, 'University of Toledo Athletics  ·  Health & Insurance Services  ·  Glass Bowl, 2801 W. Bancroft St., Toledo OH 43606  ·  athletics-insurance@utoledo.edu',
    MARGIN, y, helvetica, 6, GRAY);
  drawText(page, 'Form UT-ATH-INS-001  ·  Rev. 2025',
    PAGE_W - MARGIN - helvetica.widthOfTextAtSize('Form UT-ATH-INS-001  ·  Rev. 2025', 6), y, helvetica, 6, GRAY);

  return doc.save();
}

// ── Drawing helpers ─────────────────────────────────────────────────────────

function drawSectionTitle(page: PDFPage, text: string, y: number, boldFont: PDFFont): number {
  const h = 16;
  drawRect(page, MARGIN, y - h, USABLE, h, LGRAY);
  drawLine(page, MARGIN, y - h, USABLE, 1.5, GOLD);
  drawText(page, text, MARGIN + 7, y - 11, boldFont, 7, NAVY);
  return y - h;
}

interface FieldSpec {
  label: string;
  value: string;
  width: number;
}

function drawFieldRow(page: PDFPage, font: PDFFont, y: number, fields: FieldSpec[]): number {
  let x = MARGIN;
  for (const f of fields) {
    // Label
    drawText(page, f.label, x, y - 8, font, 6.5, GRAY);
    // Value (if filled)
    if (f.value) {
      drawText(page, fitText(f.value, font, 8, f.width - 4), x, y - 20, font, 8, NAVY);
    }
    // Underline
    drawLine(page, x, y - 24, f.width - 8, 0.6, NAVY);
    x += f.width;
  }
  return y - 26;
}

function drawAcknowledgment(page: PDFPage, font: PDFFont, boldFont: PDFFont, y: number, title: string, body: string): number {
  // Gold square bullet
  drawRect(page, MARGIN, y - 10, 8, 8, GOLD);

  // Title
  drawText(page, title, MARGIN + 14, y - 9, boldFont, 8, NAVY);
  y -= 20;

  // Body text — word wrap
  const maxW = USABLE - 14;
  const lines = wrapText(body, font, 8, maxW);
  for (const line of lines) {
    drawText(page, line, MARGIN + 14, y, font, 8, NAVY);
    y -= 11;
  }

  return y;
}

function drawSignatureRow(page: PDFPage, font: PDFFont, y: number, role: string, name: string, date: string): number {
  const cs = USABLE * 0.42;
  const cn = USABLE * 0.38;
  const cd = USABLE - cs - cn;

  let x = MARGIN;

  // Signature field
  drawText(page, 'Signature — ' + role, x, y - 8, font, 6.5, GRAY);
  if (name) {
    // Show "Digitally signed" as the signature value
    drawText(page, `Digitally signed by ${fitText(name, font, 8, cs - 12)}`, x, y - 20, font, 8, NAVY);
  }
  drawLine(page, x, y - 24, cs - 8, 0.6, NAVY);
  x += cs;

  // Printed Name
  drawText(page, 'Printed Name', x, y - 8, font, 6.5, GRAY);
  if (name) drawText(page, fitText(name, font, 8, cn - 12), x, y - 20, font, 8, NAVY);
  drawLine(page, x, y - 24, cn - 8, 0.6, NAVY);
  x += cn;

  // Date
  drawText(page, 'Date (MM/DD/YYYY)', x, y - 8, font, 6.5, GRAY);
  if (date) drawText(page, date, x, y - 20, font, 8, NAVY);
  drawLine(page, x, y - 24, cd - 8, 0.6, NAVY);

  return y - 28;
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    const test = currentLine ? currentLine + ' ' + word : word;
    if (font.widthOfTextAtSize(test, size) > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = test;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}
