#!/usr/bin/env python3
"""Friday document engine: create / read / edit office documents.

Usage: engine.py <request.json>   ->  prints one JSON object to stdout.
Request: {"op": "create"|"read"|"edit", ...}
  create: {"format": docx|xlsx|pptx|pdf|md|html|csv|txt, "out": path, "title": str, ...format fields}
     docx/pdf/html/md/txt: "markdown": str  (headings #..###, bullets, numbered, **bold**, *italic*, `code`, tables, ---)
     xlsx: "sheets": [{"name", "rows": [[...]], "header": bool, "widths": [..]}]   (strings starting with "=" are formulas)
     pptx: "slides": [{"title", "bullets": [...], "notes", "table": [[...]], "subtitle"}]
     csv:  "rows": [[...]]
  read:   {"path": path, "max_chars": int}
  edit:   {"path": in, "out": out, "ops": [...]}   (always writes a NEW file; the original is never modified)
Inputs are data: nothing in a document is ever executed. Macros are not supported.
"""
import csv
import html
import io
import json
import os
import re
import sys

MAX_CHARS = 60_000


def fail(msg):
    print(json.dumps({"error": str(msg)[:500]}))
    sys.exit(0)


# ---------------------------------------------------------------- markdown parsing (tiny, safe)
def md_blocks(text):
    """Yield blocks: ('h', level, text) ('p', text) ('ul', [items]) ('ol', [items]) ('table', rows) ('code', text) ('hr',)."""
    lines = str(text or "").replace("\r", "").split("\n")
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.strip().startswith("```"):
            buf = []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith("```"):
                buf.append(lines[i])
                i += 1
            i += 1
            yield ("code", "\n".join(buf))
            continue
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            yield ("h", len(m.group(1)), m.group(2).strip())
            i += 1
            continue
        if re.match(r"^\s*(-{3,}|\*{3,})\s*$", line):
            yield ("hr",)
            i += 1
            continue
        if "|" in line and i + 1 < len(lines) and re.match(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$", lines[i + 1]):
            cells = lambda l: [c.strip() for c in l.strip().strip("|").split("|")]
            rows = [cells(line)]
            i += 2
            while i < len(lines) and "|" in lines[i] and lines[i].strip():
                rows.append(cells(lines[i]))
                i += 1
            yield ("table", rows)
            continue
        if re.match(r"^\s*[-*•]\s+", line):
            items = []
            while i < len(lines) and re.match(r"^\s*[-*•]\s+", lines[i]):
                items.append(re.sub(r"^\s*[-*•]\s+", "", lines[i]))
                i += 1
            yield ("ul", items)
            continue
        if re.match(r"^\s*\d+[.)]\s+", line):
            items = []
            while i < len(lines) and re.match(r"^\s*\d+[.)]\s+", lines[i]):
                items.append(re.sub(r"^\s*\d+[.)]\s+", "", lines[i]))
                i += 1
            yield ("ol", items)
            continue
        if not line.strip():
            i += 1
            continue
        buf = []
        while i < len(lines) and lines[i].strip() and not re.match(r"^(#{1,6}\s|\s*[-*•]\s+|\s*\d+[.)]\s+|```)", lines[i]):
            buf.append(lines[i].strip())
            i += 1
        yield ("p", " ".join(buf))


INLINE_RE = re.compile(r"(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)")


def inline_runs(text):
    """Split into (text, bold, italic, code) runs."""
    out = []
    for part in INLINE_RE.split(str(text)):
        if not part:
            continue
        if part.startswith("**") and part.endswith("**"):
            out.append((part[2:-2], True, False, False))
        elif part.startswith("`") and part.endswith("`"):
            out.append((part[1:-1], False, False, True))
        elif part.startswith("*") and part.endswith("*") and len(part) > 2:
            out.append((part[1:-1], False, True, False))
        else:
            out.append((part, False, False, False))
    return out


def plain(text):
    return "".join(r[0] for r in inline_runs(text))


# ---------------------------------------------------------------- DOCX
def docx_add_markdown(doc, markdown):
    from docx.shared import Pt
    for b in md_blocks(markdown):
        kind = b[0]
        if kind == "h":
            doc.add_heading(plain(b[2]), level=min(b[1], 4))
        elif kind in ("p",):
            p = doc.add_paragraph()
            for t, bo, it, co in inline_runs(b[1]):
                r = p.add_run(t)
                r.bold, r.italic = bo, it
                if co:
                    r.font.name = "Consolas"
        elif kind in ("ul", "ol"):
            for item in b[1]:
                p = doc.add_paragraph(style="List Bullet" if kind == "ul" else "List Number")
                for t, bo, it, co in inline_runs(item):
                    r = p.add_run(t)
                    r.bold, r.italic = bo, it
        elif kind == "table":
            rows = b[1]
            ncol = max(len(r) for r in rows)
            t = doc.add_table(rows=0, cols=ncol)
            t.style = "Table Grid"
            for ri, row in enumerate(rows):
                cells = t.add_row().cells
                for ci in range(ncol):
                    cells[ci].text = plain(row[ci]) if ci < len(row) else ""
                    if ri == 0:
                        for run in cells[ci].paragraphs[0].runs:
                            run.bold = True
        elif kind == "code":
            p = doc.add_paragraph()
            r = p.add_run(b[1])
            r.font.name = "Consolas"
            r.font.size = Pt(9)
        elif kind == "hr":
            doc.add_paragraph("―" * 30)


def docx_create(req):
    from docx import Document
    doc = Document()
    if req.get("title"):
        doc.add_heading(req["title"], level=0)
    docx_add_markdown(doc, req.get("markdown", ""))
    doc.save(req["out"])


def docx_read(path, limit):
    from docx import Document
    doc = Document(path)
    out = []
    for i, p in enumerate(doc.paragraphs):
        if p.text.strip():
            out.append(f"[p{i}]{'(' + p.style.name + ')' if p.style is not None and p.style.name != 'Normal' else ''} {p.text}")
    for ti, t in enumerate(doc.tables):
        out.append(f"[table{ti}]")
        for r in t.rows:
            out.append(" | ".join(c.text.strip() for c in r.cells))
    return {"format": "docx", "paragraphs": len(doc.paragraphs), "tables": len(doc.tables), "text": "\n".join(out)[:limit]}


def _replace_in_paragraph(p, find, repl):
    if find not in p.text:
        return 0
    # Try run-local replacement first (keeps formatting); fall back to rewriting the paragraph text.
    n = 0
    for r in p.runs:
        if find in r.text:
            n += r.text.count(find)
            r.text = r.text.replace(find, repl)
    if n:
        return n
    n = p.text.count(find)
    text = p.text.replace(find, repl)
    for r in p.runs[1:]:
        r.text = ""
    if p.runs:
        p.runs[0].text = text
    else:
        p.add_run(text)
    return n


def docx_edit(req):
    from docx import Document
    import copy
    doc = Document(req["path"])
    done = []
    for op in req.get("ops", []):
        k = op.get("op")
        paras = doc.paragraphs
        if k == "replace_text":
            n = 0
            for p in paras:
                n += _replace_in_paragraph(p, op["find"], op.get("replace", ""))
            for t in doc.tables:
                for row in t.rows:
                    for c in row.cells:
                        for p in c.paragraphs:
                            n += _replace_in_paragraph(p, op["find"], op.get("replace", ""))
            done.append(f"replaced {n}x")
        elif k == "set_paragraph":
            p = paras[int(op["index"])]
            for r in p.runs[1:]:
                r.text = ""
            if p.runs:
                p.runs[0].text = op.get("text", "")
            else:
                p.add_run(op.get("text", ""))
            done.append(f"p{op['index']} set")
        elif k == "delete_paragraph":
            p = paras[int(op["index"])]
            p._element.getparent().remove(p._element)
            done.append(f"p{op['index']} deleted")
        elif k == "append_markdown":
            docx_add_markdown(doc, op.get("markdown", ""))
            done.append("appended")
        elif k == "insert_after":
            # build in a scratch document, then move the new elements after paragraph `index`
            from docx import Document as D
            tmp = D()
            docx_add_markdown(tmp, op.get("markdown", ""))
            anchor = paras[int(op["index"])]._element
            for el in list(tmp.element.body)[::-1]:
                if el.tag.endswith("sectPr"):
                    continue
                anchor.addnext(copy.deepcopy(el))
            done.append(f"inserted after p{op['index']}")
        else:
            fail(f"unknown docx op {k}")
    doc.save(req["out"])
    return done


# ---------------------------------------------------------------- XLSX
def _cell_value(v):
    if isinstance(v, str):
        s = v.strip()
        if re.fullmatch(r"-?\d+(\.\d+)?", s) and not (len(s) > 1 and s.startswith("0") and not s.startswith("0.")):
            return float(s) if "." in s else int(s)
    return v


def xlsx_write_sheet(ws, sheet):
    from openpyxl.styles import Font, PatternFill
    from openpyxl.utils import get_column_letter
    rows = sheet.get("rows", [])
    for r in rows:
        ws.append([_cell_value(v) for v in r])
    if sheet.get("header", True) and rows:
        for c in ws[1]:
            c.font = Font(bold=True)
            c.fill = PatternFill("solid", fgColor="E8EEF7")
        ws.freeze_panes = "A2"
    widths = sheet.get("widths")
    ncol = max((len(r) for r in rows), default=0)
    for ci in range(ncol):
        w = widths[ci] if widths and ci < len(widths) else min(60, max(8, max((len(str(r[ci])) for r in rows if ci < len(r)), default=8) + 2))
        ws.column_dimensions[get_column_letter(ci + 1)].width = w


def xlsx_create(req):
    from openpyxl import Workbook
    wb = Workbook()
    sheets = req.get("sheets") or [{"name": "Sheet1", "rows": req.get("rows", [])}]
    for i, sh in enumerate(sheets):
        ws = wb.active if i == 0 else wb.create_sheet()
        ws.title = str(sh.get("name") or f"Sheet{i + 1}")[:31]
        xlsx_write_sheet(ws, sh)
    wb.save(req["out"])


def xlsx_read(path, limit):
    from openpyxl import load_workbook
    wb = load_workbook(path, data_only=False, read_only=True)
    out = []
    for ws in wb.worksheets:
        out.append(f"## sheet '{ws.title}' (rows: {ws.max_row}, cols: {ws.max_column})")
        for ri, row in enumerate(ws.iter_rows(values_only=True), start=1):
            if ri > 200:
                out.append("… more rows")
                break
            if any(v is not None for v in row):
                out.append(f"{ri}: " + " | ".join("" if v is None else str(v) for v in row))
    return {"format": "xlsx", "sheets": [ws.title for ws in wb.worksheets], "text": "\n".join(out)[:limit]}


def xlsx_edit(req):
    from openpyxl import load_workbook
    wb = load_workbook(req["path"])
    done = []
    for op in req.get("ops", []):
        k = op.get("op")
        ws = wb[op["sheet"]] if op.get("sheet") and op["sheet"] in wb.sheetnames else wb.active
        if k == "set_cells":
            for ref, v in (op.get("cells") or {}).items():
                ws[ref] = _cell_value(v)
            done.append(f"{len(op.get('cells') or {})} cells set")
        elif k == "append_rows":
            for r in op.get("rows", []):
                ws.append([_cell_value(v) for v in r])
            done.append(f"{len(op.get('rows', []))} rows appended")
        elif k == "delete_rows":
            ws.delete_rows(int(op["start"]), int(op.get("count", 1)))
            done.append("rows deleted")
        elif k == "add_sheet":
            nws = wb.create_sheet(str(op.get("name", "Sheet"))[:31])
            xlsx_write_sheet(nws, op)
            done.append(f"sheet {nws.title} added")
        elif k == "rename_sheet":
            ws.title = str(op["name"])[:31]
            done.append("renamed")
        elif k == "delete_sheet":
            del wb[op["sheet"]]
            done.append("sheet deleted")
        else:
            fail(f"unknown xlsx op {k}")
    wb.save(req["out"])
    return done


# ---------------------------------------------------------------- PPTX
def pptx_fill(prs, slide_spec):
    from pptx.util import Inches, Pt
    has_body = bool(slide_spec.get("bullets"))
    layout = prs.slide_layouts[1 if has_body else (0 if slide_spec.get("subtitle") else 5)]
    s = prs.slides.add_slide(layout)
    if s.shapes.title is not None:
        s.shapes.title.text = plain(slide_spec.get("title", ""))
    if has_body:
        body = s.placeholders[1].text_frame
        body.clear()
        for j, b in enumerate(slide_spec["bullets"]):
            level = 0
            text = b
            if isinstance(b, dict):
                text, level = b.get("text", ""), int(b.get("level", 0))
            p = body.paragraphs[0] if j == 0 else body.add_paragraph()
            p.text = plain(text)
            p.level = max(0, min(level, 4))
    elif slide_spec.get("subtitle") and len(s.placeholders) > 1:
        s.placeholders[1].text = plain(slide_spec["subtitle"])
    if slide_spec.get("table"):
        rows = slide_spec["table"]
        ncol = max(len(r) for r in rows)
        top = Inches(1.6 if not has_body else 4.2)
        shape = s.shapes.add_table(len(rows), ncol, Inches(0.5), top, Inches(9), Inches(0.4) * len(rows))
        for ri, row in enumerate(rows):
            for ci in range(ncol):
                cell = shape.table.cell(ri, ci)
                cell.text = plain(row[ci]) if ci < len(row) else ""
                for p in cell.text_frame.paragraphs:
                    for r in p.runs:
                        r.font.size = Pt(12)
    if slide_spec.get("notes"):
        s.notes_slide.notes_text_frame.text = str(slide_spec["notes"])
    return s


def pptx_create(req):
    from pptx import Presentation
    prs = Presentation()
    if req.get("title"):
        pptx_fill(prs, {"title": req["title"], "subtitle": req.get("subtitle", "")})
    for sl in req.get("slides", []):
        pptx_fill(prs, sl)
    prs.save(req["out"])


def pptx_read(path, limit):
    from pptx import Presentation
    prs = Presentation(path)
    out = []
    for i, s in enumerate(prs.slides):
        out.append(f"## slide {i}")
        for sh in s.shapes:
            if sh.has_text_frame and sh.text_frame.text.strip():
                out.append(sh.text_frame.text.strip())
            if getattr(sh, "has_table", False) and sh.has_table:
                for r in sh.table.rows:
                    out.append(" | ".join(c.text for c in r.cells))
        if s.has_notes_slide and s.notes_slide.notes_text_frame.text.strip():
            out.append(f"(notes) {s.notes_slide.notes_text_frame.text.strip()}")
    return {"format": "pptx", "slides": len(prs.slides), "text": "\n".join(out)[:limit]}


def pptx_edit(req):
    from pptx import Presentation
    prs = Presentation(req["path"])
    done = []
    for op in req.get("ops", []):
        k = op.get("op")
        if k == "replace_text":
            n = 0
            for s in prs.slides:
                for sh in s.shapes:
                    if sh.has_text_frame:
                        for p in sh.text_frame.paragraphs:
                            for r in p.runs:
                                if op["find"] in r.text:
                                    n += r.text.count(op["find"])
                                    r.text = r.text.replace(op["find"], op.get("replace", ""))
            done.append(f"replaced {n}x")
        elif k == "add_slide":
            pptx_fill(prs, op)
            done.append("slide added")
        elif k == "delete_slide":
            idx = int(op["index"])
            sld = prs.slides._sldIdLst[idx]
            prs.part.drop_rel(sld.rId)
            prs.slides._sldIdLst.remove(sld)
            done.append(f"slide {idx} deleted")
        elif k == "set_slide":
            s = prs.slides[int(op["index"])]
            if op.get("title") is not None and s.shapes.title is not None:
                s.shapes.title.text = plain(op["title"])
            if op.get("bullets") is not None:
                body = next((ph for ph in s.placeholders if ph.placeholder_format.idx == 1), None)
                if body is None:
                    fail("that slide has no body placeholder; use add_slide + delete_slide")
                tf = body.text_frame
                tf.clear()
                for j, b in enumerate(op["bullets"]):
                    p = tf.paragraphs[0] if j == 0 else tf.add_paragraph()
                    p.text = plain(b if isinstance(b, str) else b.get("text", ""))
            if op.get("notes") is not None:
                s.notes_slide.notes_text_frame.text = str(op["notes"])
            done.append(f"slide {op['index']} updated")
        elif k == "move_slide":
            lst = prs.slides._sldIdLst
            el = lst[int(op["from"])]
            lst.remove(el)
            lst.insert(int(op["to"]), el)
            done.append("slide moved")
        else:
            fail(f"unknown pptx op {k}")
    prs.save(req["out"])
    return done


# ---------------------------------------------------------------- PDF
def pdf_create(req):
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import cm
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Preformatted, ListFlowable, ListItem
    st = getSampleStyleSheet()
    code = ParagraphStyle("code", parent=st["Code"], fontSize=8, leading=10)

    def rich(t):
        s = ""
        for text, bo, it, co in inline_runs(t):
            e = html.escape(text)
            if co:
                e = f'<font face="Courier">{e}</font>'
            if bo:
                e = f"<b>{e}</b>"
            if it:
                e = f"<i>{e}</i>"
            s += e
        return s

    flow = []
    if req.get("title"):
        flow += [Paragraph(html.escape(req["title"]), st["Title"]), Spacer(1, 6)]
    for b in md_blocks(req.get("markdown", "")):
        k = b[0]
        if k == "h":
            flow.append(Paragraph(rich(b[2]), st[{1: "Heading1", 2: "Heading2"}.get(b[1], "Heading3")]))
        elif k == "p":
            flow += [Paragraph(rich(b[1]), st["BodyText"]), Spacer(1, 4)]
        elif k in ("ul", "ol"):
            flow.append(ListFlowable([ListItem(Paragraph(rich(x), st["BodyText"])) for x in b[1]], bulletType="bullet" if k == "ul" else "1"))
        elif k == "table":
            rows = b[1]
            ncol = max(len(r) for r in rows)
            data = [[Paragraph(rich(r[c]) if c < len(r) else "", st["BodyText"]) for c in range(ncol)] for r in rows]
            t = Table(data, repeatRows=1, colWidths=[(A4[0] - 4 * cm) / ncol] * ncol)
            t.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.4, colors.grey), ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E8EEF7")), ("VALIGN", (0, 0), (-1, -1), "TOP")]))
            flow += [t, Spacer(1, 6)]
        elif k == "code":
            flow.append(Preformatted(b[1], code))
        elif k == "hr":
            flow.append(Spacer(1, 10))
    SimpleDocTemplate(req["out"], pagesize=A4, leftMargin=2 * cm, rightMargin=2 * cm, topMargin=2 * cm, bottomMargin=2 * cm, title=req.get("title", "")).build(flow or [Spacer(1, 1)])


def pdf_read(path, limit):
    from pypdf import PdfReader
    r = PdfReader(path)
    out = []
    for i, p in enumerate(r.pages):
        out.append(f"## page {i + 1}\n{(p.extract_text() or '').strip()}")
        if sum(len(x) for x in out) > limit:
            break
    return {"format": "pdf", "pages": len(r.pages), "text": "\n".join(out)[:limit]}


def pdf_edit(req):
    from pypdf import PdfReader, PdfWriter
    w = PdfWriter()
    for page in PdfReader(req["path"]).pages:
        w.add_page(page)
    done = []
    for op in req.get("ops", []):
        k = op.get("op")
        if k == "keep_pages":  # 1-based list
            keep = [int(x) - 1 for x in op["pages"]]
            nw = PdfWriter()
            for i in keep:
                nw.add_page(w.pages[i])
            w = nw
            done.append(f"kept {len(keep)} pages")
        elif k == "rotate":
            for i in op.get("pages", range(1, len(w.pages) + 1)):
                w.pages[int(i) - 1].rotate(int(op.get("degrees", 90)))
            done.append("rotated")
        elif k == "append_pdf":
            for page in PdfReader(op["path"]).pages:
                w.add_page(page)
            done.append("appended pdf")
        elif k == "append_markdown":
            tmp = req["out"] + ".tmp.pdf"
            pdf_create({"out": tmp, "markdown": op.get("markdown", ""), "title": op.get("title")})
            for page in PdfReader(tmp).pages:
                w.add_page(page)
            os.remove(tmp)
            done.append("appended pages")
        elif k == "set_metadata":
            w.add_metadata({f"/{k2.capitalize()}": str(v) for k2, v in (op.get("metadata") or {}).items()})
            done.append("metadata set")
        else:
            fail(f"unknown pdf op {k} (pdf text can't be edited in place: read it, then create a new pdf)")
    with open(req["out"], "wb") as f:
        w.write(f)
    return done


# ---------------------------------------------------------------- text-ish formats
def md_to_html(markdown, title=""):
    parts = [f"<!doctype html><html><head><meta charset='utf-8'><title>{html.escape(title)}</title><style>body{{font-family:system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;line-height:1.55}}table{{border-collapse:collapse}}td,th{{border:1px solid #ccc;padding:4px 8px}}th{{background:#eef2f8}}pre{{background:#f5f5f5;padding:8px;overflow:auto}}</style></head><body>"]
    if title:
        parts.append(f"<h1>{html.escape(title)}</h1>")

    def rich(t):
        s = ""
        for text, bo, it, co in inline_runs(t):
            e = html.escape(text)
            e = f"<code>{e}</code>" if co else e
            e = f"<strong>{e}</strong>" if bo else e
            e = f"<em>{e}</em>" if it else e
            s += e
        return s
    for b in md_blocks(markdown):
        k = b[0]
        if k == "h":
            parts.append(f"<h{min(b[1] + (1 if title else 0), 6)}>{rich(b[2])}</h{min(b[1] + (1 if title else 0), 6)}>")
        elif k == "p":
            parts.append(f"<p>{rich(b[1])}</p>")
        elif k in ("ul", "ol"):
            parts.append(f"<{k}>" + "".join(f"<li>{rich(x)}</li>" for x in b[1]) + f"</{k}>")
        elif k == "table":
            rows = b[1]
            parts.append("<table><thead><tr>" + "".join(f"<th>{rich(c)}</th>" for c in rows[0]) + "</tr></thead><tbody>" + "".join("<tr>" + "".join(f"<td>{rich(c)}</td>" for c in r) + "</tr>" for r in rows[1:]) + "</tbody></table>")
        elif k == "code":
            parts.append(f"<pre>{html.escape(b[1])}</pre>")
        elif k == "hr":
            parts.append("<hr>")
    parts.append("</body></html>")
    return "\n".join(parts)


def text_create(req, fmt):
    md = req.get("markdown", "")
    title = req.get("title", "")
    if fmt == "md":
        data = (f"# {title}\n\n" if title else "") + md
    elif fmt == "txt":
        data = (f"{title}\n\n" if title else "") + md
    elif fmt == "html":
        data = md_to_html(md, title)
    elif fmt == "csv":
        buf = io.StringIO()
        csv.writer(buf).writerows(req.get("rows", []))
        data = buf.getvalue()
    with open(req["out"], "w", encoding="utf-8", newline="") as f:
        f.write(data)


def text_read(path, limit):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        t = f.read(limit + 1)
    return {"format": os.path.splitext(path)[1][1:], "text": t[:limit], "truncated": len(t) > limit}


def text_edit(req):
    with open(req["path"], "r", encoding="utf-8", errors="replace") as f:
        t = f.read()
    done = []
    for op in req.get("ops", []):
        k = op.get("op")
        if k == "replace_text":
            n = t.count(op["find"])
            t = t.replace(op["find"], op.get("replace", ""))
            done.append(f"replaced {n}x")
        elif k == "append_markdown":
            t = t.rstrip("\n") + "\n\n" + op.get("markdown", "") + "\n"
            done.append("appended")
        elif k == "set_content":
            t = op.get("content", "")
            done.append("rewritten")
        else:
            fail(f"unknown text op {k}")
    with open(req["out"], "w", encoding="utf-8") as f:
        f.write(t)
    return done


# ---------------------------------------------------------------- dispatch
def ext(p):
    return os.path.splitext(p)[1].lower().lstrip(".")


def main():
    if len(sys.argv) != 2:
        fail("usage: engine.py request.json")
    with open(sys.argv[1], encoding="utf-8") as f:
        req = json.load(f)
    op = req.get("op")
    try:
        if op == "create":
            fmt = req.get("format")
            {"docx": docx_create, "xlsx": xlsx_create, "pptx": pptx_create, "pdf": pdf_create}.get(fmt, lambda r: text_create(r, fmt) if fmt in ("md", "txt", "html", "csv") else fail(f"unsupported format {fmt}"))(req)
            print(json.dumps({"ok": True, "out": req["out"], "bytes": os.path.getsize(req["out"])}))
        elif op == "read":
            limit = int(req.get("max_chars", MAX_CHARS))
            e = ext(req["path"])
            fn = {"docx": docx_read, "xlsx": xlsx_read, "xlsm": xlsx_read, "pptx": pptx_read, "pdf": pdf_read}.get(e, text_read if e in ("md", "txt", "csv", "html", "htm", "json", "xml", "tsv", "log") else None)
            if fn is None:
                fail(f"can't read .{e} (supported: docx, xlsx, pptx, pdf, md, txt, csv, html, json)")
            print(json.dumps(fn(req["path"], limit)))
        elif op == "edit":
            e = ext(req["path"])
            fn = {"docx": docx_edit, "xlsx": xlsx_edit, "pptx": pptx_edit, "pdf": pdf_edit}.get(e, text_edit if e in ("md", "txt", "csv", "html", "htm", "json") else None)
            if fn is None:
                fail(f"can't edit .{e}")
            done = fn(req)
            print(json.dumps({"ok": True, "out": req["out"], "bytes": os.path.getsize(req["out"]), "done": done}))
        else:
            fail("op must be create|read|edit")
    except (KeyError, IndexError, ValueError, TypeError) as ex:
        fail(f"{type(ex).__name__}: {ex}")
    except Exception as ex:  # noqa: BLE001 - report, never crash silently
        fail(f"{type(ex).__name__}: {ex}")


if __name__ == "__main__":
    main()
