"""Local neutral source-layout fixtures; no apt, network or system file changes."""
import importlib.util
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('archive', pathlib.Path(__file__).with_name('ci-ubuntu-archive.py'))
archive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive)


class ArchiveLayouts(unittest.TestCase):
    def test_all_active_formats_and_preservation(self):
        legacy = 'deb [signed-by=/fixture/key.gpg] http://us-east-2.ec2.archive.ubuntu.com/ubuntu noble main universe\n'
        deb822 = 'Types: deb\nURIs: http://eu-west-1.ec2.archive.ubuntu.com/ubuntu/\nSuites: noble noble-updates\nComponents: main universe\nSigned-By: /fixture/key.gpg\n'
        untouched = 'deb https://security.ubuntu.com/ubuntu noble-security main\ndeb http://example.org/ubuntu fixture main\n'
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder); parts = root / 'sources.list.d'; parts.mkdir()
            originals = {root / 'sources.list': legacy, parts / 'regional.list': legacy,
                         parts / 'regional.sources': deb822, parts / 'other.list': untouched,
                         parts / 'disabled.list.save': legacy}
            for path, text in originals.items():
                path.write_text(text)
            self.assertEqual(archive.configure(root), 3)
            for path, text in originals.items():
                expected = text if path.name == 'disabled.list.save' else text.replace('http://us-east-2.ec2.archive.ubuntu.com/ubuntu', 'https://archive.ubuntu.com/ubuntu').replace('http://eu-west-1.ec2.archive.ubuntu.com/ubuntu', 'https://archive.ubuntu.com/ubuntu')
                self.assertEqual(path.read_text(), expected)
            self.assertEqual(archive.configure(root), 0)

    def test_absent_and_unrelated_sources_remain_untouched(self):
        with tempfile.TemporaryDirectory() as folder:
            self.assertEqual(archive.configure(pathlib.Path(folder)), 0)
        self.assertIsNone(archive.REGIONAL.search('http://us-east-2.ec2.archive.ubuntu.com/ubuntu-malicious'))
        self.assertIsNone(archive.REGIONAL.search('https://us-east-2.ec2.archive.ubuntu.com/ubuntu'))


if __name__ == '__main__':
    unittest.main()
