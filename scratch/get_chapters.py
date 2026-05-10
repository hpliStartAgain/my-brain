import sys
sys.path.append('scripts')
import extract_pdf_outline

def get_chapters():
    import fitz # PyMuPDF
    pdf_path = 'content/电子书/JVM Performance Engineering (Monica Beckwith) (z-library.sk, 1lib.sk, z-lib.sk).pdf'
    doc = fitz.open(pdf_path)
    toc = doc.get_toc()
    
    chapters = [item for item in toc if item[0] <= 1]
    
    import json
    print("Page Count:", doc.page_count)
    print(json.dumps(chapters, indent=2, ensure_ascii=False))

get_chapters()
