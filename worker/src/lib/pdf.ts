/**
 * pdf.ts — Insurance Authorization PDF generator for Cloudflare Workers.
 *
 * Built with pdf-lib (pure JS, zero native deps, runs in edge runtime).
 * Cloudflare Workers does NOT have a native PDF API — pdf-lib is the correct approach.
 *
 * Design mirrors toledo_insurance_form_v3.py (reportlab) with additional polish:
 *   • Full-width navy header band with embedded rocket logo
 *   • Document ID + status badge info strip
 *   • Box-style data fields (not just underlines)
 *   • Colour-coded signature rows (green = signed, gray = pending)
 *   • Anchored footer with gold rule
 */

import { PDFDocument, PDFPage, PDFFont, StandardFonts, rgb, LineCapStyle } from 'pdf-lib';

// ── Brand colours ─────────────────────────────────────────────────────────────
const NAVY        = rgb(0x0B / 255, 0x22 / 255, 0x3F / 255);
const GOLD        = rgb(0xFF / 255, 0xC7 / 255, 0x2C / 255);
const GRAY        = rgb(0x55 / 255, 0x55 / 255, 0x55 / 255);
const LGRAY       = rgb(0xF1 / 255, 0xF3 / 255, 0xF5 / 255);
const MGRAY       = rgb(0xCE / 255, 0xD4 / 255, 0xDA / 255);
const WHITE       = rgb(1, 1, 1);
const NOTICE_BG   = rgb(1, 0.984, 0.941);
const SIG_OK_BG   = rgb(0.918, 0.988, 0.941);
const SIG_OK_BD   = rgb(0.549, 0.800, 0.596);
const GREEN_DARK  = rgb(0.078, 0.420, 0.180);

// Status badge colours  [background, foreground]
const STATUS_PALETTE: Record<string, [ReturnType<typeof rgb>, ReturnType<typeof rgb>]> = {
  EXECUTED:         [rgb(0.039, 0.298, 0.129), WHITE],
  PENDING_APPROVAL: [rgb(0.490, 0.298, 0.000), WHITE],
  PENDING_COACH:    [rgb(0.239, 0.271, 0.298), WHITE],
  VOIDED:           [rgb(0.502, 0.063, 0.063), WHITE],
  DENIED:           [rgb(0.502, 0.063, 0.063), WHITE],
  EXPIRED:          [rgb(0.353, 0.384, 0.420), WHITE],
};

// ── Page geometry ─────────────────────────────────────────────────────────────
const PAGE_W   = 612;    // US Letter width  (points)
const PAGE_H   = 792;    // US Letter height
const MARGIN   = 46.8;   // 0.65 inch
const USABLE   = PAGE_W - 2 * MARGIN;
const HDR_H    = 70;     // navy header band height
const FOOTER_Y = 44;     // absolute y for footer baseline

// ── Data contract ─────────────────────────────────────────────────────────────
export interface PdfFormData {
  requestId?: string;
  status?: string;
  studentName: string;
  rocketNumber: string;
  sport: string;
  term: string;              // "Fall 2026"
  premiumCost: string;       // "$1,234.00"
  fundingSource?: string;    // "operating_budget" | "foundation_account"
  coachName: string;
  coachEmail: string;
  submissionDeadline?: string;
  signatures: {
    role: 'COACH' | 'SPORT_ADMIN' | 'CFO';
    name: string;
    date: string;
  }[];
}

// ── Low-level drawing helpers ─────────────────────────────────────────────────

function ln(page: PDFPage, x: number, y: number, w: number, thickness: number, color: ReturnType<typeof rgb>) {
  page.drawLine({ start: { x, y }, end: { x: x + w, y }, thickness, color, lineCap: LineCapStyle.Butt });
}

function box(
  page: PDFPage, x: number, y: number, w: number, h: number,
  fill?: ReturnType<typeof rgb>,
  border?: ReturnType<typeof rgb>,
  bw = 0.75,
) {
  page.drawRectangle({ x, y, width: w, height: h, color: fill, borderColor: border, borderWidth: border ? bw : 0 });
}

function drawText(
  page: PDFPage, text: string, x: number, y: number,
  font: PDFFont, size: number, color: ReturnType<typeof rgb>,
) {
  if (!text) return;
  page.drawText(text, { x, y, size, font, color });
}

function fitText(text: string, font: PDFFont, size: number, maxW: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxW) return text;
  let s = text;
  while (s.length && font.widthOfTextAtSize(s + '...', size) > maxW) s = s.slice(0, -1);
  return s + '...';
}

function wrapText(text: string, font: PDFFont, size: number, maxW: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const word of text.split(' ')) {
    const candidate = cur ? `${cur} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) > maxW && cur) {
      lines.push(cur);
      cur = word;
    } else {
      cur = candidate;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

// ── Component: navy section title bar ────────────────────────────────────────
function sectionBar(page: PDFPage, text: string, y: number, bold: PDFFont): number {
  const h = 18;
  box(page, MARGIN, y - h, USABLE, h, NAVY);
  box(page, MARGIN, y - h, 5,      h, GOLD);
  drawText(page, text, MARGIN + 12, y - h + 5, bold, 7.5, WHITE);
  return y - h;
}

// ── Component: labeled box field ─────────────────────────────────────────────
function fieldBox(
  page: PDFPage, label: string, value: string,
  x: number, y: number, w: number,
  reg: PDFFont, bold: PDFFont,
): number {
  const bH = 18;
  drawText(page, label.toUpperCase(), x, y - 8, reg, 5.8, GRAY);
  box(page, x, y - 8 - bH, w - 6, bH, LGRAY, MGRAY, 0.6);
  if (value) {
    drawText(page, fitText(value, bold, 8.5, w - 16), x + 5, y - 8 - bH + 5, bold, 8.5, NAVY);
  }
  return y - 8 - bH;
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function buildInsuranceFormPdf(
  data: PdfFormData,
  logoPngBytes?: Uint8Array,
): Promise<Uint8Array> {

  const doc = await PDFDocument.create();
  doc.setTitle('UT Athletics \u2013 Insurance Authorization Form');
  doc.setAuthor('University of Toledo Athletics');
  doc.setSubject(`${data.studentName} \u00B7 ${data.term}`);
  doc.setCreationDate(new Date());

  const page = doc.addPage([PAGE_W, PAGE_H]);
  const hv  = await doc.embedFont(StandardFonts.Helvetica);
  const hvb = await doc.embedFont(StandardFonts.HelveticaBold);

  let y = PAGE_H;

  // ── FULL-WIDTH NAVY HEADER BAND ──────────────────────────────────────────
  box(page, 0, PAGE_H - HDR_H, PAGE_W, HDR_H, NAVY);   // full-width navy (bleeds to edges)
  box(page, 0, PAGE_H - HDR_H, PAGE_W, 3,     GOLD);   // 3pt gold base strip

  // Rocket logo — use logo-dark.png (white version) so it shows on navy
  if (logoPngBytes) {
    try {
      const img  = await doc.embedPng(logoPngBytes);
      const lw   = 90, lh = 53;
      const logoX = MARGIN;
      const logoY = PAGE_H - HDR_H + (HDR_H - lh) / 2;
      page.drawImage(img, { x: logoX, y: logoY, width: lw, height: lh });
    } catch { /* skip if bytes are corrupt */ }
  }

  // Title block (centre of header)
  const titleX    = MARGIN + 100;
  const hdrLtGray = rgb(0.70, 0.80, 0.93);
  const hdrLtBlue = rgb(0.75, 0.83, 0.93);
  drawText(page, 'DEPARTMENT OF INTERCOLLEGIATE ATHLETICS',
    titleX, PAGE_H - 17, hv, 6.8, hdrLtGray);
  drawText(page, 'Insurance Authorization Form',
    titleX, PAGE_H - 34, hvb, 17, WHITE);
  drawText(page, 'University of Toledo  \u00B7  Health & Insurance Services',
    titleX, PAGE_H - 47, hv, 7.5, hdrLtBlue);

  // Address block (right side of header)
  const addrX   = PAGE_W - MARGIN - 110;
  const addrClr = rgb(0.68, 0.77, 0.88);
  ['University of Toledo', '2801 W. Bancroft St.', 'Toledo, OH  43606', 'utoledo.edu/athletics']
    .forEach((line, i) => drawText(page, line, addrX, PAGE_H - 17 - i * 10, hv, 6.5, addrClr));

  y = PAGE_H - HDR_H - 3;

  // ── DOCUMENT INFO STRIP ──────────────────────────────────────────────────
  const stripH = 20;
  box(page, MARGIN, y - stripH, USABLE, stripH, LGRAY);
  ln(page, MARGIN, y - stripH, USABLE, 0.5, MGRAY);

  const genDate = new Date().toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
  if (data.requestId) {
    drawText(page, `ID: ${data.requestId.slice(0, 8).toUpperCase()}`,
      MARGIN + 6, y - stripH + 6, hv, 6.5, GRAY);
  }
  drawText(page, `Generated: ${genDate}`,
    MARGIN + (data.requestId ? 150 : 6), y - stripH + 6, hv, 6.5, GRAY);

  // Status badge (right side of strip)
  if (data.status) {
    const [bgC, fgC] = STATUS_PALETTE[data.status] ?? STATUS_PALETTE['PENDING_COACH'];
    const label  = data.status.replace(/_/g, ' ');
    const badgeW = hvb.widthOfTextAtSize(label, 6.5) + 16;
    const badgeX = PAGE_W - MARGIN - badgeW - 4;
    const badgeY = y - stripH + 3;
    box(page, badgeX, badgeY, badgeW, 14, bgC);
    drawText(page, label, badgeX + 8, badgeY + 4, hvb, 6.5, fgC);
  }

  y -= stripH + 10;

  // ── NOTICE BOX ───────────────────────────────────────────────────────────
  const NOTICE = 'IMPORTANT:  This form must be completed in full and signed before any '
    + 'athletic-related medical treatment may be authorized. '
    + 'Incomplete forms will be returned without processing.';
  const nLines = wrapText(NOTICE, hv, 7.5, USABLE - 28);
  const nH     = nLines.length * 11 + 14;

  box(page, MARGIN, y - nH, USABLE, nH, NOTICE_BG, GOLD, 0.75);
  box(page, MARGIN, y - nH, 4, nH, GOLD);   // gold left accent

  let ny = y - 10;
  nLines.forEach((line, i) => {
    if (i === 0) {
      const prefix = 'IMPORTANT:  ';
      const pw     = hvb.widthOfTextAtSize(prefix, 7.5);
      drawText(page, prefix, MARGIN + 11, ny, hvb, 7.5, NAVY);
      drawText(page, line.replace(/^IMPORTANT:\s+/, ''), MARGIN + 11 + pw, ny, hv, 7.5, NAVY);
    } else {
      drawText(page, line, MARGIN + 11, ny, hv, 7.5, NAVY);
    }
    ny -= 11;
  });

  y -= nH + 12;

  // ── SECTION 1 — STUDENT-ATHLETE INFORMATION ──────────────────────────────
  y = sectionBar(page, 'SECTION 1 \u2014 STUDENT-ATHLETE INFORMATION', y, hvb) - 8;

  const nameParts = data.studentName.trim().split(/\s+/);
  const firstName = nameParts[0] ?? '';
  const lastName  = nameParts.slice(1).join(' ') || '';

  const half  = USABLE / 2;
  const third = USABLE / 3;
  const qtr   = USABLE / 4;
  const ROW_H = 29;

  // Row 1: First Name | Last Name
  fieldBox(page, 'First Name', firstName, MARGIN,        y, half, hv, hvb);
  fieldBox(page, 'Last Name',  lastName,  MARGIN + half, y, half, hv, hvb);
  y -= ROW_H;

  // Row 2: Rocket # | Sport | Term
  fieldBox(page, 'UT Rocket Number', data.rocketNumber, MARGIN,             y, third, hv, hvb);
  fieldBox(page, 'Sport / Program',  data.sport,        MARGIN + third,     y, third, hv, hvb);
  fieldBox(page, 'Academic Term',    data.term,         MARGIN + third * 2, y, third, hv, hvb);
  y -= ROW_H;

  // Row 3: Coach | Coach Email | Funding | Premium
  const fundingLabel = data.fundingSource === 'foundation_account' ? 'Foundation Account' : 'Operating Budget';
  fieldBox(page, 'Head Coach',     data.coachName,        MARGIN,           y, qtr, hv, hvb);
  fieldBox(page, 'Coach Email',    data.coachEmail || '', MARGIN + qtr,     y, qtr, hv, hvb);
  fieldBox(page, 'Funding Source', fundingLabel,          MARGIN + qtr * 2, y, qtr, hv, hvb);
  fieldBox(page, 'Premium Cost',   data.premiumCost,      MARGIN + qtr * 3, y, qtr, hv, hvb);
  y -= ROW_H + 6;

  // ── SECTION 2 — ACKNOWLEDGMENTS ──────────────────────────────────────────
  y = sectionBar(page, 'SECTION 2 \u2014 REQUIRED ACKNOWLEDGMENTS & AUTHORIZATION', y, hvb) - 8;

  const deadline   = data.submissionDeadline ?? 'September 8, 2026';
  const fundPhrase = data.fundingSource === 'foundation_account'
    ? 'Foundation Account' : "program's operating budget";

  const acks: [string, string][] = [
    [
      'Budget Deduction Authorization',
      `By signing this form, I authorize that the total insurance premium cost will be deducted entirely from my ${fundPhrase}. I understand that the central Athletics department will not cover or subsidize this expense under any circumstances.`,
    ],
    [
      'Submission Deadline Acknowledgment',
      `All requests must be fully executed and submitted prior to the start of the semester. The deadline for this term is ${deadline}. Requests submitted after this date will be automatically rejected by the system.`,
    ],
    [
      'Finality of Submission',
      'Once this request is submitted and signature routing begins, no changes, edits, or retractions can be made. If an error is discovered, the request must be formally voided by the Chief Financial Officer and a new request initiated.',
    ],
  ];

  for (const [title, body] of acks) {
    box(page, MARGIN, y - 9, 8, 8, GOLD);    // gold bullet square
    drawText(page, title, MARGIN + 14, y - 8, hvb, 8, NAVY);
    y -= 16;
    for (const bline of wrapText(body, hv, 7.5, USABLE - 16)) {
      drawText(page, bline, MARGIN + 14, y, hv, 7.5, GRAY);
      y -= 10;
    }
    y -= 6;
  }
  y -= 4;

  // ── SECTION 3 — APPROVAL SIGNATURES ──────────────────────────────────────
  y = sectionBar(page, 'SECTION 3 \u2014 APPROVAL SIGNATURES', y, hvb) - 8;

  const sigMap: Record<string, { name: string; date: string } | undefined> = {};
  for (const sig of data.signatures) sigMap[sig.role] = { name: sig.name, date: sig.date };

  const sigRoles: { key: 'COACH' | 'SPORT_ADMIN' | 'CFO'; label: string }[] = [
    { key: 'COACH',       label: 'Head Coach' },
    { key: 'SPORT_ADMIN', label: 'Sport Administrator' },
    { key: 'CFO',         label: 'Chief Financial Officer (CFO)' },
  ];

  const cs    = USABLE * 0.42;
  const cn    = USABLE * 0.38;
  const cd    = USABLE - cs - cn;
  const SIG_H = 30;

  for (const { key, label } of sigRoles) {
    const sig    = sigMap[key];
    const signed = !!sig?.name;

    const sigCell = (
      cx: number, cw: number,
      cellLabel: string, value: string,
      isSignatureField: boolean,
    ) => {
      if (signed) {
        box(page, cx, y - SIG_H + 2, cw - 6, SIG_H - 2, SIG_OK_BG, SIG_OK_BD, 0.75);
        drawText(page, cellLabel.toUpperCase(), cx + 4, y - 8, hv, 5.8, rgb(0.18, 0.48, 0.24));
        if (isSignatureField) {
          box(page, cx + 4, y - 18, 6, 6, GREEN_DARK);    // small green filled square
          drawText(page,
            'Digitally signed by: ' + fitText(value, hv, 8, cw - 38),
            cx + 14, y - 19, hv, 8, NAVY);
        } else {
          drawText(page, fitText(value, hvb, 8.5, cw - 14), cx + 4, y - 20, hvb, 8.5, NAVY);
        }
      } else {
        box(page, cx, y - SIG_H + 2, cw - 6, SIG_H - 2, LGRAY, MGRAY, 0.6);
        drawText(page, cellLabel.toUpperCase(), cx + 4, y - 8, hv, 5.8, GRAY);
        drawText(page,
          isSignatureField ? 'Pending signature' : label,
          cx + 4, y - 20, hv, 8, rgb(0.65, 0.65, 0.65));
      }
    };

    sigCell(MARGIN,           cs, `Signature \u2014 ${label}`, sig?.name ?? '', true);
    sigCell(MARGIN + cs,      cn, 'Printed Name',               sig?.name ?? '', false);
    sigCell(MARGIN + cs + cn, cd, 'Date (MM/DD/YYYY)',          sig?.date ?? '', false);

    y -= SIG_H + 8;
  }

  // ── FOOTER ───────────────────────────────────────────────────────────────
  ln(page, MARGIN, FOOTER_Y + 12, USABLE, 0.5, MGRAY);
  ln(page, MARGIN, FOOTER_Y + 9,  USABLE, 2.5, GOLD);

  drawText(page,
    'University of Toledo Athletics  \u00B7  Health & Insurance Services  \u00B7  '
    + 'Glass Bowl, 2801 W. Bancroft St., Toledo OH 43606  \u00B7  athletics-insurance@utoledo.edu',
    MARGIN, FOOTER_Y, hv, 5.8, GRAY);

  const revText = 'Form UT-ATH-INS-001  \u00B7  Rev. 2025';
  drawText(page, revText,
    PAGE_W - MARGIN - hv.widthOfTextAtSize(revText, 5.8),
    FOOTER_Y, hv, 5.8, GRAY);

  return doc.save();
}
