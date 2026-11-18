#!/usr/bin/env python3
"""CI-only rewrite of official regional Ubuntu HTTP archives in apt source files."""
import pathlib
import re
import sys

REGIONAL = re.compile(r'\bhttp://[a-z0-9-]+\.ec2\.archive\.ubuntu\.com/ubuntu(?=[/\s]|$)')


def configure(root: pathlib.Path) -> int:
    candidates = [root / 'sources.list', *sorted((root / 'sources.list.d').glob('*.list')),
                  *sorted((root / 'sources.list.d').glob('*.sources'))]
    total = 0
    for path in candidates:
        if not path.is_file():
            continue
        original = path.read_text(encoding='utf-8')
        updated, count = REGIONAL.subn('https://archive.ubuntu.com/ubuntu', original)
        if count:
            path.write_text(updated, encoding='utf-8')
            total += count
            print(f'Updated {count} regional archive URI(s) in {path.name}')
        if REGIONAL.search(path.read_text(encoding='utf-8')):
            raise RuntimeError('Regional archive remains in an apt source file')
    return total


if __name__ == '__main__':
    if len(sys.argv) != 1:
        raise SystemExit('This CI helper accepts no deployment configuration')
    print(f'Updated {configure(pathlib.Path("/etc/apt"))} regional archive URI(s) in total')
