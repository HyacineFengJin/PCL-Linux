"""Build deterministic inert ZIP fixtures with Python's independent ZIP writer."""
import base64
import io
import json
import sys
import zipfile

request = json.load(sys.stdin)
class Unseekable(io.BytesIO):
    def seek(self, *args):
        raise OSError("fixture stream is not seekable")

output = Unseekable() if request.get('descriptor') else io.BytesIO()
with zipfile.ZipFile(output, 'w') as archive:
    for entry in request['entries']:
        info = zipfile.ZipInfo(entry['name'], (2026, 1, 1, 0, 0, 0))
        info.create_system = 3
        info.external_attr = entry.get('attributes', 0o100644 << 16)
        info.compress_type = zipfile.ZIP_DEFLATED if entry.get('deflate') else zipfile.ZIP_STORED
        info.extra = base64.b64decode(entry.get('extra', ''))
        archive.writestr(info, base64.b64decode(entry['content']))
    archive.comment = request.get('comment', '').encode('utf-8')
sys.stdout.buffer.write(output.getvalue())
