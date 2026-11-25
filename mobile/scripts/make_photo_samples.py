"""Makes 'phone photo' versions of the sample statements for the OCR tests:
clean scans, plus skewed, blurred, noisy, unevenly lit JPEGs.
Usage: python3 make_photo_samples.py <samples_dir> <out_dir>   (needs pdftoppm, Pillow, numpy)"""
import sys, os, subprocess, glob, random
import numpy as np
from PIL import Image, ImageFilter

src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
random.seed(7)
for pdf in sorted(glob.glob(os.path.join(src, '*.pdf'))):
    name = os.path.basename(pdf)[:-4]
    subprocess.run(['pdftoppm', '-r', '200', '-png', pdf, os.path.join(out, name + '__scan')], check=True)
    for png in sorted(glob.glob(os.path.join(out, name + '__scan-*.png'))):
        page = png.rsplit('-', 1)[1][:-4]
        im = Image.open(png).convert('L')
        # photo: 150 dpi equivalent, rotated, perspective-ish shear, uneven light, blur, noise, jpeg
        w, h = im.size
        ph = im.resize((int(w * 0.8), int(h * 0.8)), Image.LANCZOS)
        ph = ph.rotate(random.choice([-2.2, -1.4, 1.1, 1.8, 2.5]), resample=Image.BICUBIC, expand=True, fillcolor=255)
        a = np.asarray(ph).astype(np.float32)
        yy, xx = np.mgrid[0:a.shape[0], 0:a.shape[1]]
        light = 0.78 + 0.22 * (xx / a.shape[1]) * (1 - 0.4 * yy / a.shape[0])
        a = a * light + np.random.default_rng(1).normal(0, 9, a.shape)
        ph = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.8))
        # add a dark table-top border like a real photo
        bg = Image.new('L', (ph.width + 120, ph.height + 160), 60)
        bg.paste(ph, (55, 70))
        bg.save(os.path.join(out, f'{name}__photo-{page}.jpg'), quality=62)
        # rough: low resolution, 3.5 degrees, heavier blur, noise and compression
        r = im.resize((int(w * 0.62), int(h * 0.62)), Image.LANCZOS)
        r = r.rotate(random.choice([-3.5, 3.5]), resample=Image.BICUBIC, expand=True, fillcolor=235)
        a = np.asarray(r).astype(np.float32) * 0.85 + np.random.default_rng(2).normal(0, 14, (r.height, r.width))
        r = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.1))
        r.save(os.path.join(out, f'{name}__rough-{page}.jpg'), quality=45)
print('ok')

# scanned PDFs (image only, no text layer) and a password-protected PDF
for pdf in sorted(glob.glob(os.path.join(src, '*.pdf'))):
    name = os.path.basename(pdf)[:-4]
    pages = [Image.open(p).convert('RGB') for p in sorted(glob.glob(os.path.join(out, name + '__scan-*.png')))]
    pages[0].save(os.path.join(out, name + '__scanned.pdf'), save_all=True, append_images=pages[1:], resolution=200)
try:
    from pypdf import PdfReader, PdfWriter
    w = PdfWriter()
    for p in PdfReader(os.path.join(src, 'us_debit_credit.pdf')).pages: w.add_page(p)
    w.encrypt('otter')
    with open(os.path.join(out, 'encrypted.pdf'), 'wb') as f: w.write(f)
except ImportError:
    print('pypdf missing: no encrypted sample')
with open(os.path.join(out, 'not-a-statement.pdf'), 'wb') as f: f.write(b'this is not a pdf at all')
print('extras ok')
