"""Deployment recovery uses the same configured database as the operator CLI."""
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent.parent

class JournalRecord:
    def __init__(self, key):
        self.key = key

    def __eq__(self, other):
        return isinstance(other, JournalRecord) and self.key == other.key

    def __lt__(self, other):
        return self.key < other.key

    def request(self, action, contents=None):
        result = subprocess.run([os.environ.get('HEDGE_NODE', 'node'), '--import', 'tsx',
            str(ROOT/'scripts/journal.ts'), action, self.key], cwd=ROOT, input=contents,
            text=True, capture_output=True, timeout=30)
        if result.returncode:
            raise RuntimeError('Deployment database recovery unavailable; no further signing is allowed.')
        return result.stdout

    def exists(self):
        return self.request('read') != 'null'

    def read_text(self):
        result = self.request('read')
        if result == 'null':
            raise FileNotFoundError(self.key)
        return result

    def write_text(self, contents):
        self.request('write', contents)

class JournalDirectory:
    def __truediv__(self, key):
        return JournalRecord(key)

    def glob(self, pattern):
        if pattern != 'loan-*.json':
            raise RuntimeError('Unsupported recovery record pattern.')
        return [JournalRecord(key) for key in json.loads(JournalRecord(pattern).request('list'))]
