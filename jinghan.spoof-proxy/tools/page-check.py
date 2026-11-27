import re, sys, subprocess, tempfile, os

html = open(os.path.join(os.path.dirname(__file__), '..', 'pages', 'config.html')).read()
blocks = re.findall(r'<script(?:\s[^>]*)?>(.*?)</script>', html, re.S)
inline = [b for b in blocks if b.strip() and 'src=' not in b[:0]]
# 最后一个内联脚本即页面逻辑
code = blocks[-1] if blocks else ''
path = os.path.join(tempfile.gettempdir(), 'spoof-page.js')
open(path, 'w').write(code)
r = subprocess.run(['node', '--check', path], capture_output=True, text=True)
print('blocks:', len(blocks), 'bytes:', len(code))
print(r.stdout.strip())
print(r.stderr.strip())
sys.exit(r.returncode)
