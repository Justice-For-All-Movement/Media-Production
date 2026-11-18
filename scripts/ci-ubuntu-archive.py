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
    visited = set()
    for path in candidates:
        path = path.resolve()
        if path in visited:
            continue
        visited.add(path)
        if not path.is_file():
            continue
        original = path.read_text(encoding='utf-8')
        # Ubuntu runner sources can point at local mirror lists instead of naming an archive directly.
        # Follow only local files confined to the apt configuration root; never fetch remote mirror lists.
        for reference in re.findall(r'mirror\+file:([^\s]+)', original):
            target = pathlib.Path(reference).resolve()
            if not pathlib.Path(reference).is_absolute() or not target.is_relative_to(root.resolve()) or not target.is_file():
                raise RuntimeError('Local mirror list must be an existing file inside the apt root')
            if target not in visited:
                candidates.append(target)
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
