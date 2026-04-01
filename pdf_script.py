"""
toledo_insurance_form_v3.py
Generates toledo_insurance_auth_v3.pdf — a single-page Insurance Authorization
Form for the University of Toledo Department of Intercollegiate Athletics.

Requirements:
    pip install reportlab pillow

Usage:
    python build_form_v3.py

Output:
    toledo_insurance_auth_v3.pdf  (same directory as this script)
"""

import os
from PIL import Image as PILImage
import numpy as np
from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.lib.units import inch
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    HRFlowable, Image,
)
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_RIGHT

# ─────────────────────────────────────────────────────────────────────────────
#  CONFIGURATION  – update these paths before running
# ─────────────────────────────────────────────────────────────────────────────

# Path to the official UT logo (light-background version with transparent BG
# OR the original PNG – black pixels will be stripped automatically).
LOGO_SOURCE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "Primary_Logo_for_Light_Background.png")

# Where to write the finished PDF
OUTPUT_PDF = "toledo_insurance_auth_v3.pdf"

# ─────────────────────────────────────────────────────────────────────────────
#  BRAND COLOURS
# ─────────────────────────────────────────────────────────────────────────────

NAVY  = colors.HexColor("#1B2A4A")
GOLD  = colors.HexColor("#F5A800")
GRAY  = colors.HexColor("#555555")
LGRAY = colors.HexColor("#E8E8E8")

PAGE_W, PAGE_H = letter
MARGIN = 0.65 * inch
USABLE = PAGE_W - 2 * MARGIN

# ─────────────────────────────────────────────────────────────────────────────
#  PARAGRAPH STYLES
# ─────────────────────────────────────────────────────────────────────────────

S_LABEL = ParagraphStyle("label", fontName="Helvetica",         fontSize=6.5, textColor=GRAY,  leading=8)
S_BODY  = ParagraphStyle("body",  fontName="Helvetica",         fontSize=8,   textColor=NAVY,  leading=12)
S_BOLD  = ParagraphStyle("bold",  fontName="Helvetica-Bold",    fontSize=8,   textColor=NAVY,  leading=12)
S_ADDR  = ParagraphStyle("addr",  fontName="Helvetica",         fontSize=6.5, textColor=GRAY,  leading=10, alignment=TA_RIGHT)
S_DEPT  = ParagraphStyle("dept",  fontName="Helvetica-Bold",    fontSize=7,   textColor=GRAY,  leading=9)
S_TITLE = ParagraphStyle("ttl",   fontName="Helvetica-Bold",    fontSize=16,  textColor=NAVY,  leading=20)
S_SUB   = ParagraphStyle("sub",   fontName="Helvetica",         fontSize=7,   textColor=GRAY,  leading=9)
S_FOOT  = ParagraphStyle("foot",  fontName="Helvetica",         fontSize=6,   textColor=GRAY)
S_NOTC  = ParagraphStyle("notc",  fontName="Helvetica",         fontSize=7.5, textColor=NAVY,  leading=11)


# ─────────────────────────────────────────────────────────────────────────────
#  HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def gap(h: float = 5) -> Spacer:
    return Spacer(1, h)


def strip_black_background(src_path: str, dst_path: str) -> str:
    """Remove near-black pixels from logo PNG so it renders cleanly on white."""
    img  = PILImage.open(src_path).convert("RGBA")
    data = np.array(img)
    r, g, b = data[:, :, 0], data[:, :, 1], data[:, :, 2]
    mask = (r < 30) & (g < 30) & (b < 30)
    data[mask, 3] = 0
    PILImage.fromarray(data).save(dst_path)
    return dst_path


def fields(specs: list, col_widths: list = None) -> Table:
    """
    Build a row of labelled underline fields.

    specs      : list of label strings, one per column
    col_widths : optional list of widths in points (must match len(specs))
    """
    n = len(specs)
    if col_widths is None:
        w = USABLE / n
        col_widths = [w] * n

    cells = []
    for i, label in enumerate(specs):
        right_pad = 8 if i < n - 1 else 0
        w = col_widths[i] - right_pad
        cell = Table(
            [[Paragraph(label, S_LABEL)],
             [Paragraph("&nbsp;", ParagraphStyle("sp", fontSize=3, leading=5))]],
            colWidths=[w],
        )
        cell.setStyle(TableStyle([
            ("LINEBELOW",     (0, 1), (0, 1), 0.6, NAVY),
            ("TOPPADDING",    (0, 0), (-1, -1), 2),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ("LEFTPADDING",   (0, 0), (-1, -1), 0),
            ("RIGHTPADDING",  (0, 0), (-1, -1), 0),
        ]))
        cells.append(cell)

    t = Table([cells], colWidths=col_widths)
    t.setStyle(TableStyle([
        ("LEFTPADDING",   (0, 0), (-1, -1), 0),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 8),
        ("TOPPADDING",    (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
        ("VALIGN",        (0, 0), (-1, -1), "TOP"),
    ]))
    return t


def section_title(text: str) -> Table:
    """Grey bar with gold underline used as a section header."""
    t = Table(
        [[Paragraph(text.upper(),
                    ParagraphStyle("st", fontName="Helvetica-Bold", fontSize=7,
                                   textColor=NAVY, leading=9))]],
        colWidths=[USABLE],
    )
    t.setStyle(TableStyle([
        ("BACKGROUND",    (0, 0), (-1, -1), LGRAY),
        ("LINEBELOW",     (0, 0), (-1, -1), 1.5, GOLD),
        ("TOPPADDING",    (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING",   (0, 0), (-1, -1), 7),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 7),
    ]))
    return t


def ack_row(title_text: str, body_text: str) -> Table:
    """Gold square bullet + bold title + body text acknowledgment item."""
    bullet = Table(
        [[Paragraph('<font color="#F5A800" size="9">&#x25A0;</font>',
                    ParagraphStyle("bsq", fontName="Helvetica", fontSize=9,
                                   leading=12, textColor=GOLD))]],
        colWidths=[14],
    )
    bullet.setStyle(TableStyle([
        ("TOPPADDING",    (0, 0), (-1, -1), 1),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
        ("LEFTPADDING",   (0, 0), (-1, -1), 0),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 0),
    ]))

    text = Table(
        [[Paragraph(title_text, S_BOLD)],
         [Paragraph(body_text,  S_BODY)]],
        colWidths=[USABLE - 14],
    )
    text.setStyle(TableStyle([
        ("TOPPADDING",    (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
        ("LEFTPADDING",   (0, 0), (-1, -1), 4),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 0),
    ]))

    row = Table([[bullet, text]], colWidths=[14, USABLE - 14])
    row.setStyle(TableStyle([
        ("VALIGN",        (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING",   (0, 0), (-1, -1), 0),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 0),
        ("TOPPADDING",    (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    return row


def sig_row(role: str) -> Table:
    """One signature row: Signature | Printed Name | Date."""
    cs = USABLE * 0.42
    cn = USABLE * 0.38
    cd = USABLE - cs - cn

    row = Table(
        [[fields(["Signature — " + role], [cs]),
          fields(["Printed Name"],         [cn]),
          fields(["Date (MM/DD/YYYY)"],    [cd])]],
        colWidths=[cs, cn, cd],
    )
    row.setStyle(TableStyle([
        ("LEFTPADDING",   (0, 0), (-1, -1), 0),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 0),
        ("TOPPADDING",    (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    return row


# ─────────────────────────────────────────────────────────────────────────────
#  MAIN BUILD FUNCTION
# ─────────────────────────────────────────────────────────────────────────────

def build(submission_deadline: str = "September 8, 2026"):
    # ── Prepare logo ────────────────────────────────────────────────────────
    logo_clean = "_logo_clean.png"
    strip_black_background(LOGO_SOURCE, logo_clean)

    # ── Document setup ───────────────────────────────────────────────────────
    doc = SimpleDocTemplate(
        OUTPUT_PDF,
        pagesize=letter,
        leftMargin=MARGIN, rightMargin=MARGIN,
        topMargin=0.45 * inch, bottomMargin=0.5 * inch,
        title="UT Athletics – Insurance Authorization Form",
        author="University of Toledo Athletics",
    )

    story = []
    half  = USABLE / 2
    third = USABLE / 3

    # ── HEADER ───────────────────────────────────────────────────────────────
    logo = Image(logo_clean, width=1.35 * inch, height=0.79 * inch)

    title_col = Table([
        [Paragraph("DEPARTMENT OF INTERCOLLEGIATE ATHLETICS", S_DEPT)],
        [Paragraph("Insurance Authorization Form", S_TITLE)],
        [Paragraph("University of Toledo  ·  Health &amp; Insurance Services", S_SUB)],
    ], colWidths=[USABLE - 1.5 * inch - 1.5 * inch])
    title_col.setStyle(TableStyle([
        ("LEFTPADDING",   (0, 0), (-1, -1), 0),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 0),
        ("TOPPADDING",    (0, 0), (-1, -1), 1),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
    ]))

    addr_col = Table([
        [Paragraph("University of Toledo",  S_ADDR)],
        [Paragraph("2801 W. Bancroft St.",   S_ADDR)],
        [Paragraph("Toledo, OH  43606",      S_ADDR)],
        [Paragraph("utoledo.edu/athletics",  S_ADDR)],
    ], colWidths=[1.4 * inch])
    addr_col.setStyle(TableStyle([
        ("LEFTPADDING",   (0, 0), (-1, -1), 0),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 0),
        ("TOPPADDING",    (0, 0), (-1, -1), 1),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
    ]))

    hdr = Table(
        [[logo, title_col, addr_col]],
        colWidths=[1.5 * inch,
                   USABLE - 1.5 * inch - 1.5 * inch,
                   1.5 * inch],
    )
    hdr.setStyle(TableStyle([
        ("VALIGN",        (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING",   (0, 0), (-1, -1), 0),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 0),
        ("TOPPADDING",    (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
        ("LEFTPADDING",   (1, 0), (1,  0),  10),
    ]))
    story.append(hdr)
    story.append(gap(7))

    # Gold + navy rule
    story.append(HRFlowable(width=USABLE, thickness=3,   color=GOLD, lineCap="square", spaceAfter=1.5))
    story.append(HRFlowable(width=USABLE, thickness=0.8, color=NAVY, lineCap="square", spaceAfter=9))

    # ── NOTICE BOX ───────────────────────────────────────────────────────────
    notice = Table([[Paragraph(
        "<b>IMPORTANT:</b>  This form must be completed <b>in full</b> and signed "
        "before any athletic-related medical treatment may be authorized.  "
        "Incomplete forms will be returned without processing.",
        S_NOTC,
    )]], colWidths=[USABLE])
    notice.setStyle(TableStyle([
        ("BACKGROUND",    (0, 0), (-1, -1), colors.HexColor("#FFFBF0")),
        ("BOX",           (0, 0), (-1, -1), 0.75, GOLD),
        ("LINEBEFORE",    (0, 0), (0,  -1), 4, GOLD),
        ("LEFTPADDING",   (0, 0), (-1, -1), 10),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 10),
        ("TOPPADDING",    (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(notice)
    story.append(gap(10))

    # ── SECTION 1 – STUDENT-ATHLETE INFORMATION ──────────────────────────────
    story.append(section_title("Section 1 — Student-Athlete Information"))
    story.append(gap(5))

    story.append(fields(
        ["Last Name", "First Name", "Middle Initial"],
        [half - 10, half - 10, 20],
    ))
    story.append(gap(6))
    story.append(fields(
        ["UT Student ID (Rocket Number)", "Date of Birth (MM/DD/YYYY)", "Sport"],
        [third, third, third],
    ))
    story.append(gap(6))
    story.append(fields(["Coach Name", "Sport"], [half, half]))
    story.append(gap(11))

    # ── SECTION 2 – ACKNOWLEDGMENTS & AUTHORIZATION ──────────────────────────
    story.append(section_title("Section 2 — Required Acknowledgments & Authorization"))
    story.append(gap(7))

    acknowledgments = [
        (
            "Budget Deduction Authorization",
            "By signing this form and applying my digital signature, I acknowledge and authorize "
            "that the total cost of the student-athlete health insurance premium for the selected "
            "term will be deducted entirely from my program's operating budget. I understand that "
            "the central Athletics department will not cover or subsidize this expense under any "
            "circumstances.",
        ),
        (
            "Submission Deadline Acknowledgment",
            f"All requests for health insurance enrollment must be fully executed and submitted "
            f"prior to the start of the semester. The deadline for the upcoming term is "
            f"{submission_deadline}. I acknowledge that requests submitted after this date will "
            f"be automatically rejected by the system.",
        ),
        (
            "Finality of Submission",
            "I acknowledge that once this request is submitted and the signature routing process "
            "begins, no further changes, edits, or retractions can be made to this document. "
            "If an error is discovered regarding the student-athlete name or Rocket Number, "
            "the request must be formally voided by the Chief Financial Officer and a new "
            "request must be initiated.",
        ),
    ]

    for title, body in acknowledgments:
        story.append(ack_row(title, body))
        story.append(gap(7))

    story.append(gap(4))

    # ── SECTION 3 – APPROVAL SIGNATURES ─────────────────────────────────────
    story.append(section_title("Section 3 — Approval Signatures"))
    story.append(gap(7))

    for role in ["Head Coach", "Sport Administrator", "Chief Financial Officer (CFO)"]:
        story.append(sig_row(role))
        story.append(gap(6))

    story.append(gap(4))

    # ── FOOTER ───────────────────────────────────────────────────────────────
    story.append(HRFlowable(width=USABLE, thickness=0.8, color=LGRAY, lineCap="square", spaceAfter=4))
    story.append(HRFlowable(width=USABLE, thickness=2.5, color=GOLD,  lineCap="square", spaceAfter=4))

    footer = Table([[
        Paragraph(
            "University of Toledo Athletics  ·  Health &amp; Insurance Services  ·  "
            "Glass Bowl, 2801 W. Bancroft St., Toledo OH 43606  ·  "
            "athletics-insurance@utoledo.edu",
            ParagraphStyle("fl", fontName="Helvetica", fontSize=6,
                           textColor=GRAY, alignment=TA_LEFT),
        ),
        Paragraph(
            "Form UT-ATH-INS-001  ·  Rev. 2025",
            ParagraphStyle("fr", fontName="Helvetica", fontSize=6,
                           textColor=GRAY, alignment=TA_RIGHT),
        ),
    ]], colWidths=[USABLE * 0.72, USABLE * 0.28])
    footer.setStyle(TableStyle([
        ("LEFTPADDING",   (0, 0), (-1, -1), 0),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 0),
        ("TOPPADDING",    (0, 0), (-1, -1), 0),
        ("VALIGN",        (0, 0), (-1, -1), "TOP"),
    ]))
    story.append(footer)

    # ── Build ────────────────────────────────────────────────────────────────
    doc.build(story)

    # Clean up temp logo file
    if os.path.exists(logo_clean):
        os.remove(logo_clean)

    print(f"✓  Saved → {OUTPUT_PDF}")


if __name__ == "__main__":
    import sys
    deadline = sys.argv[1] if len(sys.argv) > 1 else "September 8, 2026"
    build(submission_deadline=deadline)