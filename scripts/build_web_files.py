"""Copies the report and an HTML version of the notebook into web/files, so the website can open them
directly (GitHub's file viewer fails on large PDFs and notebooks on phones).
Run from the repository root: python -I scripts/build_web_files.py
"""
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "web" / "files"
OUT.mkdir(parents=True, exist_ok=True)

shutil.copy2(REPO / "04_Report" / "CCPP_Technical_Report.pdf", OUT / "CCPP_Technical_Report.pdf")

subprocess.run([sys.executable, "-I", "-m", "jupyter", "nbconvert", "--to", "html", "--output-dir", str(OUT),
                "--output", "CCPP_Power_Prediction", str(REPO / "02_Notebook" / "CCPP_Power_Prediction.ipynb")],
               check=True)

# make the exported page readable on phones: a proper title, and wide content that scrolls in place
# (nbconvert already writes the viewport tag)
html_path = OUT / "CCPP_Power_Prediction.html"
html = html_path.read_text(encoding="utf-8")
head = """<style>
  body { overflow-x: hidden; }
  .jp-Notebook { padding: 12px !important; }
  .jp-OutputArea-output img { max-width: 100%; height: auto; }
  .jp-RenderedHTMLCommon table { display: block; overflow-x: auto; max-width: 100%; }
  .jp-InputArea-editor, .jp-OutputArea-output pre { overflow-x: auto; }
  @media (max-width: 767px) { .jp-InputPrompt, .jp-OutputPrompt { display: none !important; } }
</style>"""
html = html.replace("<title>CCPP_Power_Prediction</title>", "<title>CCPP power prediction notebook</title>\n" + head, 1)
assert head in html, "title tag not found"
html_path.write_text(html, encoding="utf-8")
print("Wrote", OUT / "CCPP_Technical_Report.pdf", "and", html_path)
